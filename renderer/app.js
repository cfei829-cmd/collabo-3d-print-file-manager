import { Vector3 } from './vendor/three.module.js';
import { loadModel, disposeGroup } from './geometry.js';
import { renderThumbnail, Viewer } from './scene.js';

const $ = (id) => document.getElementById(id);
const api = window.collabo;

const state = {
  files: [], dirs: [], q: '', sort: 'mtime', dir: null, fmt: null, sel: new Set(), anchor: null,
  thumbBusy: false, thumbDone: 0, thumbTotal: 0
};
const EXT_ORDER = ['3mf', 'stl', 'step', 'stp', 'obj', 'iges', 'igs'];

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtTime = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_THUMB_BYTES = 200 * 1024 * 1024;
const MAX_THUMB_FAILS = 2;

/* ----------------------------- 列表 ----------------------------- */
function visible() {
  const q = state.q.trim().toLowerCase();
  let list = state.files;
  if (state.dir) list = list.filter((f) => f.root === state.dir);
  if (state.fmt) list = list.filter((f) => f.ext === state.fmt);
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.dir.toLowerCase().includes(q));
  const by = {
    name: (a, b) => a.name.localeCompare(b.name, 'zh'),
    mtime: (a, b) => b.mtimeMs - a.mtimeMs,
    size: (a, b) => b.size - a.size
  }[state.sort];
  return [...list].sort(by);
}
const byId = (id) => state.files.find((f) => f.id === id);
const selectedFiles = () => visible().filter((f) => state.sel.has(f.id));

function cardHtml(f) {
  const img = f.thumb
    ? `<img loading="lazy" decoding="async" src="collabo://thumb/${f.id}.png?v=${f.thumb}${f.mtimeMs}" alt="">`
    : `<span class="ph">${f.ext}</span>`;
  return `<div class="card${state.sel.has(f.id) ? ' sel' : ''}" data-id="${f.id}" title="${escapeHtml(f.path)}">
    <div class="th">${img}<span class="badge">${f.ext}</span><button class="more" data-more="1" title="更多">⋮</button></div>
    <div class="meta"><div class="nm">${escapeHtml(f.name)}</div>
    <div class="sub"><span class="tag">${f.ext}</span><span>${fmtSize(f.size)}</span></div></div></div>`;
}

function renderGrid() {
  const list = visible();
  $('grid').innerHTML = list.map(cardHtml).join('');
  $('empty').hidden = state.files.length > 0;
  updateCount(list.length);
}
function updateCount(n = visible().length) {
  const sel = state.sel.size;
  $('count').textContent = `共 ${n} 个模型` + (n !== state.files.length ? `（全部 ${state.files.length}）` : '') + (sel ? ` · 已选 ${sel}` : '');
}

