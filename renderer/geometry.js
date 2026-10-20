// 模型解析：STL / OBJ / 3MF / STEP / IGES -> THREE.Group
import * as THREE from './vendor/three.module.js';
import { STLLoader } from './vendor/addons/STLLoader.js';

const MODEL_COLOR = 0x8fa6c4;

export function makeMaterial(color = MODEL_COLOR) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true, side: THREE.DoubleSide });
}

function meshFrom(positions, index, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  return new THREE.Mesh(g, makeMaterial(color));
}

/* ----------------------------- STL ----------------------------- */
function parseSTL(buf) {
  const geo = new STLLoader().parse(buf);
  return [new THREE.Mesh(geo, makeMaterial())];
}

/* ----------------------------- OBJ ----------------------------- */
function parseOBJ(buf) {
  const text = new TextDecoder('utf-8').decode(buf);
  const verts = [];
  const tris = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length < 2) continue;
    if (raw.charCodeAt(0) === 118 && raw.charCodeAt(1) === 32) { // "v "
      const p = raw.trim().split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (raw.charCodeAt(0) === 102 && raw.charCodeAt(1) === 32) { // "f "
      const n = verts.length / 3;
      const ids = raw.trim().split(/\s+/).slice(1).map((t) => {
        const i = parseInt(t.split('/')[0], 10);
        return i < 0 ? n + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) tris.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  if (!tris.length) throw new Error('OBJ 中没有面');
  return [meshFrom(new Float32Array(verts), new Uint32Array(tris))];
}

/* ----------------------------- 3MF ----------------------------- */
async function unzip(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/3MF');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nlen = view.getUint16(p + 28, true);
    const xlen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const off = view.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name.toLowerCase(), { name, method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  async function read(name) {
    const e = entries.get(String(name).replace(/^\//, '').toLowerCase());
    if (!e) return null;
    const dataOff = e.off + 30 + view.getUint16(e.off + 26, true) + view.getUint16(e.off + 28, true);
    const raw = u8.subarray(dataOff, dataOff + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error('不支持的 zip 压缩方式');
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { entries, read };
}

function matrixFrom(attr) {
  const m = new THREE.Matrix4();
  if (!attr) return m;
  const v = attr.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return m;
  // 3MF 行向量约定: [x y z 1] * M
  m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  return m;
}

async function parse3MF(buf) {
  const zip = await unzip(buf);
  const dec = new TextDecoder();
  const xml = new DOMParser();
  const docs = new Map();
  async function loadDoc(path) {
    const key = path.replace(/^\//, '').toLowerCase();
    if (docs.has(key)) return docs.get(key);
    const bytes = await zip.read(key);
    if (!bytes) { docs.set(key, null); return null; }
    const doc = xml.parseFromString(dec.decode(bytes), 'application/xml');
    const objects = new Map();
    for (const o of doc.getElementsByTagName('object')) objects.set(o.getAttribute('id'), o);
    const entry = { doc, objects };
    docs.set(key, entry);
    return entry;
  }

  let mainPath = null;
  const rels = await zip.read('_rels/.rels');
  if (rels) {
    const rd = xml.parseFromString(dec.decode(rels), 'application/xml');
    for (const r of rd.getElementsByTagName('Relationship')) {
      if (/3dmodel/i.test(r.getAttribute('Type') || '')) { mainPath = r.getAttribute('Target'); break; }
    }
  }
  if (!mainPath) mainPath = '3D/3dmodel.model';
  const main = await loadDoc(mainPath);
  if (!main) throw new Error('3MF 缺少主模型文件');

  const meshes = [];
  const geoCache = new Map();

  function geometryOf(objEl, key) {
    if (geoCache.has(key)) return geoCache.get(key);
    const meshEl = objEl.getElementsByTagName('mesh')[0];
    let res = null;
    if (meshEl) {
      const vEls = meshEl.getElementsByTagName('vertex');
      const tEls = meshEl.getElementsByTagName('triangle');
      const pos = new Float32Array(vEls.length * 3);
      for (let i = 0; i < vEls.length; i++) {
        pos[i * 3] = +vEls[i].getAttribute('x');
        pos[i * 3 + 1] = +vEls[i].getAttribute('y');
        pos[i * 3 + 2] = +vEls[i].getAttribute('z');
      }
      const idx = new Uint32Array(tEls.length * 3);
      for (let i = 0; i < tEls.length; i++) {
        idx[i * 3] = +tEls[i].getAttribute('v1');
        idx[i * 3 + 1] = +tEls[i].getAttribute('v2');
        idx[i * 3 + 2] = +tEls[i].getAttribute('v3');
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      res = g;
    }
    geoCache.set(key, res);
    return res;
  }

  async function emit(objId, docEntry, docPath, matrix, depth) {
    if (depth > 8) return;
    const objEl = docEntry.objects.get(objId);
    if (!objEl) return;
    const g = geometryOf(objEl, docPath + '#' + objId);
    if (g) {
      const mesh = new THREE.Mesh(g, makeMaterial());
      mesh.applyMatrix4(matrix);
      meshes.push(mesh);
    }
    const comps = objEl.getElementsByTagName('component');
    for (const c of comps) {
      const m = matrix.clone().multiply(matrixFrom(c.getAttribute('transform')));
      const sub = c.getAttribute('p:path') || c.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path');
      let target = docEntry;
      let tPath = docPath;
      if (sub) {
        target = await loadDoc(sub);
        tPath = sub;
        if (!target) continue;
      }
      await emit(c.getAttribute('objectid'), target, tPath, m, depth + 1);
    }
  }

  const items = main.doc.getElementsByTagName('item');
  if (items.length) {
    for (const it of items) {
      await emit(it.getAttribute('objectid'), main, mainPath, matrixFrom(it.getAttribute('transform')), 0);
    }
  } else {
    for (const id of main.objects.keys()) await emit(id, main, mainPath, new THREE.Matrix4(), 0);
  }
  if (!meshes.length) throw new Error('3MF 中没有网格');
  return meshes;
}

/* ----------------------------- STEP / IGES ----------------------------- */
let occtPromise = null;
function loadOcct() {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/occt/occt-import-js.js';
      s.onload = () => {
        try { resolve(window.occtimportjs({ locateFile: (f) => './vendor/occt/' + f })); } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('无法加载 CAD 内核'));
      document.head.appendChild(s);
    });
  }
  return occtPromise;
}

async function parseCAD(buf, kind) {
  const occt = await loadOcct();
  const bytes = new Uint8Array(buf);
  const res = kind === 'iges' ? occt.ReadIgesFile(bytes, null) : occt.ReadStepFile(bytes, null);
  if (!res || !res.success || !res.meshes.length) throw new Error('CAD 解析失败');
  return res.meshes.map((m) => {
    const pos = new Float32Array(m.attributes.position.array);
    const idx = new Uint32Array(m.index.array);
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : MODEL_COLOR;
    return meshFrom(pos, idx, color);
  });
}

/* ----------------------------- 入口 ----------------------------- */
/** @returns {Promise<{group: THREE.Group, triangles: number, box: THREE.Box3}>} */
export async function loadModel(ext, arrayBuffer) {
  let meshes;
  if (ext === 'stl') meshes = parseSTL(arrayBuffer);
  else if (ext === 'obj') meshes = parseOBJ(arrayBuffer);
  else if (ext === '3mf') meshes = await parse3MF(arrayBuffer);
  else if (ext === 'step' || ext === 'iges') meshes = await parseCAD(arrayBuffer, ext);
  else throw new Error('不支持的格式: ' + ext);

  const group = new THREE.Group();
  let triangles = 0;
  for (const m of meshes) {
    group.add(m);
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  return { group, triangles: Math.round(triangles), box };
}

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
  });
}
