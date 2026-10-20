'use strict';
// Collabo 3D打印文件管理器 - 主进程
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, shell, clipboard } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

if (process.env.COLLABO_USERDATA) app.setPath('userData', process.env.COLLABO_USERDATA);
app.setName('Collabo 3D打印文件管理器');
// 无 GPU / 远程桌面 / 沙箱环境：COLLABO_SOFTGL=1 改用软件渲染
if (process.env.COLLABO_SOFTGL) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

const { Store } = require('./lib/store');
const { scanDir } = require('./lib/scanner');
const { extractPreview } = require('./lib/threemf');
const { createApi } = require('./lib/api');
const { createFins } = require('./lib/fins');

protocol.registerSchemesAsPrivileged([
  { scheme: 'collabo', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

const RENDERER_DIR = path.join(__dirname, 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

let win = null;
let store = null;
let api = null;
let fins = null;
let thumbDir = '';
const watchers = new Map();
const rescanTimers = new Map();

const pageSend = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/* ------------------------------- 索引 ------------------------------- */
const lite = (r) => ({
  id: r.id, name: r.name, ext: r.ext, size: r.size, mtimeMs: r.mtimeMs, dir: r.dir, root: r.root,
  thumb: r.thumb, thumbFail: r.thumbFail, info: r.info
});

function fastThumbs(records) {
  for (const r of records) {
    if (r.ext !== '3mf' || r.thumb) continue;
    const png = extractPreview(r.path);
    if (!png) continue;
    try {
      fs.writeFileSync(path.join(thumbDir, r.id + '.png'), png);
      store.patch(r.id, { thumb: 'fast' });
    } catch { /* ignore */ }
  }
}

async function rescan(root) {
  const found = await scanDir(root);
  const res = store.applyScan(root, found);
  fastThumbs(store.all().filter((r) => r.root === root));
  pageSend('files:changed', res);
  return res;
}

function watch(root) {
  if (watchers.has(root)) return;
  try {
    const w = fs.watch(root, { recursive: true }, () => {
      clearTimeout(rescanTimers.get(root));
      rescanTimers.set(root, setTimeout(() => rescan(root).catch(() => {}), 1000));
    });
    w.on('error', () => {});
    watchers.set(root, w);
  } catch { /* 目录不可用 */ }
}
function unwatch(root) {
  const w = watchers.get(root);
  if (w) { try { w.close(); } catch { /* ignore */ } watchers.delete(root); }
}

async function addDir(dir) {
  if (!store.addDir(dir)) return false;
  watch(path.resolve(dir));
  await rescan(path.resolve(dir));
  return true;
}

/* ------------------------------- IPC ------------------------------- */
function registerIpc() {
  ipcMain.handle('state:get', () => ({
    dirs: store.dirs, files: store.all().map(lite), settings: store.settings, version: app.getVersion()
  }));
  ipcMain.handle('dirs:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: '添加监控目录', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return false;
    for (const d of r.filePaths) await addDir(d);
    return true;
  });
  ipcMain.handle('dirs:remove', (_e, dir) => {
    unwatch(path.resolve(dir));
    store.removeDir(dir);
    pageSend('files:changed', {});
    return true;
  });
  ipcMain.handle('files:rescan', async () => {
    for (const d of store.dirs) await rescan(d);
    return true;
  });
  ipcMain.handle('file:read', async (_e, id) => {
    const r = store.get(id);
    if (!r) throw new Error('not indexed');
    return fsp.readFile(r.path);
  });
  ipcMain.handle('thumb:save', (_e, id, dataUrl) => {
    const r = store.get(id);
    if (!r || typeof dataUrl !== 'string') return false;
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) return false;
    fs.writeFileSync(path.join(thumbDir, id + '.png'), Buffer.from(m[1], 'base64'));
    store.patch(id, { thumb: 'real' });
    return true;
  });
  ipcMain.handle('thumb:fail', (_e, id) => {
    const r = store.get(id);
    if (r) store.patch(id, { thumbFail: (r.thumbFail || 0) + 1 });
    return true;
  });
  ipcMain.handle('file:info', (_e, id, info) => {
    const r = store.get(id);
    if (!r || !info || typeof info !== 'object') return false;
    const clean = {
      triangles: Number.isFinite(info.triangles) ? info.triangles : null,
      size: Array.isArray(info.size) && info.size.length === 3 && info.size.every(Number.isFinite)
        ? info.size.map((v) => Math.round(v * 100) / 100) : null
    };
    store.patch(id, { info: clean });
    return true;
  });
  ipcMain.handle('file:reveal', (_e, id) => {
    const r = store.get(id);
    if (r) shell.showItemInFolder(r.path);
    return !!r;
  });
  ipcMain.handle('file:path', (_e, id) => {
    const r = store.get(id);
    if (r) clipboard.writeText(r.path);
    return !!r;
  });
  ipcMain.handle('fins:open', async (_e, id) => {
    const url = await fins.previewUrl(id);
    const w = new BrowserWindow({
      width: 1400, height: 900, title: 'Support Fins', autoHideMenuBar: true,
      icon: iconPath(), webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    w.setMenuBarVisibility(false);
    w.loadURL(url);
    return true;
  });
  ipcMain.handle('theme:set', (_e, mode) => setTheme(mode));
}

function setTheme(mode) {
  if (!['system', 'light', 'dark'].includes(mode)) return false;
  nativeTheme.themeSource = mode;
  store.settings.theme = mode;
  store.save();
  buildMenu();
  return true;
}

/* ------------------------------- 菜单 / 窗口 ------------------------------- */
function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(p) ? p : undefined;
}

function buildMenu() {
  const theme = store.settings.theme || 'system';
  const radio = (label, value) => ({ label, type: 'radio', checked: theme === value, click: () => { setTheme(value); pageSend('theme:changed', value); } });
  const tpl = [
    { label: '文件', submenu: [
      { label: '添加监控目录...', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { title: '添加监控目录', properties: ['openDirectory', 'multiSelections'] });
        if (!r.canceled) for (const d of r.filePaths) await addDir(d);
      } },
      { label: '刷新文件列表', accelerator: 'F5', click: () => { for (const d of store.dirs) rescan(d).catch(() => {}); } },
      { type: 'separator' },
      { role: 'quit', label: '退出' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
    ] },
    { label: '查看', submenu: [
      { label: '主题', submenu: [radio('跟随系统', 'system'), radio('浅色', 'light'), radio('深色', 'dark')] },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }])
    ] },
    { label: '帮助', submenu: [
      { label: '关于 Collabo 3D打印文件管理器', click: () => dialog.showMessageBox(win, {
        type: 'info', title: '关于', message: 'Collabo 3D打印文件管理器',
        detail: `版本: ${app.getVersion()}\n\n管理、浏览、预览 3D 打印与 CAD 文件\n支持 STL / OBJ / 3MF / STEP / IGES`, buttons: ['确定']
      }) },
      { label: '支持的格式说明', click: () => dialog.showMessageBox(win, {
        type: 'info', title: '支持的格式', message: '支持的格式',
        detail: 'STL  网格模型\nOBJ  网格模型\n3MF  3D 制造格式（含切片软件内嵌预览图）\nSTEP / STP  CAD 实体\nIGES / IGS  CAD 曲面', buttons: ['确定']
      }) },
      { type: 'separator' },
      { label: '复制本地 API / MCP 接入信息', click: () => {
        const info = api && api.connectionInfo();
        if (!info) { dialog.showMessageBox(win, { message: '本地 API 正在启动，请稍后重试。' }); return; }
        clipboard.writeText(JSON.stringify(info, null, 2));
        dialog.showMessageBox(win, { type: 'info', message: 'API / MCP 接入信息已复制。令牌仅用于本机只读服务，请勿分享。' });
      } }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, title: 'Collabo 3D打印文件管理器',
    icon: iconPath(), show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f4f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL('collabo://app/index.html');
  win.on('closed', () => { win = null; });
}

function registerProtocol() {
  protocol.handle('collabo', async (req) => {
    const url = new URL(req.url);
    try {
      let file;
      if (url.hostname === 'app') {
        file = path.resolve(RENDERER_DIR, '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('forbidden', { status: 403 });
      } else if (url.hostname === 'thumb') {
        const id = path.basename(url.pathname, '.png');
        if (!/^[0-9a-f]{16}$/.test(id)) return new Response('bad id', { status: 400 });
        file = path.join(thumbDir, id + '.png');
      } else {
        return new Response('not found', { status: 404 });
      }
      const buf = await fsp.readFile(file);
      return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ------------------------------- 启动 ------------------------------- */
const gotLock = process.env.COLLABO_USERDATA ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    const ud = app.getPath('userData');
    thumbDir = path.join(ud, 'thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    store = new Store(path.join(ud, 'library.json'));
    nativeTheme.themeSource = store.settings.theme || 'system';
    fins = createFins({ webRoot: path.join(__dirname, 'fins'), store });
    api = createApi({ store, userDataDir: ud, version: app.getVersion() });
    registerProtocol();
    registerIpc();
    buildMenu();
    api.start().catch((e) => console.error('[api] start failed:', e.message));
    for (const d of store.dirs) watch(d);
    createWindow();
    for (const d of store.dirs) rescan(d).catch(() => {});
    if (process.env.COLLABO_SELFTEST) require('./test/selftest')({ app, win: () => win, store, addDir, api });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    if (store) store.flush();
    if (api) api.stop();
    if (fins) fins.stop();
  });
}