function renderRail() {
  const byExt = {};
  const byRoot = new Map();
  for (const f of state.files) { byExt[f.ext] = (byExt[f.ext] || 0) + 1; byRoot.set(f.root, (byRoot.get(f.root) || 0) + 1); }
  const exts = Object.keys(byExt).sort((a, b) => (EXT_ORDER.indexOf(a) + 1 || 99) - (EXT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const item = (attrs, label, count, on, extra = '') =>
    `<div class="item${on ? ' on' : ''}" ${attrs}><span class="dot"></span><span class="lb">${label}</span><span class="ct">${count}</span>${extra}</div>`;
  $('rail-body').innerHTML =
    `<div class="group">${item('data-act="all"', '全部模型', state.files.length, !state.dir && !state.fmt)}</div>` +
    `<div class="group"><div class="group-title">格式</div>` +
    (exts.length ? exts.map((e) => item(`data-act="fmt" data-ext="${e}"`, e.toUpperCase(), byExt[e], state.fmt === e)).join('') : '<div class="none">暂无素材</div>') + '</div>' +
    `<div class="group"><div class="group-title">监控目录</div>` +
    (state.dirs.length ? state.dirs.map((d) => {
      const nm = d.split(/[\\/]/).filter(Boolean).pop() || d;
      return item(`data-act="dir" data-dir="${escapeHtml(d)}" title="${escapeHtml(d)}"`, escapeHtml(nm), byRoot.get(d) || 0, state.dir === d, '<span class="x" data-act="rmdir" title="移除目录">✕</span>');
    }).join('') : '<div class="none">还没有目录，点下方「添加目录」</div>') + '</div>';
}

function renderInsp() {
  const list = selectedFiles();
  const body = $('insp-body');
  const f = list[0];
  if (!f) {
    body.innerHTML = '<div class="tip">未选择素材\n\n单击卡片选中（Ctrl 多选 / Shift 连选 / 空白处拖框），\n双击打开 3D 预览与 Support Fins。\n选中后这里显示预览、尺寸、备注等。</div>';
    return;
  }
  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const dims = f.info && f.info.size ? f.info.size.map((v) => v.toFixed(1)).join(' × ') + ' mm' : '—';
  const tri = f.info && f.info.triangles != null ? f.info.triangles.toLocaleString() : '—';
  const img = f.thumb ? `<img src="collabo://thumb/${f.id}.png?v=${f.thumb}${f.mtimeMs}" alt="">` : '<div class="tip">缩略图生成中…</div>';
  body.innerHTML =
    (list.length > 1 ? `<div class="tip" style="padding-bottom:0">已选中 ${list.length} 个素材，下面显示第一个：</div>` : '') +
    `<div class="insp-preview">${img}</div><div class="insp-name">${escapeHtml(f.name)}</div>` +
    `<div class="insp-sec">${kv('格式', f.ext.toUpperCase())}${kv('大小', fmtSize(f.size))}${kv('尺寸', dims)}${kv('面数', tri)}${kv('修改', fmtTime(f.mtimeMs))}</div>` +
    `<div class="insp-sec"><div class="insp-title">路径</div><div class="path">${escapeHtml(f.path)}</div></div>` +
    `<div class="insp-sec"><div class="insp-title">备注</div><textarea id="notes" placeholder="给这个模型写点笔记…">${escapeHtml(f.notes || '')}</textarea>
      <div class="insp-actions"><button class="primary" data-act="saveNotes" data-id="${f.id}">保存备注</button></div></div>` +
    `<div class="insp-sec"><div class="insp-title">操作</div><div class="insp-actions">
      <button class="primary" data-act="open" data-id="${f.id}">打开预览</button>
      <button data-act="fins" data-id="${f.id}">Support Fins 窗口</button>
      <button data-act="reveal" data-id="${f.id}">资源管理器</button>
      <button data-act="copy" data-id="${f.id}">复制路径</button>
      <button data-act="rename">${list.length > 1 ? '批量改名' : '重命名'}</button></div></div>`;
}

function refreshSelectionUi() {
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', state.sel.has(c.dataset.id)));
  updateCount();
  renderInsp();
}
function setSelection(ids, anchor) {
  state.sel = new Set(ids);
  if (anchor !== undefined) state.anchor = anchor;
  refreshSelectionUi();
}

async function refresh() {
  const s = await api.getState();
  state.files = s.files;
  state.dirs = s.dirs;
  if (state.dir && !state.dirs.includes(state.dir)) state.dir = null;
  const have = new Set(state.files.map((f) => f.id));
  for (const id of [...state.sel]) if (!have.has(id)) state.sel.delete(id);
  const notesFocused = document.activeElement && document.activeElement.id === 'notes';
  renderRail();
  renderGrid();
  if (!notesFocused) renderInsp();
  scheduleThumbs();
}

/* ----------------------------- 缩略图队列 ----------------------------- */
function pending() {
  return state.files.filter((f) => f.thumb !== 'real' && (f.thumbFail || 0) < MAX_THUMB_FAILS && f.size <= MAX_THUMB_BYTES);
}

function scheduleThumbs() {
  const todo = pending();
  state.thumbTotal = Math.max(state.thumbTotal, state.thumbDone + todo.length);
  updateProgress(todo.length);
  if (!state.thumbBusy && todo.length) runThumbs();
}

function updateProgress(left) {
  $('progress').textContent = left ? `生成缩略图 ${state.thumbDone}/${state.thumbTotal}` : '';
  if (!left) { state.thumbDone = 0; state.thumbTotal = 0; }
}

async function runThumbs() {
  state.thumbBusy = true;
  let sinceRefresh = 0;
  try {
    for (;;) {
      const todo = pending();
      if (!todo.length) break;
      const f = todo[0];
      try {
        const buf = await api.readFile(f.id);
        const { group, triangles, box } = await loadModel(f.ext, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const url = renderThumbnail(group, box);
        const size = box.getSize(new Vector3());
        await api.saveThumb(f.id, url);
        await api.setInfo(f.id, { triangles, size: [size.x, size.y, size.z] });
        disposeGroup(group);
        f.thumb = 'real';
        f.info = { triangles, size: [size.x, size.y, size.z] };
      } catch (e) {
        console.warn('thumbnail failed', f.name, e);
        await api.failThumb(f.id);
        f.thumbFail = (f.thumbFail || 0) + 1;
      }
      state.thumbDone++;
      updateProgress(pending().length);
      if (++sinceRefresh >= 12) { sinceRefresh = 0; await refresh(); }
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    state.thumbBusy = false;
    await refresh();
  }
}

/* ----------------------------- 预览（Support Fins 编辑视口 / 基础预览） ----------------------------- */
let viewer = null;
let current = null;
let vmode = 'fins';

function setMode(mode) {
  vmode = mode;
  const basic = mode === 'basic';
  $('viewer').classList.toggle('basic', basic);
  $('v-mode-fins').classList.toggle('on', !basic);
  $('v-mode-basic').classList.toggle('on', basic);
  $('v-fins').hidden = basic;
  $('v-canvas').hidden = !basic;
  $('v-info').textContent = '';
  if (basic) loadBasic(); else loadFins();
}

async function loadFins() {
  const f = current;
  if (!f) return;
  $('v-msg').textContent = '正在载入 Support Fins…';
  try {
    const url = await api.finsUrl(f.id);
    if (current !== f || vmode !== 'fins') return;
    const frame = $('v-fins');
    frame.onload = () => { if (current === f) $('v-msg').textContent = ''; };
    frame.src = url;
  } catch (e) {
    $('v-msg').textContent = 'Support Fins 载入失败：' + (e && e.message ? e.message : e) + '，可切换到「基础预览」。';
  }
}

async function loadBasic() {
  const f = current;
  if (!f) return;
  $('v-msg').textContent = '正在加载…';
  if (!viewer) viewer = new Viewer($('v-canvas'));
  viewer.clear();
  try {
    const buf = await api.readFile(f.id);
    const { group, triangles, box } = await loadModel(f.ext, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (current !== f || vmode !== 'basic') { disposeGroup(group); return; }
    viewer.resize();
    viewer.setModel(group, box);
    const s = box.getSize(new Vector3());
    $('v-info').textContent = `${triangles.toLocaleString()} 三角面 · ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
    $('v-msg').textContent = '';
  } catch (e) {
    $('v-msg').textContent = '无法预览：' + (e && e.message ? e.message : e);
  }
}

function openViewer(id, mode = 'fins') {
  const f = byId(id);
  if (!f) return;
  current = f;
  $('viewer').hidden = false;
  $('v-title').textContent = f.name;
  setMode(mode);
}

function closeViewer() {
  $('viewer').hidden = true;
  current = null;
  $('v-fins').src = 'about:blank';
  $('v-msg').textContent = '';
  if (viewer) { viewer.stop(); viewer.clear(); }
}

/* ----------------------------- 批量改名 ----------------------------- */
const BAD = /[\\/:*?"<>|\u0000-\u001f]/;
let rnTargets = [];
let rnPlan = [];

const baseOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; };
const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; };

function planRename() {
  const v = (id) => $(id).value;
  const n = rnTargets.length;
  const base = v('rn-base');
  const start = parseInt(v('rn-start'), 10) || 0;
  const pad = Math.min(6, Math.max(1, parseInt(v('rn-pad'), 10) || 1));
  const useSeq = $('rn-seq').checked && n > 1;
  const seen = new Map();
  rnPlan = rnTargets.map((f, i) => {
    let nb = base || baseOf(f.name);
    if (v('rn-find')) nb = nb.split(v('rn-find')).join(v('rn-repl'));
    nb = v('rn-prefix') + nb + v('rn-suffix');
    if (useSeq) nb += v('rn-sep') + String(start + i).padStart(pad, '0');
    const name = nb.trim() + extOf(f.name);
    let err = '';
    if (!nb.trim()) err = '名称为空';
    else if (BAD.test(name)) err = '含非法字符';
    else if (/[. ]$/.test(nb)) err = '不能以点或空格结尾';
    const key = name.toLowerCase();
    if (seen.has(key)) err = err || '名称重复';
    seen.set(key, true);
    return { id: f.id, old: f.name, name, err, changed: name !== f.name };
  });
  const sources = new Set(rnTargets.map((f) => f.name.toLowerCase()));
  const sameDirNames = new Set(state.files.map((f) => (f.dir + '\\' + f.name).toLowerCase()));
  rnPlan.forEach((p, i) => {
    const full = (rnTargets[i].dir + '\\' + p.name).toLowerCase();
    if (!p.err && p.changed && sameDirNames.has(full) && !rnTargets.some((t) => (t.dir + '\\' + t.name).toLowerCase() === full)) p.err = '目标已存在';
  });
  $('rn-preview').innerHTML = rnPlan.map((p) =>
    `<div><span class="o">${escapeHtml(p.old)}</span><span>→</span><span class="n${p.err ? ' bad' : ''}">${escapeHtml(p.name)}${p.err ? '（' + p.err + '）' : ''}</span></div>`).join('');
  const bad = rnPlan.find((p) => p.err);
  $('rn-err').textContent = bad ? bad.err + '：' + bad.name : '';
  $('rn-ok').disabled = !!bad || !rnPlan.some((p) => p.changed);
}

function openRename() {
  rnTargets = selectedFiles();
  if (!rnTargets.length) return;
  $('rn-count').textContent = `（${rnTargets.length} 个文件）`;
  for (const id of ['rn-base', 'rn-prefix', 'rn-suffix', 'rn-find', 'rn-repl']) $(id).value = '';
  if (rnTargets.length === 1) $('rn-base').value = baseOf(rnTargets[0].name);
  $('rename').hidden = false;
  planRename();
  $(rnTargets.length === 1 ? 'rn-base' : 'rn-base').focus();
}
for (const id of ['rn-base', 'rn-start', 'rn-pad', 'rn-sep', 'rn-prefix', 'rn-suffix', 'rn-find', 'rn-repl', 'rn-seq']) $(id).addEventListener('input', planRename);
$('rn-cancel').onclick = () => { $('rename').hidden = true; };
$('rn-ok').onclick = async () => {
  const items = rnPlan.filter((p) => p.changed).map((p) => ({ id: p.id, newName: p.name }));
  const r = await api.renameFiles(items);
  if (!r.ok) { $('rn-err').textContent = r.error; return; }
  $('rename').hidden = true;
  state.sel.clear();
  await refresh();
};

/* ----------------------------- 事件 ----------------------------- */
$('btn-add').onclick = () => api.addDirs();
$('btn-refresh').onclick = () => api.rescan();
$('search').oninput = (e) => { state.q = e.target.value; renderGrid(); renderInsp(); };
$('sort').onchange = (e) => { state.sort = e.target.value; renderGrid(); };
$('zoom').oninput = (e) => document.documentElement.style.setProperty('--cell', e.target.value + 'px');

$('rail-body').onclick = async (e) => {
  const it = e.target.closest('.item');
  if (!it) return;
  const act = it.dataset.act;
  if (e.target.dataset.act === 'rmdir') { await api.removeDir(it.dataset.dir); return; }
  if (act === 'all') { state.dir = null; state.fmt = null; }
  else if (act === 'fmt') state.fmt = state.fmt === it.dataset.ext ? null : it.dataset.ext;
  else if (act === 'dir') state.dir = state.dir === it.dataset.dir ? null : it.dataset.dir;
  renderRail();
  renderGrid();
};

const cardOf = (e) => e.target.closest('.card');
const grid = $('grid');

/* 单击 / Ctrl / Shift 选择 */
grid.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }
  const c = cardOf(e);
  if (!c) return;
  const id = c.dataset.id;
  if (e.target.dataset.more) { showMenu(e.clientX, e.clientY, id, true); return; }
  if (e.shiftKey && state.anchor) {
    const ids = visible().map((f) => f.id);
    const a = ids.indexOf(state.anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) { setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
  }
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelection(next, id);
    return;
  }
  setSelection([id], id);
});
grid.addEventListener('dblclick', (e) => { const c = cardOf(e); if (c) openViewer(c.dataset.id); });

/* 空白处拖框选择 */
let suppressClick = false;
let box = null;
grid.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || cardOf(e)) return;
  box = { x: e.clientX, y: e.clientY, base: (e.ctrlKey || e.metaKey) ? new Set(state.sel) : new Set(), moved: false };
});
addEventListener('mousemove', (e) => {
  if (!box) return;
  if (!box.moved && Math.abs(e.clientX - box.x) + Math.abs(e.clientY - box.y) < 4) return;
  box.moved = true;
  const x1 = Math.min(box.x, e.clientX), y1 = Math.min(box.y, e.clientY), x2 = Math.max(box.x, e.clientX), y2 = Math.max(box.y, e.clientY);
  const m = $('marquee');
  m.hidden = false;
  Object.assign(m.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
  const next = new Set(box.base);
  grid.querySelectorAll('.card').forEach((c) => {
    const r = c.getBoundingClientRect();
    if (r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2) next.add(c.dataset.id);
  });
  state.sel = next;
  grid.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', next.has(c.dataset.id)));
  updateCount();
});
addEventListener('mouseup', () => {
  if (!box) return;
  const moved = box.moved;
  box = null;
  $('marquee').hidden = true;
  if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); renderInsp(); }
  else setSelection([]);
});

/* 右键 / ⋮ 菜单 */
const ctx = $('ctx');
function showMenu(x, y, id, fromButton) {
  if (!state.sel.has(id)) setSelection([id], id);
  const multi = state.sel.size > 1;
  ctx.innerHTML =
    '<div data-k="preview">打开 (Support Fins)</div><div data-k="basic">基础预览</div><div data-k="fins">Support Fins 独立窗口</div><hr>' +
    '<div data-k="reveal">在文件夹中显示</div><div data-k="copy">复制路径</div><hr>' +
    `<div data-k="rename">${multi ? `批量改名（${state.sel.size} 个）…` : '重命名…'}</div>`;
  ctx.dataset.id = id;
  ctx.hidden = false;
  ctx.style.left = Math.min(x, innerWidth - 200) + 'px';
  ctx.style.top = Math.min(y, innerHeight - 200) + 'px';
}
grid.addEventListener('contextmenu', (e) => {
  const c = cardOf(e);
  if (!c) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, c.dataset.id);
});
ctx.onclick = (e) => {
  const k = e.target.dataset.k;
  const id = ctx.dataset.id;
  ctx.hidden = true;
  if (k === 'preview') openViewer(id, 'fins');
  else if (k === 'basic') openViewer(id, 'basic');
  else if (k === 'fins') api.openFins(id);
  else if (k === 'reveal') api.reveal(id);
  else if (k === 'copy') api.copyPath(id);
  else if (k === 'rename') openRename();
};
addEventListener('mousedown', (e) => { if (!ctx.contains(e.target)) ctx.hidden = true; }, true);
addEventListener('blur', () => { ctx.hidden = true; });

/* 右栏按钮 */
$('insp-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const act = b.dataset.act;
  if (act === 'open') openViewer(id);
  else if (act === 'fins') api.openFins(id);
  else if (act === 'reveal') api.reveal(id);
  else if (act === 'copy') api.copyPath(id);
  else if (act === 'rename') openRename();
  else if (act === 'saveNotes') {
    const v = $('notes').value;
    await api.setNotes(id, v);
    const f = byId(id);
    if (f) f.notes = v;
    b.textContent = '已保存 ✓';
    setTimeout(() => { b.textContent = '保存备注'; }, 1200);
  }
});
$('insp-body').addEventListener('focusout', async (e) => {
  if (e.target.id !== 'notes') return;
  const f = selectedFiles()[0];
  if (f && e.target.value !== (f.notes || '')) { await api.setNotes(f.id, e.target.value); f.notes = e.target.value; }
});

/* 预览条 */
$('v-close').onclick = closeViewer;
$('v-mode-fins').onclick = () => current && vmode !== 'fins' && setMode('fins');
$('v-mode-basic').onclick = () => current && vmode !== 'basic' && setMode('basic');
$('v-reset').onclick = () => viewer && viewer.resetView();
$('v-wire').onchange = (e) => viewer && viewer.setWireframe(e.target.checked);
$('v-reveal').onclick = () => current && api.reveal(current.id);

addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  if (e.key === 'Escape') {
    if (!$('rename').hidden) $('rename').hidden = true;
    else if (!$('viewer').hidden) closeViewer();
    else if (!ctx.hidden) ctx.hidden = true;
    else setSelection([]);
  } else if (!typing && $('viewer').hidden && $('rename').hidden) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(visible().map((f) => f.id)); }
    else if (e.key === 'F2') openRename();
    else if (e.key === 'Enter' && state.sel.size === 1) openViewer([...state.sel][0]);
  }
});
addEventListener('resize', () => viewer && !$('viewer').hidden && vmode === 'basic' && viewer.resize());

api.onChanged(() => refresh());

refresh();

// 供自测使用
window.__collabo = {
  summary: () => ({ files: state.files.length, real: state.files.filter((f) => f.thumb === 'real').length, failed: state.files.filter((f) => (f.thumbFail || 0) >= MAX_THUMB_FAILS).length, busy: state.thumbBusy, failedNames: state.files.filter((f) => (f.thumbFail || 0) >= MAX_THUMB_FAILS).map((f) => f.name) }),
  open: openViewer,
  select: (ids) => setSelection(ids, ids[0]),
  selected: () => [...state.sel],
  names: () => visible().map((f) => f.name),
  ids: () => visible().map((f) => f.id)
};
