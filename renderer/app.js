import { Vector3 } from './vendor/three.module.js';
import { loadModel, disposeGroup } from './geometry.js';
import { renderThumbnail, Viewer } from './scene.js';

const $ = (id) => document.getElementById(id);
const api = window.collabo;

const state = {
  files: [], dirs: [], q: '', sort: 'name', dir: null, fmts: new Set(), selected: null,
  thumbBusy: false, thumbDone: 0, thumbTotal: 0
};

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const MAX_THUMB_BYTES = 200 * 1024 * 1024;
const MAX_THUMB_FAILS = 2;

/* ----------------------------- 列表 ----------------------------- */
function visible() {
  const q = state.q.trim().toLowerCase();
  let list = state.files;
  if (state.dir) list = list.filter((f) => f.root === state.dir);
  if (state.fmts.size) list = list.filter((f) => state.fmts.has(f.ext));
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.dir.toLowerCase().includes(q));
  const by = {
    name: (a, b) => a.name.localeCompare(b.name, 'zh'),
    mtime: (a, b) => b.mtimeMs - a.mtimeMs,
    size: (a, b) => b.size - a.size
  }[state.sort];
  return [...list].sort(by);
}

function cardHtml(f) {
  const img = f.thumb
    ? `<img loading="lazy" decoding="async" src="collabo://thumb/${f.id}.png?v=${f.thumb}${f.mtimeMs}" alt="">`
    : `<span class="ph">${f.ext}</span>`;
  return `<div class="card${state.selected === f.id ? ' sel' : ''}" data-id="${f.id}" title="${escapeHtml(f.dir + '\\' + f.name)}">
    <div class="th">${img}<span class="badge">${f.ext}</span></div>
    <div class="meta"><div class="nm">${escapeHtml(f.name)}</div>
    <div class="sub"><span>${fmtSize(f.size)}</span><span>${f.info && f.info.size ? f.info.size.map((v) => Math.round(v)).join('×') : ''}</span></div></div></div>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderGrid() {
  const list = visible();
  $('grid').innerHTML = list.map(cardHtml).join('');
  $('empty').hidden = state.files.length > 0;
  $('count').textContent = `${list.length} / ${state.files.length} 个模型`;
}

function renderSide() {
  const counts = new Map();
  for (const f of state.files) counts.set(f.root, (counts.get(f.root) || 0) + 1);
  $('dirs').innerHTML =
    `<li data-dir="" class="${state.dir ? '' : 'on'}"><span class="nm">全部</span><span class="n">${state.files.length}</span></li>` +
    state.dirs.map((d) => {
      const nm = d.split(/[\\/]/).filter(Boolean).pop() || d;
      return `<li data-dir="${escapeHtml(d)}" class="${state.dir === d ? 'on' : ''}" title="${escapeHtml(d)}"><span class="nm">${escapeHtml(nm)}</span><span class="n">${counts.get(d) || 0}</span><span class="x" data-rm="1" title="移除目录">✕</span></li>`;
    }).join('');
  const exts = [...new Set(state.files.map((f) => f.ext))].sort();
  $('formats').innerHTML = exts.map((e) => `<span class="chip${state.fmts.has(e) ? ' on' : ''}" data-ext="${e}">${e}</span>`).join('');
}

async function refresh() {
  const s = await api.getState();
  state.files = s.files;
  state.dirs = s.dirs;
  if (state.dir && !state.dirs.includes(state.dir)) state.dir = null;
  renderSide();
  renderGrid();
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

/* ----------------------------- 预览 ----------------------------- */
let viewer = null;
let current = null;

async function openViewer(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f) return;
  current = f;
  $('viewer').hidden = false;
  $('v-title').textContent = f.name;
  $('v-info').textContent = '';
  $('v-msg').textContent = '正在加载…';
  if (!viewer) viewer = new Viewer($('v-canvas'));
  viewer.clear();
  try {
    const buf = await api.readFile(f.id);
    const { group, triangles, box } = await loadModel(f.ext, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (current !== f) { disposeGroup(group); return; }
    viewer.setModel(group, box);
    const s = box.getSize(new Vector3());
    $('v-info').textContent = `${triangles.toLocaleString()} 三角面 · ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
    $('v-msg').textContent = '';
  } catch (e) {
    $('v-msg').textContent = '无法预览：' + (e && e.message ? e.message : e);
  }
}

function closeViewer() {
  $('viewer').hidden = true;
  current = null;
  if (viewer) { viewer.stop(); viewer.clear(); }
}

/* ----------------------------- 事件 ----------------------------- */
$('btn-add').onclick = () => api.addDirs();
$('btn-refresh').onclick = () => api.rescan();
$('search').oninput = (e) => { state.q = e.target.value; renderGrid(); };
$('sort').onchange = (e) => { state.sort = e.target.value; renderGrid(); };
$('zoom').oninput = (e) => document.documentElement.style.setProperty('--cell', e.target.value + 'px');

$('dirs').onclick = async (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.dataset.rm) { await api.removeDir(li.dataset.dir); return; }
  state.dir = li.dataset.dir || null;
  renderSide();
  renderGrid();
};
$('formats').onclick = (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  state.fmts.has(c.dataset.ext) ? state.fmts.delete(c.dataset.ext) : state.fmts.add(c.dataset.ext);
  renderSide();
  renderGrid();
};

const cardId = (e) => { const c = e.target.closest('.card'); return c ? c.dataset.id : null; };
$('grid').onclick = (e) => {
  const id = cardId(e);
  if (!id) return;
  state.selected = id;
  document.querySelectorAll('.card.sel').forEach((n) => n.classList.remove('sel'));
  e.target.closest('.card').classList.add('sel');
};
$('grid').ondblclick = (e) => { const id = cardId(e); if (id) openViewer(id); };

const ctx = $('ctx');
$('grid').oncontextmenu = (e) => {
  const id = cardId(e);
  if (!id) return;
  e.preventDefault();
  state.selected = id;
  const items = [['preview', '预览'], ['fins', '用 Support Fins 打开'], ['reveal', '在文件夹中显示'], ['copy', '复制路径']];
  ctx.innerHTML = items.map(([k, t]) => `<div data-k="${k}">${t}</div>`).join('');
  ctx.dataset.id = id;
  ctx.hidden = false;
  ctx.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
  ctx.style.top = Math.min(e.clientY, innerHeight - 140) + 'px';
};
ctx.onclick = async (e) => {
  const k = e.target.dataset.k;
  const id = ctx.dataset.id;
  ctx.hidden = true;
  if (k === 'preview') openViewer(id);
  else if (k === 'fins') api.openFins(id);
  else if (k === 'reveal') api.reveal(id);
  else if (k === 'copy') api.copyPath(id);
};
addEventListener('click', (e) => { if (!ctx.contains(e.target)) ctx.hidden = true; });
addEventListener('blur', () => { ctx.hidden = true; });

$('v-close').onclick = closeViewer;
$('v-reset').onclick = () => viewer && viewer.resetView();
$('v-wire').onchange = (e) => viewer && viewer.setWireframe(e.target.checked);
$('v-fins').onclick = () => current && api.openFins(current.id);
$('v-reveal').onclick = () => current && api.reveal(current.id);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('viewer').hidden) closeViewer(); else ctx.hidden = true; }
});
addEventListener('resize', () => viewer && !$('viewer').hidden && viewer.resize());

api.onChanged(() => refresh());

refresh();

// 供自测使用
window.__collabo = {
  summary: () => ({ files: state.files.length, real: state.files.filter((f) => f.thumb === 'real').length, failed: state.files.filter((f) => (f.thumbFail || 0) >= MAX_THUMB_FAILS).length, busy: state.thumbBusy, failedNames: state.files.filter((f) => (f.thumbFail || 0) >= MAX_THUMB_FAILS).map((f) => f.name) }),
  open: openViewer
};
