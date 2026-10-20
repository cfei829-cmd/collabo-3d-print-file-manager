/**
 * Support Fins - M0: load an STL, orbit it, see it sitting on the plate.
 *
 * COORDINATES: Z up, millimetres, bed plane at z = 0, plate centred on the
 * origin in XY. This is the printer's frame and the same one the Python
 * generators use (tools/support/breakaway.py) -- three.js defaults to Y up, so
 * that is overridden here rather than converting at every later step.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildTopology, connectedFaceComponents, analyze, DEFAULT_THRESHOLD } from './overhangs.js';
import { suggestOrientations, suggestStrengthPose, loadAlignment, layerVerdict } from './orient.js';
import { buildFins, FIN, PAD } from './fins.js';
import { PROP } from './prop.js';
import { findWallPatches } from './planes.js';
import { drawnWall } from './draw.js';
import { writeBinarySTL, download } from './stl.js';
import { zipStore } from './zip.js';
import { sniffModel, isStepFamily, convertStepFile, onStepStatus, FORMAT_LABEL } from './step.js';
import { writeThreeMF, readThreeMF } from './threemf.js';
import { meshIndexForFace, intersectsScreenRect, transformPositionsByMatrix, replaceMeshGroups, combineMeshPositions } from './selection.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/**
 * Build volumes are listed by DIMENSION, never by printer name. This ships to
 * strangers: a model name is a brand claim we would have to maintain, it dates
 * badly, and nobody has to recognise a name to type in three numbers. Custom
 * covers everything not listed, and the choice is remembered.
 */
const VOLUMES = [
  { x: 180, y: 180, z: 180 },
  { x: 220, y: 220, z: 250 },
  { x: 250, y: 220, z: 270 },
  { x: 256, y: 256, z: 256 },
  { x: 300, y: 300, z: 300 },
  { x: 350, y: 350, z: 350 },
];
const DEFAULT_VOLUME = { x: 250, y: 220, z: 270 };
const VOLUME_STORE = 'sf.volume';
const volLabel = (v) => `${v.x} × ${v.y} × ${v.z} mm`;

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- scene setup

const viewport = el('viewport');
const selectionRect = el('selection-rect');
const meshContextMenu = el('mesh-context-menu');
const boxSelectButton = el('box-select');
const meshSelectionStatus = el('mesh-selection-status');
const meshEditButtons = {
  translate: el('mesh-move'), rotate: el('mesh-rotate'), scale: el('mesh-scale'),
};
const wholeRotateButton = el('whole-rotate');
const topbar = el('topbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
}).observe(topbar);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);   // the file manager's light gradient shows through #viewport
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// Label the canvas: a screen reader otherwise announces a bare "canvas". The 3D
// itself isn't reachable non-visually, but the live stats panel carries the same
// state as text, so this points there.
renderer.domElement.setAttribute('role', 'img');
renderer.domElement.setAttribute(
  'aria-label', '已载入零件的交互式 3D 预览。点击或框选网格后，可移动、旋转、缩放所选网格；朝向与支撑统计显示在侧栏。');
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Lighting is a legibility requirement here, not decoration: overhangs are on the
// UNDERSIDE, so the user spends most of their time looking up at the part. A
// conventional key-from-above rig leaves exactly the faces this tool exists to
// show sitting in the dark, so the ground bounce is bright and there is a real
// light underneath the plate.
scene.add(new THREE.HemisphereLight(0xffffff, 0x8f95a1, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.6, -1, 1.4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-1, 0.7, 0.5);
scene.add(fill);
const under = new THREE.DirectionalLight(0xffffff, 0.9);
under.position.set(-0.35, 0.55, -1.2);
scene.add(under);

// ------------------------------------------------------------------ the plate

const plate = new THREE.Group();
scene.add(plate);

/** Grid + volume wireframe for a bed `sx` x `sy` mm and `sz` mm of headroom. */
function buildPlate(sx, sy, sz) {
  plate.clear();
  const hx = sx / 2, hy = sy / 2;
  const step = 10;

  // grid lines on z=0, brighter every 50mm
  const minor = [], major = [];
  for (let x = -Math.floor(hx / step) * step; x <= hx; x += step) {
    (Math.abs(x) % 50 === 0 ? major : minor).push(x, -hy, 0, x, hy, 0);
  }
  for (let y = -Math.floor(hy / step) * step; y <= hy; y += step) {
    (Math.abs(y) % 50 === 0 ? major : minor).push(-hx, y, 0, hx, y, 0);
  }
  for (const [pts, color, opacity] of [[minor, 0x6b7280, 0.45], [major, 0x111827, 0.9]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    plate.add(new THREE.LineSegments(
      g, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
  }

  // bed outline
  const edge = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx, -hy, 0), new THREE.Vector3(hx, -hy, 0),
    new THREE.Vector3(hx, hy, 0), new THREE.Vector3(-hx, hy, 0),
    new THREE.Vector3(-hx, -hy, 0),
  ]);
  plate.add(new THREE.Line(edge, new THREE.LineBasicMaterial({ color: 0x111827 })));

  // build volume
  const box = new THREE.Box3(
    new THREE.Vector3(-hx, -hy, 0), new THREE.Vector3(hx, hy, sz));
  const helper = new THREE.Box3Helper(box, 0x64748b);
  helper.material.transparent = true;
  helper.material.opacity = 0.55;
  plate.add(helper);
}

// ------------------------------------------------- file-manager display options

// Same three switches as the file manager's own 3D preview: wireframe, grid floor, axes.
const displayOptions = { wireframe: false, grid: true, axes: true };
const axesHelper = new THREE.AxesHelper(60);
scene.add(axesHelper);

function applyDisplayOptions() {
  plate.visible = displayOptions.grid;
  axesHelper.visible = displayOptions.axes;
  partMaterial.wireframe = displayOptions.wireframe;
}

addEventListener('message', (event) => {
  if (window.parent === window || event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'collabo:display') return;
  for (const key of ['wireframe', 'grid', 'axes']) {
    if (typeof data[key] === 'boolean') displayOptions[key] = data[key];
  }
  applyDisplayOptions();
  // The file manager's dark theme inverts the whole page (this iframe included), so a DARKER
  // source colour is what ends up whiter on screen.
  if (typeof data.dark === 'boolean' && data.dark !== darkHost) {
    darkHost = data.dark;
    SHADE.plain.setHex(darkHost ? 0x23272c : 0x4b5059, THREE.SRGBColorSpace);
    if (part && topology) shade();
  }
});
let darkHost = false;

/** Tell the file manager's side panel what the geometry panel should read. */
function postGeometryInfo(size) {
  if (window.parent === window || !part) return;
  window.parent.postMessage({
    type: 'collabo:geometry',
    vertices: part.geometry.getAttribute('position').count,
    faces: part.geometry.getAttribute('position').count / 3,
    size: { x: size.x, y: size.y, z: size.z },
  }, '*');
}
window.parent !== window && window.parent.postMessage({ type: 'collabo:ready' }, '*');

// ------------------------------------------------------------------- the part

const partMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.62, metalness: 0.05,
  vertexColors: true, side: THREE.DoubleSide,
});
const hiddenMeshMaterial = new THREE.MeshBasicMaterial({ visible: false });
let part = null;
let partName = '';
let topology = null;      // welded adjacency, rebuilt only when the mesh changes
let sourceMeshes = [];    // independent imported meshes, centred with the displayed assembly
let meshFaceRanges = [];
let selectedMeshIndices = new Set();
let hiddenMeshIndices = new Set();
let meshEditActive = false;
let meshEditMode = 'translate';
let meshEditPivot = null;
let meshEditPreview = null;
let meshEditRanges = [];
let meshEditDragStarted = false;
let boxSelectActive = false;
let boxSelectionDrag = null;
let measureActive = false;
let importNote = '';      // what the reader had to decide (3MF: merge/unit/skips;
                          // STEP family: bodies, shells, engine conversion)
let weldMs = 0;
let analysisTiming = '';
let lastSize = null;

// The user rotates. Always. Auto-orientation may suggest, never apply -- the
// spike's strength-optimal pose for one hub was 155mm tall balanced on a needle:
// geometrically valid, unprintable.
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('rotate');
gizmo.setSize(0.85);
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (meshEditActive) {
    if (e.value) {
      meshEditDragStarted = true;
      histPush([...selectedMeshIndices]);
    } else if (meshEditDragStarted) {
      meshEditDragStarted = false;
      commitMeshEdit();
    }
    return;
  }
  if (!e.value) {
    el('rot-delta').textContent = '';
    shade();
    if (finsVisible) refreshFins();
  }
});
gizmo.addEventListener('objectChange', () => {
  if (meshEditActive) return;
  showDelta(gizmo.axis, gizmo.rotationAngle);
  requestShade();
});

// 5 degrees, not 15: a coarse snap is what makes a drag feel like it is
// juddering rather than turning. Shift releases it entirely for fine work.
const SNAP = THREE.MathUtils.degToRad(5);
gizmo.setRotationSnap(SNAP);
addEventListener('keydown', (e) => { if (e.key === 'Shift') gizmo.setRotationSnap(null); });
addEventListener('keyup', (e) => { if (e.key === 'Shift') gizmo.setRotationSnap(SNAP); });

/**
 * Coalesce re-analysis to one per frame. A high-polling-rate mouse fires
 * pointermove (and so objectChange) well above 60Hz, so an un-throttled drag
 * runs the classify pass several times per displayed frame and stutters.
 */
let shadeQueued = false;
function requestShade() {
  if (shadeQueued) return;
  shadeQueued = true;
  requestAnimationFrame(() => { shadeQueued = false; shade(); });
}

function showDelta(axis, radians) {
  if (!axis || !radians) return;
  const label = axis.length > 1 ? '自由' : axis;   // 'XYZE' / 'E' are screen-space
  const deg = THREE.MathUtils.radToDeg(radians);
  el('rot-delta').textContent =
    `${label} ${deg >= 0 ? '+' : ''}${deg.toFixed(deg % 1 ? 1 : 0)}°`;
}

const SHADE = {
  plain: new THREE.Color().setHex(0x4b5059, THREE.SRGBColorSpace),
  over: new THREE.Color().setHex(0xff5a4d, THREE.SRGBColorSpace),
  bed: new THREE.Color().setHex(0x3f7fd0, THREE.SRGBColorSpace),
  selected: new THREE.Color().setHex(0x55baff, THREE.SRGBColorSpace),
};

function boundsForPositions(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

/**
 * Drop `geometry` onto the plate: centred in XY, its lowest point resting on
 * z=0. Returns the measured size so the caller can report it.
 */
function setPart(geometry, filename, meshes = null) {
  if (meshEditActive) leaveMeshEdit(false);
  clearMeasurements();
  selectedMeshIndices.clear();
  hiddenMeshIndices.clear();
  meshEditDragStarted = false;
  if (part) {
    part.geometry.dispose();
    scene.remove(part);
  }
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const center = [
    (bb.min.x + bb.max.x) / 2,
    (bb.min.y + bb.max.y) / 2,
    (bb.min.z + bb.max.z) / 2,
  ];
  // Centre the geometry on its own origin in ALL THREE axes, so the part rotates
  // about its middle and the gizmo sits there rather than at its feet. Seating on
  // the plate is not this transform's job -- analyze() returns the offset for that
  // after the rotation is known.
  geometry.translate(-center[0], -center[1], -center[2]);
  if (meshes && meshes.length) {
    sourceMeshes = meshes.map((mesh) => {
      const positions = new Float32Array(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        positions[i] = mesh.positions[i] - center[0];
        positions[i + 1] = mesh.positions[i + 1] - center[1];
        positions[i + 2] = mesh.positions[i + 2] - center[2];
      }
      return { name: mesh.name || filename, positions };
    });
  } else {
    sourceMeshes = [{ name: filename, positions: new Float32Array(geometry.getAttribute('position').array) }];
  }
  let faceStart = 0;
  meshFaceRanges = sourceMeshes.map((mesh) => {
    const range = { start: faceStart, end: faceStart + mesh.positions.length / 9 };
    faceStart = range.end;
    mesh.bounds = boundsForPositions(mesh.positions);
    return range;
  });
  el('split-components').disabled = false;
  // Always recompute shading normals from the winding -- never trust the STL's
  // stored normals. A binary STL carries a per-face normal that STLLoader loads
  // into a `normal` attribute, and exporters routinely write those as zero or
  // garbage (the same reason buildTopology derives its own). A zero normal lights
  // as pure black, so trusting the stored one renders the whole part invisible.
  // Dropping the attribute first forces computeVertexNormals to rebuild it.
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  part = new THREE.Mesh(geometry, partMaterial);
  part.add(hoverFace);
  hoverFace.visible = false;
  scene.add(part);

  const nFaces = geometry.getAttribute('position').count / 3;
  geometry.setAttribute(
    'color', new THREE.Float32BufferAttribute(new Float32Array(nFaces * 9), 3));

  const tWeld = performance.now();
  topology = buildTopology(geometry);
  weldMs = performance.now() - tWeld;
  computeFlatBaseline();

  partName = filename;
  part.quaternion.identity();
  gizmo.attach(part);
  el('orient').hidden = false;

  // A new part starts with no hand-drawn walls and a fresh print-space cache.
  drawnWalls = [];
  drawAugment = false;
  drawMsg = '';
  printTrisDirty = true;
  clearPreview();
  // A new part starts with no load direction either.
  loadDir = null;
  layPlacing = false;
  controls.enabled = true;
  loadArrowHelper.visible = false;
  if (loadArrowHelper.parent) loadArrowHelper.parent.remove(loadArrowHelper);
  syncLoadUI();
  setGizmo();

  // Undo history does not carry across parts.
  undoStack = [];
  redoStack = [];
  syncHistButtons();

  const size = shade();
  frame(size);
  updateMeshSelectionStatus();
  return size;
}

function updateMeshSelectionStatus() {
  const count = selectedMeshIndices.size;
  meshSelectionStatus.textContent = count
    ? `已选 ${count} / ${sourceMeshes.length} 个网格`
    : sourceMeshes.length ? `未选择网格（共 ${sourceMeshes.length} 个）` : '未载入模型';
  boxSelectButton.disabled = sourceMeshes.length === 0;
  boxSelectButton.classList.toggle('active', boxSelectActive);
  boxSelectButton.setAttribute('aria-pressed', String(boxSelectActive));
  for (const [mode, button] of Object.entries(meshEditButtons)) {
    button.disabled = count === 0 || drawActive() || layActive();
    button.classList.toggle('active', meshEditActive && meshEditMode === mode);
  }
  wholeRotateButton.disabled = !part;
  wholeRotateButton.classList.toggle('active', !meshEditActive && !!part);
  syncMeasureUI();
}

function paintMeshSelection(indices) {
  if (!part || !lastResult || !indices.size) return;
  const colors = part.geometry.getAttribute('color');
  const array = colors.array;
  for (const index of indices) {
    const range = meshFaceRanges[index];
    if (!range) continue;
    for (let face = range.start; face < range.end; face++) {
      const color = selectedMeshIndices.has(index)
        ? SHADE.selected
        : lastResult.kept[face] ? SHADE.over : lastResult.onBed[face] ? SHADE.bed : SHADE.plain;
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = face * 9 + vertex * 3;
        array[offset] = color.r;
        array[offset + 1] = color.g;
        array[offset + 2] = color.b;
      }
    }
  }
  colors.needsUpdate = true;
}

function setMeshSelection(indices) {
  if (meshEditActive && !meshEditDragStarted) leaveMeshEdit(false);
  const next = new Set(Array.from(indices).filter((index) => Number.isInteger(index) && index >= 0 && index < sourceMeshes.length && !hiddenMeshIndices.has(index)));
  const changed = new Set([...selectedMeshIndices, ...next]);
  selectedMeshIndices = next;
  paintMeshSelection(changed);
  updateMeshSelectionStatus();
}

function applyMeshVisibility() {
  if (!part || meshEditActive) return;
  part.geometry.clearGroups();
  if (!hiddenMeshIndices.size) {
    part.material = partMaterial;
    return;
  }
  part.material = [partMaterial, hiddenMeshMaterial];
  meshFaceRanges.forEach((range, index) => {
    part.geometry.addGroup(range.start * 3, (range.end - range.start) * 3,
      hiddenMeshIndices.has(index) ? 1 : 0);
  });
}

function rebuildPartMeshes() {
  if (!part) return;
  const vertexCount = sourceMeshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const positions = new Float32Array(vertexCount * 3);
  let offset = 0;
  let faceStart = 0;
  meshFaceRanges = sourceMeshes.map((mesh) => {
    positions.set(mesh.positions, offset);
    offset += mesh.positions.length;
    mesh.bounds = boundsForPositions(mesh.positions);
    const range = { start: faceStart, end: faceStart + mesh.positions.length / 9 };
    faceStart = range.end;
    return range;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(faceStart * 9), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  part.geometry.dispose();
  part.geometry = geometry;
  topology = buildTopology(geometry);
  weldMs = 0;
  computeFlatBaseline();
  applyMeshVisibility();
}

function separateSelectedMeshes() {
  if (!selectedMeshIndices.size || !part) return;
  if (meshEditActive) leaveMeshEdit(false);
  const beforeSelection = [...selectedMeshIndices].sort((a, b) => a - b);
  const replacements = new Map();
  for (const index of beforeSelection) {
    const mesh = sourceMeshes[index];
    const meshTopology = buildTopology({ getAttribute: () => ({ array: mesh.positions }) });
    const components = connectedFaceComponents(meshTopology);
    if (components.length < 2) continue;
    replacements.set(index, components.map((faces, partIndex) => {
      const positions = new Float32Array(faces.length * 9);
      faces.forEach((face, triangle) => positions.set(mesh.positions.subarray(face * 9, face * 9 + 9), triangle * 9));
      return { name: `${mesh.name} (${partIndex + 1})`, positions, bounds: boundsForPositions(positions) };
    }));
  }
  if (!replacements.size) {
    alert('所选网格均为独立连通零件，无需分离。');
    return;
  }

  histPush([], true);
  const result = replaceMeshGroups(sourceMeshes, replacements, selectedMeshIndices, hiddenMeshIndices);
  sourceMeshes = result.meshes;
  [selectedMeshIndices, hiddenMeshIndices] = result.indexSets;
  rebuildPartMeshes();
  shade();
  updateMeshSelectionStatus();
}

function combineSelectedMeshes() {
  if (selectedMeshIndices.size < 2 || !part) return;
  if (meshEditActive) leaveMeshEdit(false);
  const indices = [...selectedMeshIndices].sort((a, b) => a - b);
  const combinedHidden = indices.every((index) => hiddenMeshIndices.has(index));
  const combined = combineMeshPositions(sourceMeshes, selectedMeshIndices);
  combined.bounds = boundsForPositions(combined.positions);
  const replacements = new Map(indices.map((index, order) => [index, order === 0 ? [combined] : []]));
  histPush([], true);
  const result = replaceMeshGroups(sourceMeshes, replacements, selectedMeshIndices, hiddenMeshIndices);
  sourceMeshes = result.meshes;
  selectedMeshIndices = result.indexSets[0];
  hiddenMeshIndices = result.indexSets[1];
  const combinedIndex = [...selectedMeshIndices][0];
  hiddenMeshIndices.delete(combinedIndex);
  if (combinedHidden) {
    hiddenMeshIndices.add(combinedIndex);
    selectedMeshIndices.clear();
  }
  for (const index of hiddenMeshIndices) selectedMeshIndices.delete(index);
  rebuildPartMeshes();
  shade();
  updateMeshSelectionStatus();
}

function hideSelectedMeshes() {
  if (!selectedMeshIndices.size) return;
  if (meshEditActive) leaveMeshEdit(false);
  histPush();
  for (const index of selectedMeshIndices) hiddenMeshIndices.add(index);
  setMeshSelection([]);
  applyMeshVisibility();
  renderer.render(scene, camera);
}

function hideUnselectedMeshes() {
  if (!selectedMeshIndices.size) return;
  if (meshEditActive) leaveMeshEdit(false);
  histPush();
  for (let index = 0; index < sourceMeshes.length; index++) {
    if (!selectedMeshIndices.has(index)) hiddenMeshIndices.add(index);
  }
  applyMeshVisibility();
  renderer.render(scene, camera);
}

function showAllMeshes() {
  if (!hiddenMeshIndices.size) return;
  if (meshEditActive) leaveMeshEdit(false);
  histPush();
  hiddenMeshIndices.clear();
  applyMeshVisibility();
  shade();
}

function startMeshEdit(mode) {
  if (!part || !selectedMeshIndices.size || drawActive() || layActive()) return;
  if (meshEditActive) leaveMeshEdit(false);
  if (boxSelectActive) {
    boxSelectActive = false;
    selectionRect.hidden = true;
    renderer.domElement.style.cursor = '';
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let vertexCount = 0;
  meshEditRanges = [];
  for (const index of [...selectedMeshIndices].sort((a, b) => a - b)) {
    const mesh = sourceMeshes[index];
    const { min, max } = mesh.bounds;
    minX = Math.min(minX, min[0]); minY = Math.min(minY, min[1]); minZ = Math.min(minZ, min[2]);
    maxX = Math.max(maxX, max[0]); maxY = Math.max(maxY, max[1]); maxZ = Math.max(maxZ, max[2]);
    meshEditRanges.push({ index, offset: vertexCount * 3 });
    vertexCount += mesh.positions.length / 3;
  }
  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const previewPositions = new Float32Array(vertexCount * 3);
  const previewColors = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const { index } of meshEditRanges) {
    const positions = sourceMeshes[index].positions;
    for (let i = 0; i < positions.length; i += 3) {
      previewPositions[offset + i] = positions[i] - center.x;
      previewPositions[offset + i + 1] = positions[i + 1] - center.y;
      previewPositions[offset + i + 2] = positions[i + 2] - center.z;
      previewColors[offset + i] = SHADE.selected.r;
      previewColors[offset + i + 1] = SHADE.selected.g;
      previewColors[offset + i + 2] = SHADE.selected.b;
    }
    offset += positions.length;
  }

  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.Float32BufferAttribute(previewPositions, 3));
  previewGeometry.setAttribute('color', new THREE.Float32BufferAttribute(previewColors, 3));
  previewGeometry.computeVertexNormals();
  meshEditPreview = new THREE.Mesh(previewGeometry, partMaterial);
  meshEditPivot = new THREE.Object3D();
  meshEditPivot.position.copy(center);
  meshEditPivot.add(meshEditPreview);
  part.add(meshEditPivot);

  part.geometry.clearGroups();
  meshFaceRanges.forEach((range, index) => {
    part.geometry.addGroup(range.start * 3, (range.end - range.start) * 3,
      selectedMeshIndices.has(index) || hiddenMeshIndices.has(index) ? 1 : 0);
  });
  part.material = [partMaterial, hiddenMeshMaterial];
  meshEditActive = true;
  meshEditMode = mode;
  gizmo.attach(meshEditPivot);
  gizmo.setSpace('local');
  gizmo.setMode(mode);
  setGizmo();
  updateMeshSelectionStatus();
}

function leaveMeshEdit(refresh = true) {
  if (!meshEditActive) return;
  meshEditActive = false;
  meshEditDragStarted = false;
  if (part) {
    gizmo.attach(part);
    gizmo.setMode('rotate');
    part.geometry.clearGroups();
    part.material = partMaterial;
    applyMeshVisibility();
  }
  if (meshEditPivot?.parent) meshEditPivot.parent.remove(meshEditPivot);
  meshEditPreview?.geometry.dispose();
  meshEditPreview = null;
  meshEditPivot = null;
  meshEditRanges = [];
  gizmo.setSpace('local');
  setGizmo();
  if (refresh && part) shade();
  updateMeshSelectionStatus();
}

function rebuildMeshAnalysis() {
  const position = part.geometry.getAttribute('position');
  position.needsUpdate = true;
  part.geometry.deleteAttribute('normal');
  part.geometry.computeVertexNormals();
  part.geometry.computeBoundingBox();
  part.geometry.computeBoundingSphere();
  const start = performance.now();
  topology = buildTopology(part.geometry);
  weldMs = performance.now() - start;
  computeFlatBaseline();
  applyMeshVisibility();
}

function commitMeshEdit() {
  if (!meshEditActive || !meshEditPreview || !part) return;
  part.updateMatrixWorld(true);
  meshEditPreview.updateMatrixWorld(true);
  const toPart = new THREE.Matrix4().copy(part.matrixWorld).invert().multiply(meshEditPreview.matrixWorld);
  const previewPositions = meshEditPreview.geometry.getAttribute('position').array;
  const geometryPositions = part.geometry.getAttribute('position').array;
  const point = new THREE.Vector3();
  for (const { index, offset } of meshEditRanges) {
    const meshPositions = sourceMeshes[index].positions;
    const faceOffset = meshFaceRanges[index].start * 9;
    for (let i = 0; i < meshPositions.length; i += 3) {
      point.fromArray(previewPositions, offset + i).applyMatrix4(toPart);
      meshPositions[i] = geometryPositions[faceOffset + i] = point.x;
      meshPositions[i + 1] = geometryPositions[faceOffset + i + 1] = point.y;
      meshPositions[i + 2] = geometryPositions[faceOffset + i + 2] = point.z;
    }
    sourceMeshes[index].bounds = boundsForPositions(meshPositions);
  }
  rebuildMeshAnalysis();
  leaveMeshEdit(false);
  shade();
}

for (const [mode, button] of Object.entries(meshEditButtons)) {
  button.addEventListener('click', () => startMeshEdit(mode));
}
wholeRotateButton.addEventListener('click', () => leaveMeshEdit());

function toggleBoxSelect() {
  if (meshEditActive) leaveMeshEdit(false);
  boxSelectActive = !boxSelectActive;
  selectionRect.hidden = true;
  renderer.domElement.style.cursor = boxSelectActive ? 'crosshair' : '';
  updateMeshSelectionStatus();
}

function projectedMeshBounds(index) {
  if (!part || !sourceMeshes[index]?.bounds) return null;
  const { min, max } = sourceMeshes[index].bounds;
  part.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const rect = renderer.domElement.getBoundingClientRect();
  const point = new THREE.Vector3();
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let visible = false;
  for (let corner = 0; corner < 8; corner++) {
    point.set(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
    part.localToWorld(point);
    point.project(camera);
    if (point.z < -1 || point.z > 1) continue;
    visible = true;
    const x = rect.left + (point.x + 1) * rect.width / 2;
    const y = rect.top + (1 - point.y) * rect.height / 2;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return visible ? { left, top, right, bottom } : null;
}

function selectMeshesInRect(rect, additive) {
  const hits = new Set();
  sourceMeshes.forEach((_, index) => {
    if (hiddenMeshIndices.has(index)) return;
    const bounds = projectedMeshBounds(index);
    if (bounds && intersectsScreenRect(bounds, rect)) hits.add(index);
  });
  if (additive) for (const index of selectedMeshIndices) hits.add(index);
  setMeshSelection(hits);
}

function closeMeshContextMenu() {
  meshContextMenu.hidden = true;
  meshContextMenu.replaceChildren();
}

function addMeshMenuItem(label, action, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', () => {
    closeMeshContextMenu();
    action();
  });
  meshContextMenu.appendChild(button);
}

function showMeshContextMenu(event, hitIndex) {
  if (hitIndex >= 0 && !selectedMeshIndices.has(hitIndex)) setMeshSelection([hitIndex]);
  closeMeshContextMenu();
  if (hitIndex >= 0) {
    addMeshMenuItem('只选择此网格', () => setMeshSelection([hitIndex]));
  }
  const count = selectedMeshIndices.size;
  if (count) {
    addMeshMenuItem('移动所选网格', () => startMeshEdit('translate'));
    addMeshMenuItem('旋转所选网格', () => startMeshEdit('rotate'));
    addMeshMenuItem('缩放所选网格', () => startMeshEdit('scale'));
    addMeshMenuItem('分离模型', separateSelectedMeshes);
    addMeshMenuItem('结合模型', combineSelectedMeshes, count < 2);
    addMeshMenuItem('隐藏选择', hideSelectedMeshes);
    addMeshMenuItem('隐藏未选择', hideUnselectedMeshes);
  }
  if (hiddenMeshIndices.size) addMeshMenuItem('显示全部模型', showAllMeshes);
  addMeshMenuItem('导出所选网格为 STL ZIP', splitSelectedMeshes, count === 0);
  addMeshMenuItem('导出所选网格组合 3MF', exportSelectedMeshes3MF, count < 2);
  addMeshMenuItem('按连通零件导出 ZIP', () => el('split-components').click(), !part);
  if (count) addMeshMenuItem('清除选择', () => setMeshSelection([]));
  meshContextMenu.hidden = false;
  const width = meshContextMenu.offsetWidth;
  const height = meshContextMenu.offsetHeight;
  meshContextMenu.style.left = `${Math.min(event.clientX, innerWidth - width - 6)}px`;
  meshContextMenu.style.top = `${Math.min(event.clientY, innerHeight - height - 6)}px`;
}

boxSelectButton.addEventListener('click', toggleBoxSelect);
addEventListener('pointerdown', (event) => {
  if (!meshContextMenu.hidden && !meshContextMenu.contains(event.target)) closeMeshContextMenu();
});

/**
 * Re-run the overhang analysis in the part's CURRENT orientation, re-seat it on
 * the plate, and paint the result. Cheap enough to call on every frame of a
 * gizmo drag -- the expensive weld already happened in setPart(), and rotation
 * cannot invalidate it.
 */
const rotM3 = new THREE.Matrix3();
const rotM4 = new THREE.Matrix4();

// Overhangs in the AS-LOADED (identity) orientation. For an exported STL that is
// almost always the flat print pose, so it answers the question the leaf raised:
// does this part even need the tool? A part that prints flat with no overhangs
// gets none here, and every overhang the user then sees is one they created by
// rotating. Depends only on topology + threshold, never on rotation, so it is
// cached -- recomputed on load and on a threshold change, not per drag frame.
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
let flatRegions = null;
function computeFlatBaseline() {
  flatRegions = topology ? analyze(topology, threshold, IDENTITY3).regions.length : null;
}

function shade() {
  if (!part || !topology) return new THREE.Vector3();
  rotM3.setFromMatrix4(rotM4.makeRotationFromQuaternion(part.quaternion));

  const t0 = performance.now();
  const res = analyze(topology, threshold, rotM3.elements);
  const ms = performance.now() - t0;

  // Drop the rotated part back onto the plate, centred over it -- but NOT mid-drag.
  // The rotate gizmo turns the part about part.position, so re-seating it every
  // frame slides the pivot out from under the pointer and the ring reads as jumpy /
  // jittery. While a drag is live we hold the pre-drag seat and let the part swing
  // about that fixed point; the drag-end handler re-seats once, on release. The
  // face SHADING below still updates live either way, so the diagnosis never stalls.
  if (!gizmo.dragging) part.position.set(res.offset.x, res.offset.y, res.offset.z);

  const size = new THREE.Vector3(res.size.x, res.size.y, res.size.z);
  report(partName, size);

  const colors = part.geometry.getAttribute('color');
  const arr = colors.array;
  let meshIndex = 0;
  for (let f = 0; f < topology.nFaces; f++) {
    while (meshIndex < meshFaceRanges.length - 1 && f >= meshFaceRanges[meshIndex].end) meshIndex++;
    const c = selectedMeshIndices.has(meshIndex)
      ? SHADE.selected : res.kept[f] ? SHADE.over : res.onBed[f] ? SHADE.bed : SHADE.plain;
    for (let i = 0; i < 3; i++) {
      const o = f * 9 + i * 3;
      arr[o] = c.r; arr[o + 1] = c.g; arr[o + 2] = c.b;
    }
  }
  colors.needsUpdate = true;

  const dropped = res.rawRegionCount - res.regions.length;
  el('s-over').textContent = res.regions.length === 0
    ? '无'
    : `${res.regions.length} 处` +
      (dropped ? `（另有 ${dropped} 处碎小悬垂）` : '');
  el('s-over').classList.toggle('good', res.regions.length === 0);

  // Overhang warning (bottom-right card). The tool builds support for the big
  // overhang REGIONS but drops the small ones -- hole ceilings, slot roofs, bore
  // tops -- as slivers. Those are exactly what prints rough by surprise, so name
  // them out loud instead of leaving the maker to find out at the printer. Only
  // fires when this pose actually has overhangs to support (a clean/flat pose says
  // its piece via s-flat-note); the fix is almost always a better orientation.
  const warn = el('over-warn');
  if (res.regions.length > 0 && dropped > 0) {
    warn.textContent = `⚠ ${dropped} 处小悬垂（孔顶、槽顶、内孔上沿）`
      + `在当前朝向下得不到支撑，表面可能粗糙。`
      + `点“推荐摆放方向”把它们转到朝上。`;
  } else {
    warn.textContent = '';
  }
  el('s-overarea').textContent = `${res.overArea.toFixed(0)} mm²`;
  el('s-bed').textContent = `${res.bedArea.toFixed(0)} mm²`;
  el('s-bed').classList.toggle('warn', res.bedArea < 1);

  // "Do you even need me?" -- fire the honest signal before the user turns fins
  // on. Current pose clean wins outright; otherwise, if the part printed flat as
  // loaded, the overhangs on screen are self-inflicted by rotating.
  const flat = el('s-flat-note');
  if (res.regions.length === 0) {
    flat.textContent = '这个朝向不需要任何支撑。';
    flat.className = 'note good';
  } else if (flatRegions === 0) {
    flat.textContent = '平放即可打印干净。只有为了强度而倾斜时，'
      + '才需要支撑鳍。';
    flat.className = 'note';
  } else {
    flat.textContent = '';
  }
  // Kept as a value rather than read back off the element: the fin readout
  // appends to this line, and the mode / bed-pad / toggle handlers call
  // refreshFins() WITHOUT going through shade(), so appending in place stacked
  // up "· fins 3 ms · fins 3 ms · fins 3 ms" with every toggle.
  analysisTiming = `${ms.toFixed(0)} ms · 焊接 ${weldMs.toFixed(0)} ms`;
  el('s-time').textContent = analysisTiming;

  lastResult = res;
  printTrisDirty = true;      // orientation moved: the cached print-space part is stale
  if (finsVisible && !gizmo.dragging) refreshFins();
  else if (finsVisible) markFinsStale();

  // where the part currently sits, the way a slicer states it
  const [ex, ey, ez] = readableEuler(part.quaternion);
  el('rot-now').textContent = `X ${ex}° · Y ${ey}° · Z ${ez}°`;
  // both strength views are pose-dependent, so refresh them whenever the part turns:
  // the automatic layer view (always), and the optional load-arrow verdict (if set)
  updateLayerView(size);
  updateLoadReadout();
  syncLoadUI();            // re-light the pad button for the load's new world direction
  return size;
}

const wrap180 = (deg) => {
  const v = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Object.is(v, -0)) return 0;
  return v === -180 ? 180 : v;      // half a turn reads better as +180
};

/**
 * Euler angles for display, in whichever of the two equivalent solutions reads
 * better. Every orientation has two XYZ triples, and the one three.js hands back
 * is often the ugly one: turning a part 90 degrees about Y twice reports
 * "X -180, Y 0, Z -180" rather than "Y 180". Same rotation, but a user reading it
 * cannot tell what they did.
 *
 * The alternate solution is verified against the original quaternion rather than
 * trusted, so a convention change in three.js degrades to the plain answer
 * instead of silently displaying a wrong one.
 */
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

function readableEuler(q) {
  _e.setFromQuaternion(q, 'XYZ');
  const a = [_e.x, _e.y, _e.z].map((r) => wrap180(THREE.MathUtils.radToDeg(r)));
  const b = [wrap180(a[0] + 180), wrap180(180 - a[1]), wrap180(a[2] + 180)];

  const cost = (v) => Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
  if (cost(b) < cost(a)) {
    _e.set(...b.map(THREE.MathUtils.degToRad), 'XYZ');
    _q.setFromEuler(_e);
    if (Math.abs(Math.abs(_q.dot(q)) - 1) < 1e-6) return b.map(Math.round);
  }
  return a.map(Math.round);
}

/** Point the camera at the part, backed off far enough to see all of it. */
function frame(size) {
  sizeMarkers(size);
  const reach = Math.max(size.x, size.y, size.z, 40);
  const dist = reach * 2.1;
  camera.position.set(dist * 0.62, -dist * 0.72, dist * 0.55);
  camera.near = Math.max(0.5, reach / 200);
  camera.far = dist * 12;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, size.z / 2);
  controls.update();
}

// -------------------------------------------------------------------- reports

function report(filename, size) {
  el('s-name').textContent = filename;
  el('s-tris').textContent = (topology?.nFaces ?? 0).toLocaleString();
  el('s-bbox').textContent =
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;

  lastSize = size;
  updateFit();
  postGeometryInfo(size);

  // Empty string hides it: `.note:empty { display: none }`, same as the sibling notes.
  el('s-import-note').textContent = importNote;

  el('stats').hidden = false;
  el('status').hidden = false;
  el('drop').classList.add('hidden');
}

/**
 * Does it fit the build volume -- including everything the tool ADDS?
 *
 * Checking the part alone understates it. The pad spreads `padMargin` past the
 * part's contact and the fin's base another `basePad` past the wall, so a part
 * that fits on its own can still put its bed pad over the edge of the plate. The
 * export bakes those in, so the answer has to account for them.
 */
function updateFit() {
  if (!lastSize) return;
  const v = currentVolume();
  let dx = lastSize.x, dy = lastSize.y, dz = lastSize.z;

  const added = activeAdded();
  if (added.length) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const t of added) {
      if (t[0] < x0) x0 = t[0]; if (t[0] > x1) x1 = t[0];
      if (t[1] < y0) y0 = t[1]; if (t[1] > y1) y1 = t[1];
      if (t[2] > z1) z1 = t[2];
    }
    // the part is centred on the plate, so what matters is the half-extent each
    // way, not the raw span of the fins alone
    dx = Math.max(dx, 2 * Math.max(Math.abs(x0), Math.abs(x1)));
    dy = Math.max(dy, 2 * Math.max(Math.abs(y0), Math.abs(y1)));
    dz = Math.max(dz, z1);
  }

  const over = dx > v.x || dy > v.y || dz > v.z;
  const fit = el('s-fit');
  fit.textContent = over
    ? (added.length ? '装不下（含支撑鳍）' : '装不下')
    : '放得下';
  fit.classList.toggle('warn', over);
}

// ------------------------------------------------------------------- printers

// ----------------------------------------------------------------------- fins

let lastResult = null;
let finsVisible = false;
// The wall is the default support and the fin is the Brace OPTION, not the
// other way around -- flipped at M5c. Measured over the dev matrix, the fin
// covers 4% of overhang area (it braces against toppling; it holds nothing up)
// and 7 of its 12 placements lean 25-40deg. The wall covers 61%, always
// vertical. A user who loads a part and exports should get the support that
// supports.
//
// DEFAULT IS 'auto': click "Add fins" and the tool places the supports for you
// (tined combined fins on the grippable overhangs, plain props on the rest). Draw
// is the by-hand path. ('prop' still exists internally -- Draw calls it for the
// bed pad + seating verdict, and it is the geometry Auto props with.)
let finMode = 'auto';
// Suggest + Draw mix: when true, the pointer places hand-drawn walls ON TOP of the
// auto-placed ones (for when auto misses a spot). It only gates the pointer; the
// drawn walls themselves stay shown/exported after placing until Clear all.
let drawAugment = false;
/**
 * Why did this part get no fins, in terms the user can act on?
 *
 * "No flat vertical face" is technically true and useless: it does not say
 * whether to rotate the part, accept it, or wait for draw mode. Each stage of
 * the search discards candidates for a different reason, so name the stage that
 * actually emptied out.
 */
function explainNoFins(b) {
  // A part balanced on a point cannot be rescued by ANY support UNLESS the
  // bed pad is on to seat it (the shelter hubs print exactly that way), so
  // saying "no flat face" or "part in the way" sends the user to tune
  // something that was never the problem. This outranks every mode-specific
  // reason below.
  if (b.seating?.kind === 'point' && !b.pad) {
    return '零件只以一点接触底板，没有可站立的面。请开启底盘垫把它固定住，'
         + '或旋转到让某个面或边稳稳落在底板上';
  }
  if (b.mode === 'prop') {
    const s = b.skipped ?? {};
    if (!b.rejected.sites) return '这个朝向下没有需要支撑的悬垂';
    // Named in the order that tells the user the most. Each is a different
    // stage of the search, and lumping them into "blocked" is what let M5 be
    // recorded as working on a part where it built nothing.
    if (s.wanders) {
      const one = s.wanders === 1;
      return `${s.wanders} 处悬垂是碗状而不是一条檐边 —— 它们的最低点围成一个环，`
           + '而不是一条线，支撑墙无从沿着它生长。请旋转零件，'
           + '或切到“手动”模式自己放一段';
    }
    if (s.buried || s.weld) {
      return '所有能够到这些悬垂的支撑墙都会与零件熔在一起 —— '
           + '请旋转零件，或切到“手动”模式自己放一段';
    }
    if (s.blocked) {
      return '这些悬垂中没有足够长的一段可以立支撑墙 —— '
           + '要么被零件本身挡住，要么离底板太近';
    }
    if (s.stub || s.noLine || s.sliver) {
      return '这里的悬垂太小或太低，不值得做一段支撑墙';
    }
    if (s.degenerate) {
      return '这里的接触线缩成了一点 —— 没有可以扫掠的路径';
    }
    return '这个朝向下没有任何悬垂能放支撑柱';
  }
  const st = b.patchStats ?? {};
  if (!b.patchCount) {
    // a cylinder or a mesh of small facets has no flat face wide enough
    return (st.tooNarrow ?? 0) > (st.notFlat ?? 0)
      ? '没有足够大又平整的面可以立支撑鳍 —— 曲面或细碎的多边形面'
        + '没有可抓附的平面'
      : '这个朝向下零件上没有可用的竖直平面';
  }
  if (!b.rejected.sites) {
    return st.tooHigh
      ? `找到了 ${st.tooHigh} 处平面，但它们都从零件过高的位置开始 —— `
        + '支撑鳍大半会是空立的高跷。请旋转到有平面一直延伸到底板。'
      : '这个朝向下没有可用平面 —— 试试旋转';
  }
  if (b.rejected.blocked) {
    return '在找到的这些面上，每个支撑墙位置都被零件本身挡住 '
         + '—— 请旋转，或切到“手动”模式自己放一段';
  }
  return '可用的位置都会把支撑鳍埋进零件内部 —— 试试旋转';
}

let finMesh = null;
let padMesh = null;
let finTris = [];
let padTris = [];

const finMaterial = new THREE.MeshStandardMaterial({
  color: 0x59d98e, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
});
// The pad is not a fin -- it is a modification to how the part meets the plate,
// and the user has to be able to see at a glance which is which before they
// commit to an export.
const padMaterial = new THREE.MeshStandardMaterial({
  color: 0xe8b64c, roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide,
});

// ---- draw mode: the user places breakaway walls by hand --------------------
// A drawn wall IS the same kind of support the auto-placer emits, so it shares
// the fin material and the green legend swatch. What is different is who chose
// the line: a person, not a PCA fit -- which is the whole reason it comes out
// straight. Endpoints are stored in the part's LOCAL frame so a wall tracks the
// part through later rotations, the same way the auto fins are rebuilt each time
// the orientation changes.
let drawnWalls = [];        // committed walls: { a: Vector3(local), b: Vector3(local), ok, info }
let drawnMesh = null;
let drawnTris = [];
let drawStart = null;       // Vector3 (local) -- first click of a wall in progress
let drawMsg = '';           // last placement result, for the readout
let lastBuilt = null;       // last buildFins result, kept for the bed pad + seating readout
let printTris = null;       // whole part in print space, cached per orientation
let printTrisDirty = true;

const drawMaterial = new THREE.MeshStandardMaterial({
  color: 0x59d98e, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
});
// A live, translucent preview of the wall the current drag would make.
const ghostMaterial = new THREE.MeshStandardMaterial({
  color: 0x8ff0bd, roughness: 0.7, transparent: true, opacity: 0.45,
  side: THREE.DoubleSide,
});
let ghostMesh = null;

// endpoint dot, cursor dot, and the rubber-band line between them. Base radius
// 1mm; sizeMarkers() scales them to the part so they read on a 40mm cube and a
// 300mm bracket alike.
//
// These are a UI overlay, so they draw with depthTest OFF and a high renderOrder:
// the line and dots sit ON the part surface, and an opaque part face (or a fin)
// rendered over them would otherwise win the depth test and hide the guide --
// which is exactly why the band read as "not rendering" on a face seen head-on.
// depthTest off makes them a HUD that is always visible regardless of what's in
// front. transparent:true is set so the renderOrder is honoured in the draw sort.
const guideMat = (color) => new THREE.MeshBasicMaterial(
  { color, depthTest: false, transparent: true });
const drawDot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), guideMat(0x59d98e));
const drawCursor = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), guideMat(0xcffbe4));
const bandGeom = new THREE.BufferGeometry()
  .setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const drawBand = new THREE.Line(bandGeom,
  new THREE.LineBasicMaterial({ color: 0x6dffab, depthTest: false, transparent: true }));
drawBand.frustumCulled = false;   // its endpoints move every frame; stale bounds would cull it
for (const o of [drawDot, drawCursor, drawBand]) {
  o.visible = false;
  o.renderOrder = 11;             // above the hoverFace (renderOrder 1) and the part
  scene.add(o);
}

// ------------------------------------------------------------------- load arrow
//
// The user shows which way the part is loaded in use, and the tool says whether
// the print layers run WITH that load or across it (the weak plane), and offers a
// stronger pose. It drives a QUALITATIVE readout, never a fake "Nx stronger"
// number (see loadAlignment in orient.js).
//
// We store a DIRECTION only, in the part's local frame, because the pull model
// only cares which way the load points -- not where on the part it lands. (A
// cantilever/lever load WOULD care where it lands, since it snaps at the root; if
// that toggle is ever built, this becomes a point + direction. Until then, storing
// a bare direction keeps the UI honest: the arrow is drawn through the part's
// centre so no spot on the surface looks load-bearing when it isn't.) Local so it
// rotates and re-seats with the part; parenting the helper to `part` gives that.
let loadDir = null;         // THREE.Vector3 unit direction in local space, or null
let layPlacing = false;     // true while "lay a face flat" is armed -- gated behind a
                            // button so a stray viewport click can't re-lay the part
const loadArrowHelper = new THREE.ArrowHelper(
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 10, 0xffb454, 4, 2.6);
loadArrowHelper.visible = false;
loadArrowHelper.renderOrder = 12;   // over the part and the draw guides
for (const m of [loadArrowHelper.line, loadArrowHelper.cone]) {
  m.material.depthTest = false;      // a HUD arrow, always visible like the draw guides
  m.material.transparent = true;
  m.renderOrder = 12;
}

/** "Lay a face flat" is armed: a face click lays the part on that face. Off by
 *  default so casual clicks orbit instead of silently re-laying the part. */
const layActive = () => layPlacing;

// ------------------------------------------------------------------- layer view
//
// A faint stack of horizontal frames around the part, world-aligned, that shows
// how the print is layered: they stay horizontal while the part turns INSIDE them,
// so you see which way the layers slice it and (with the note) where it's weak.
// Purely illustrative -- no input, no effect on geometry. This is the automatic
// "what does this orientation do to strength" view; the load arrow is the optional
// add-on for when you know the actual load. Rebuilt each shade() to fit the part.
let layersOn = false;
const MAX_LAYER_FRAMES = 16;
const layerGeom = new THREE.BufferGeometry();
layerGeom.setAttribute('position',
  new THREE.BufferAttribute(new Float32Array(MAX_LAYER_FRAMES * 8 * 3), 3));
// depthTest OFF so the horizontal frames read as layer lines ACROSS the part (a
// HUD, like the draw guides) instead of being hidden inside its bounding box.
const layerViz = new THREE.LineSegments(layerGeom,
  new THREE.LineBasicMaterial({ color: 0x9ecbf5, transparent: true, opacity: 0.4, depthTest: false }));
layerViz.frustumCulled = false;    // the frames resize every pose; stale bounds would cull it
layerViz.renderOrder = 10;         // over the part, under the load arrow (12)
layerViz.visible = false;
scene.add(layerViz);

/** Refit the layer frames to the seated bounding box `size` (part is centred on
 *  XY origin, resting on z=0). Density is adaptive -- roughly a frame every 8mm,
 *  clamped -- so a flat part isn't a cramped smear and a tall one isn't sparse. */
function rebuildLayerViz(size) {
  const count = Math.max(3, Math.min(MAX_LAYER_FRAMES, Math.round(size.z / 8) + 1));
  // Extend the frames a little past the silhouette so the layer lines clearly poke
  // out either side of the part instead of hiding along its edge.
  const m = Math.max(4, 0.12 * Math.max(size.x, size.y));
  const hx = size.x / 2 + m, hy = size.y / 2 + m;
  const pos = layerGeom.getAttribute('position').array;
  let o = 0;
  const edge = (ax, ay, bx, by, z) => {
    pos[o++] = ax; pos[o++] = ay; pos[o++] = z;
    pos[o++] = bx; pos[o++] = by; pos[o++] = z;
  };
  for (let k = 0; k < count; k++) {
    const z = (size.z * k) / (count - 1);
    edge(-hx, -hy,  hx, -hy, z);
    edge( hx, -hy,  hx,  hy, z);
    edge( hx,  hy, -hx,  hy, z);
    edge(-hx,  hy, -hx, -hy, z);
  }
  layerGeom.setDrawRange(0, count * 8);
  layerGeom.getAttribute('position').needsUpdate = true;
  layerGeom.computeBoundingSphere();
}

/** Rebuild the layer-line frames for the current pose (the toggle-able 3D viz).
 *  The prose strength note that used to live here was dropped -- the Strength
 *  arrow below covers load, and the always-on line mostly stated the obvious. */
function updateLayerView(size) {
  rebuildLayerViz(size);
  layerViz.visible = layersOn && !!part;
}

// Pointer is in wall-placement mode (draw mode, or Suggest with the add toggle on).
// Gates the draw interaction, the gizmo, and face-lay.
const drawActive = () => finsVisible && (finMode === 'draw' || drawAugment);
// Hand-drawn walls contribute to the display and the export. In Draw mode that's
// always; in Suggest it's whenever the user has drawn any (they persist after the
// add toggle is switched off, so you can orbit and export without losing them).
const drawShown = () =>
  finsVisible && (finMode === 'draw' || (finMode === 'auto' && (drawAugment || drawnWalls.length > 0)));

function sizeMarkers(size) {
  const r = Math.max(0.7, Math.max(size.x, size.y, size.z) / 90);
  drawDot.scale.setScalar(r);
  drawCursor.scale.setScalar(r * 0.85);
}

/** The whole part in PRINT space (rotated + seated), rebuilt only when the
 *  orientation changes. This is the surface a drawn wall's contact line samples,
 *  the same transform export bakes in. */
function partPrintTriangles() {
  if (printTris && !printTrisDirty) return printTris;
  const { pos, nFaces } = topology;
  const rot = rotM3.elements;
  const { x: dx, y: dy, z: dz } = lastResult.offset;
  const a = new Float64Array(nFaces * 9);
  for (let i = 0; i < a.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    a[i]     = rot[0] * x + rot[3] * y + rot[6] * z + dx;
    a[i + 1] = rot[1] * x + rot[4] * y + rot[7] * z + dy;
    a[i + 2] = rot[2] * x + rot[5] * y + rot[8] * z + dz;
  }
  printTris = a;
  printTrisDirty = false;
  return a;
}

/** Drop any wall-in-progress and hide every transient draw visual. */
function clearPreview() {
  drawStart = null;
  drawDot.visible = drawCursor.visible = drawBand.visible = false;
  if (ghostMesh) { scene.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
}

/** Rebuild the committed drawn walls for the current orientation. */
function rebuildDrawn() {
  if (drawnMesh) { scene.remove(drawnMesh); drawnMesh.geometry.dispose(); drawnMesh = null; }
  drawnTris = [];
  if (!drawShown() || !topology || !lastResult) return;
  part.updateMatrixWorld();

  // Both Draw and the Suggest "+ Add" augment place the SAME thing now: hand-drawn
  // under-overhang breakaway walls. Each wall is stored as two local endpoints and
  // re-swept against the part's current pose, so a wall that no longer reaches the
  // part (rotated away) is flagged by drawnWall rather than dropped silently.
  const tris = partPrintTriangles();
  // Drawn walls grip with the same tine comb the auto fins use when Tines is on.
  const drawOpts = { tines: el('tines').checked,
                     tineDensity: el('tine-density').valueAsNumber / 100,
                     layerHeight: el('layer-height').valueAsNumber,
                     topo: topology, rot: rotM3.elements, offset: lastResult.offset };
  const wa = new THREE.Vector3(), wb = new THREE.Vector3();
  for (const w of drawnWalls) {
    part.localToWorld(wa.copy(w.a));
    part.localToWorld(wb.copy(w.b));
    const r = drawnWall([wa.x, wa.y, wa.z], [wb.x, wb.y, wb.z], tris, 0, drawOpts);
    w.ok = r.ok;
    w.info = r;
    if (r.ok) for (const t of r.tris) drawnTris.push(t);
  }
  drawnMesh = meshFrom(drawnTris, drawMaterial);
}

/** The walls + pad the CURRENT mode contributes to the export and the fit check. */
function activeAdded() {
  // Both auto modes bake their geometry into finTris (refreshFins' else branch):
  // Suggest → gripping fins + fallback props, Combined fin → gripping fins only.
  // Only Draw leaves it empty and exports the hand-drawn walls instead.
  const auto = finMode === 'draw' ? [] : finTris;
  const drawn = drawShown() ? drawnTris : [];
  return [...auto, ...drawn, ...padTris];
}

/** Show the endpoint / cursor / band, and a live ghost of the wall in progress. */
let ghostQueued = null;
function updatePreview(hitPoint) {
  drawCursor.position.copy(hitPoint);
  drawCursor.visible = true;
  if (!drawStart) { drawBand.visible = false; return; }
  part.updateMatrixWorld();
  const aWorld = part.localToWorld(drawStart.clone());
  drawDot.position.copy(aWorld);
  drawDot.visible = true;
  bandGeom.setFromPoints([aWorld, hitPoint]);
  bandGeom.attributes.position.needsUpdate = true;
  drawBand.visible = true;

  // Build the ghost wall at most once per frame: one wall over the whole part is
  // a few ms, fine occasionally but not at raw pointer-move rates.
  const already = !!ghostQueued;
  ghostQueued = [aWorld.clone(), hitPoint.clone()];
  if (already) return;
  requestAnimationFrame(() => {
    const q = ghostQueued;
    ghostQueued = null;
    if (!q || !drawStart || !drawActive()) return;
    if (ghostMesh) { scene.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
    const tris = partPrintTriangles();
    const r = drawnWall([q[0].x, q[0].y, q[0].z], [q[1].x, q[1].y, q[1].z], tris, 0);
    if (r.ok) ghostMesh = meshFrom(r.tris, ghostMaterial);
  });
}

/** Commit the wall from `drawStart` to the just-clicked point, if it can build. */
function placeSecondPoint(hitPoint) {
  part.updateMatrixWorld();
  const aWorld = part.localToWorld(drawStart.clone());
  const bWorld = hitPoint.clone();
  const tris = partPrintTriangles();
  const r = drawnWall([aWorld.x, aWorld.y, aWorld.z],
                      [bWorld.x, bWorld.y, bWorld.z], tris, 0);
  if (!r.ok) {
    drawMsg = `couldn’t place that wall: ${r.reason}`;
    clearPreview();
    updateReadout(lastBuilt);
    return;
  }
  drawMsg = '';
  histPush();
  drawnWalls.push({ a: drawStart.clone(), b: part.worldToLocal(bWorld.clone()) });
  clearPreview();
  rebuildDrawn();
  updateReadout(lastBuilt);
  updateFit();
}

/** Enable the rotate gizmo only when NOT drawing or laying a face flat --
 *  its handles would otherwise swallow the clicks those modes need. */
function setGizmo() {
  if (meshEditActive && (drawActive() || layActive())) leaveMeshEdit(false);
  const on = !!part && !drawActive() && !layActive() && !measureActive;
  gizmo.enabled = on;
  const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
  helper.visible = on;
}

// ---------------------------------------------------------------- load arrow UI

/**
 * Redraw the arrow from `loadDir`, parented to the part so it follows the pose.
 * The part geometry is centred on its own origin (see setPart), so the load axis
 * is drawn THROUGH that centre -- it reads as "the part is pulled this way", not
 * as a force pinned to some spot, which is the honest picture for the pull model.
 */
function updateLoadArrowMesh() {
  if (!loadDir || !part) { loadArrowHelper.visible = false; return; }
  if (loadArrowHelper.parent !== part) part.add(loadArrowHelper);
  const bb = part.geometry.boundingBox;
  const maxDim = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
  const len = Math.max(10, maxDim * 0.6);
  // Centre the whole arrow on the origin: tail at -dir*len/2 so it spans the part.
  loadArrowHelper.position.copy(loadDir).multiplyScalar(-len / 2);
  loadArrowHelper.setDirection(loadDir);
  loadArrowHelper.setLength(len, Math.min(len * 0.28, 12), Math.min(len * 0.18, 7));
  loadArrowHelper.visible = true;
}

/** Commit a load direction (part-LOCAL, so it tracks the pose). Every pad button
 *  lands here via setLoadWorld. */
function setLoadDir(local) {
  if (!part || local.lengthSq() < 1e-9) return;
  histPush();
  loadDir = local.normalize();
  updateLoadArrowMesh();
  updateLoadReadout();
  setGizmo();
  syncLoadUI();
}

/**
 * The qualitative strength verdict for the CURRENT pose. World +Z is the build
 * axis once the part is seated, so the load direction in world space is all
 * loadAlignment needs. Re-run on every orientation change (from shade()) so the
 * verdict tracks the part as it turns.
 */
function updateLoadReadout() {
  const note = el('load-note');
  const suggestBtn = el('load-suggest');
  if (!loadDir || !part) {
    note.hidden = true;
    suggestBtn.hidden = true;
    return;
  }
  const w = loadDir.clone().applyQuaternion(part.quaternion);
  const al = loadAlignment([w.x, w.y, w.z]);
  if (!al) { note.hidden = true; suggestBtn.hidden = true; return; }
  note.textContent = al.text;
  note.className = `load-verdict ${al.quality}`;
  note.hidden = false;
  // Offer a stronger pose only when this one isn't already good. Wired in the
  // suggest section below; here we just decide whether to show the button.
  suggestBtn.hidden = al.quality === 'good';
}

// The Strength-arrow pad: pick a world direction and the load points that way.
// The strength math only wants a unit direction (it discards any anchor point), so
// a handful of buttons is the honest input -- no 3D aiming, no face-hunting, and
// nothing that collides with click-to-lay-flat. Directions are WORLD-relative (as
// the part sits on the bed); stored local so the arrow tracks the pose as it turns.
const PAD_DIRS = {
  up:    [0, 0, 1],  down:  [0, 0, -1],
  right: [1, 0, 0],  left:  [-1, 0, 0],
  back:  [0, 1, 0],  front: [0, -1, 0],
};

/** Point the load along a world direction (one pad button). */
function setLoadWorld(key) {
  if (!part) return;
  const [x, y, z] = PAD_DIRS[key];
  const local = new THREE.Vector3(x, y, z).applyQuaternion(part.quaternion.clone().invert());
  setLoadDir(local);
}

/** Remove the load arrow entirely. */
function clearLoad() {
  if (!loadDir) return;
  histPush();
  loadDir = null;
  loadArrowHelper.visible = false;
  updateLoadReadout();
  syncLoadUI();
}

/** Show Clear once a load is set, and light the pad button whose world direction the
 *  arrow currently points along. Stateless -- recomputed from the live pose, so the
 *  highlight clears itself when you rotate the part off that axis. */
function syncLoadUI() {
  const has = !!loadDir;
  let activeKey = null;
  if (has && part) {
    const w = loadDir.clone().applyQuaternion(part.quaternion);
    for (const [key, [x, y, z]] of Object.entries(PAD_DIRS)) {
      if (w.x * x + w.y * y + w.z * z > 0.999) { activeKey = key; break; }
    }
  }
  for (const key of Object.keys(PAD_DIRS)) {
    el(`load-${key}`).classList.toggle('active', key === activeKey);
  }
  el('load-clear').hidden = !has;
}

// ---- Lay a face flat (armed behind a button so stray clicks can't re-lay) -------

/** Arm face-lay: the next face click lays the part on that face. Modal so a click
 *  isn't swallowed by the rotate gizmo; hovering highlights the face. */
function beginLay() {
  if (!part || !topology) return;
  layPlacing = true;
  clearPreview();
  setGizmo();          // hides the rotate rings so they don't eat the pick
  syncLayUI();
}

/** Disarm face-lay (Esc / right-click / re-toggle / after a lay). */
function cancelLay() {
  layPlacing = false;
  hoverFace.visible = false;
  renderer.domElement.style.cursor = '';
  setGizmo();
  syncLayUI();
}

function syncLayUI() {
  el('lay-face').textContent = layPlacing ? '点击一个面让它贴平 — Esc 取消'
    : '以面贴平';
  el('lay-face').classList.toggle('active', layPlacing);
}

/** Upload a triangle list into the scene, or null if there is nothing to show. */
function meshFrom(tris, material) {
  if (!tris.length) return null;
  const arr = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    arr[i * 3] = tris[i][0];
    arr[i * 3 + 1] = tris[i][1];
    arr[i * 3 + 2] = tris[i][2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  scene.add(m);
  return m;
}

/**
 * Regenerate the fins for the current orientation. Fins live in PRINT space
 * (already rotated and seated), not in the part's local frame, so they are added
 * to the scene rather than parented to the part.
 */
// Support generation used to run inline on the main thread, which froze the whole
// page (orbit, buttons, sliders) for however long a build took -- a couple of
// seconds on a large or badly-posed part. buildFins is pure mesh math with no
// DOM/three.js dependency, so it runs in a Worker instead (web/finworker.js): the
// current fins stay on screen, greyed, while the new ones compute, and the UI
// stays live. A generation counter drops the reply from a pose that has since
// been superseded, and if a Worker can't be created (e.g. the page was opened
// from file://) it falls back to building inline.
let finWorker;               // undefined = not tried yet, null = unavailable, else a Worker
let finGen = 0;              // bumped per request; a reply with a stale id is ignored
let finT0 = 0;               // start time of the in-flight build, for the readout timing
let lastOpts = null;
let finSpinnerTimer = null;  // shows the spinner only if a build runs past ~1s
let finBusy = false;         // a worker build is outstanding (used to supersede it)

// Reveal the spinner only for builds that actually run long, so a sub-second
// rebuild never flashes it. Cleared the moment the build lands (applyBuilt).
function armSpinner() {
  clearTimeout(finSpinnerTimer);
  // Short delay so a quick build never shows it at all; the 0.5s CSS fade-in (the
  // .show class) then eases it on rather than snapping. The spinner is always in
  // the layout, so toggling the class transitions reliably every time -- the
  // earlier display:none/hidden toggle skipped the fade unpredictably.
  finSpinnerTimer = setTimeout(() => el('spinner').classList.add('show'), 300);
}
function clearSpinner() {
  clearTimeout(finSpinnerTimer);
  finSpinnerTimer = null;
  el('spinner').classList.remove('show');
}

function finOpts() {
  return { mode: finMode === 'draw' ? 'prop' : finMode,
           bedPad: el('bed-pad').checked,
           tines: el('tines').checked,
           tineDensity: el('tine-density').valueAsNumber / 100,
           layerHeight: el('layer-height').valueAsNumber,
           coverage: el('coverage').valueAsNumber / 100 };
}

function makeFinWorker() {
  const w = new Worker(new URL('./finworker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    if (e.data.id !== finGen) return;              // a newer pose already superseded this build
    finBusy = false;
    if (e.data.error) {                            // worker failed -- build inline so support still appears
      applyBuilt(buildFins(topology, lastResult, rotM3.elements, lastOpts));
      return;
    }
    applyBuilt(e.data.built);
  };
  // A worker-level error must not leave the UI wedged (spinner up, fins greyed):
  // drop to inline for next time and release the in-flight state now.
  w.onerror = () => { finWorker = null; finBusy = false; clearSpinner(); };
  return w;
}

function getFinWorker() {
  if (finWorker === undefined) {
    try { finWorker = makeFinWorker(); } catch { finWorker = null; }
  }
  return finWorker;
}

// Abandon an in-flight build when a newer pose arrives. Without this, rapid pose
// changes (Suggest → lay flat → rotate) queued 2-3 slow builds behind each other
// in the single worker, so the fresh result only landed many seconds later --
// the spinner looked stuck and the stale fins lingered. Terminating discards the
// running + queued work so only the latest pose computes.
function supersedeBuild() {
  if (finBusy && finWorker) { finWorker.terminate(); finWorker = undefined; }
  finBusy = false;
}

function refreshFins() {
  if (!finsVisible || !lastResult || !topology) {
    supersedeBuild();                  // no build wanted now: drop any in-flight one so it can't re-add fins
    clearSpinner();
    for (const m of [finMesh, padMesh]) { if (m) { scene.remove(m); m.geometry.dispose(); } }
    finMesh = padMesh = null;
    finTris = padTris = [];
    clearPreview();
    rebuildDrawn();
    updateReadout(null);
    return;
  }

  finT0 = performance.now();
  lastOpts = finOpts();
  supersedeBuild();                    // discard any older in-flight pose before starting this one
  const worker = getFinWorker();
  if (!worker) {                       // no worker available: build inline (old behaviour)
    for (const m of [finMesh, padMesh]) { if (m) { scene.remove(m); m.geometry.dispose(); } }
    finMesh = padMesh = null;
    finTris = padTris = [];
    applyBuilt(buildFins(topology, lastResult, rotM3.elements, lastOpts));
    return;
  }

  // Leave the current fins on screen (greyed) until the fresh build lands, so the
  // viewport never blanks mid-recalc. markFinsStale also shows "generating supports…";
  // the spinner joins it only if the build runs past the arm delay.
  finGen++;
  finBusy = true;
  markFinsStale();
  armSpinner();

  // inside.js caches its spatial grid on topology._insideGrid, and that grid holds
  // a CLOSURE (`cell`) which structured-clone cannot copy. The grid only exists
  // once something has queried the part on the main thread -- which Suggest
  // orientation does -- so before that postMessage(topology) worked and after it
  // threw DataCloneError, leaving the build wedged. Send a shallow copy without
  // the cache (the worker rebuilds its own grid), and if a clone ever fails
  // anyway, build inline so the UI can never get stuck waiting on a reply.
  const topoMsg = { ...topology };
  delete topoMsg._insideGrid;
  try {
    worker.postMessage({ id: finGen, topology: topoMsg, result: lastResult, rot: rotM3.elements, opts: lastOpts });
  } catch (err) {
    console.warn('support worker postMessage failed; building inline', err);
    finBusy = false;
    for (const m of [finMesh, padMesh]) { if (m) { scene.remove(m); m.geometry.dispose(); } }
    finMesh = padMesh = null;
    finTris = padTris = [];
    applyBuilt(buildFins(topology, lastResult, rotM3.elements, lastOpts));
  }
}

// Turn a finished buildFins result into meshes + readout. Shared by the worker
// reply and the inline fallback. buildFins runs in BOTH modes: in Suggest it
// places the walls; in Draw it is called only for the bed pad + seating verdict
// (a tilted part rests on an edge and needs a pad however its walls are placed,
// and that logic lives in fins.js), so Draw ignores the suggested walls and shows
// the hand-drawn ones instead.
function applyBuilt(built) {
  finBusy = false;
  clearSpinner();
  for (const m of [finMesh, padMesh]) { if (m) { scene.remove(m); m.geometry.dispose(); } }
  finMesh = padMesh = null;
  finTris = padTris = [];
  // Undo the grey markFinsStale applied to the shared materials.
  finMaterial.transparent = padMaterial.transparent = false;
  finMaterial.opacity = padMaterial.opacity = 1;

  lastBuilt = built;
  padTris = built.padTriangles;
  padMesh = meshFrom(padTris, padMaterial);

  if (finMode === 'draw') {
    rebuildDrawn();
  } else {
    clearPreview();
    finTris = built.triangles;
    finMesh = meshFrom(finTris, finMaterial);
    // In Suggest, also (re)build any hand-drawn walls layered on top. rebuildDrawn
    // self-gates on drawShown(), so it clears them when none apply.
    rebuildDrawn();
  }
  updateReadout(built, performance.now() - finT0);
  updateFit();
}

/**
 * Stabilize mode does NOT claim to serve every overhang -- it claims to keep a
 * tilted part standing. So the readout reports the fins AND what is still red,
 * rather than implying the red went away. Overstating this is how a tool loses
 * someone on their first print.
 */
/** Grey the fins while a drag is in flight, so nothing on screen is a lie. */
function markFinsStale() {
  for (const m of [finMesh, padMesh, drawnMesh]) if (m) m.material.opacity = 0.25;
  finMaterial.transparent = padMaterial.transparent = drawMaterial.transparent = true;
  el('s-fins').textContent = '正在生成支撑…';
}

// Grams use the selected material's density (materialDensity, set by applyMaterial),
// so the number is honest rather than pretending to be machine truth.

/** Signed volume of a closed triangle-soup, mm^3. Fins and pad are closed solids. */
function meshVolumeMM3(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    v += a[0] * (b[1] * c[2] - b[2] * c[1])
       - a[1] * (b[0] * c[2] - b[2] * c[0])
       + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return Math.abs(v) / 6;
}

const fmtGrams = (g) => (g < 9.95 ? g.toFixed(1) : String(Math.round(g)));

/**
 * The "what did this actually get me" receipt. The headline -- the mass of
 * breakaway support the tool adds -- is EXACT (we generate that geometry, and
 * this volume was cross-checked against buildFins' own wall volume). It ticks as
 * you re-orient, so a better pose visibly costs less support.
 *
 * The saving vs. the slicer's own supports is deliberately NOT computed per part:
 * we can't slice in the browser, and a made-up "you saved 5.2 g" is exactly what
 * loses trust on the first print. Instead the sub-line states the MEASURED result
 * from the test prints (see video notes), which is a claim we can stand behind.
 */
function updateReceipt() {
  const box = el('receipt');
  const added = activeAdded();
  if (!finsVisible || !added.length) { box.hidden = true; return; }
  const grams = meshVolumeMM3(added) * materialDensity / 1000;
  el('r-grams').textContent = `${fmtGrams(grams)} g`;
  box.hidden = false;
}

/** Route the readout to the active mode. */
function updateReadout(built, ms) {
  if (finMode === 'draw') updateDrawReadout(built, ms);
  else updateFinReadout(built, ms);
  updateReceipt();
}

/**
 * Two audiences, two homes. `lead` is the short, must-see stuff -- a support that
 * couldn't build, a part balanced on a point -- and stays in the status panel.
 * `detail` is the how-it-works / how-to-fix text, which reads as a wall when it's
 * always on, so it's tucked behind the (i) on the Fins row where a curious user
 * can hover for it. Either can be empty.
 */
function setFinNote(lead, detail) {
  el('s-fin-note').textContent = lead.length ? lead.join('；') + '。' : '';
  const info = el('s-fin-info');
  const text = detail.filter(Boolean).join('');
  if (text) { info.title = text; info.hidden = false; }
  else { info.title = ''; info.hidden = true; }
}

/**
 * Draw mode's readout. Reports the breakaway WALLS the user drew by hand (a wall
 * per line, straight onto the overhang), plus the pad/seating verdict from
 * buildFins. When a drawn wall can't build it says WHY -- silence-as-success is
 * the exact bug M5's scoreboard was built on.
 */
function updateDrawReadout(built, ms) {
  finMaterial.transparent = padMaterial.transparent = drawMaterial.transparent = false;
  finMaterial.opacity = padMaterial.opacity = drawMaterial.opacity = 1;
  const box = el('s-fins');
  el('s-pad').textContent = built?.pad ? '已添加' : built ? '不需要' : '—';

  const ok = drawnWalls.filter((w) => w.ok);
  const bad = drawnWalls.length - ok.length;
  const tines = ok.reduce((a, w) => a + (w.info?.tines ?? 0), 0);
  box.textContent = ok.length
    ? `${ok.length} 段手绘支撑墙` + (tines ? ` · ${tines} 个卡齿` : '')
    : '暂无';
  box.classList.toggle('warn', ok.length === 0);

  const lead = [];
  const help = [];
  if (!drawnWalls.length && !drawMsg) {
    lead.push('在悬垂上点两个点（连线会正好落在你画的位置，红色面也一样），'
      + '就能在它下方铺出一段可掰断的支撑墙');
  }
  if (ok.length) {
    help.push(tines
      ? '卡齿会咬住零件，掰下支撑墙时随之弯断，不会留下毛刺。'
      : '每段墙都在零件下方停住，留 0.2mm 间隙，掰断更干净。'
        + '想让它咬住零件，请开启“卡齿”。');
  }
  if (bad) {
    const one = drawnWalls.find((w) => !w.ok);
    lead.push(`${bad} 段支撑墙在这里无法生成`
      + `${one?.info?.reason ? `（${one.info.reason}）` : ''}，请撤销或重画`);
  }
  if (drawMsg) lead.push(drawMsg);
  if (built?.seating?.kind === 'point') {
    lead.push(built.pad
      ? '零件只靠一点平衡，目前是底盘垫在支撑它，请保持底盘垫开启后再打印'
      : '零件只靠一点平衡。请开启底盘垫把它固定住，或旋转到让它稳稳坐下');
  }
  setFinNote(lead, help);
  if (ms != null) el('s-time').textContent = `${analysisTiming} · 底盘垫 ${ms.toFixed(0)} ms`;
}

function updateFinReadout(built, ms) {
  finMaterial.transparent = padMaterial.transparent = false;
  finMaterial.opacity = padMaterial.opacity = 1;
  const box = el('s-fins');
  if (!built) {
    box.textContent = '—';
    box.classList.remove('warn');
    el('s-pad').textContent = '—';
    setFinNote([], []);
    return;
  }
  el('s-pad').textContent = built.pad ? '已添加' : '不需要';
  const n = built.fins.length;
  const kind = built.mode === 'prop' ? 'prop' : 'fin';
  // Hand-added walls (Suggest + Draw mix) count toward the tally too.
  const drawnOk = drawShown() ? drawnWalls.filter((w) => w.ok).length : 0;
  let autoTxt;
  if (built.mode === 'auto') {
    // Named apart so the readout is honest: the support fins sit on the overhangs
    // (tined when the toggle is on), the props are the fallback under ledges too
    // flat to take a fin. "N fins" alone would hide which is which.
    const p = built.propCount, b = built.braceCount;
    const seg = [];
    if (b) seg.push(`${b} 个支撑鳍` + (built.tines ? ` · ${built.tines} 个卡齿` : ''));
    if (p) seg.push(`${p} 个支撑柱`);
    autoTxt = seg.join(' + ');
  } else {
    autoTxt = n
      ? `${n} 个${kind === 'prop' ? '支撑柱' : '支撑鳍'}`
        + (built.mode === 'prop' || !built.tines ? '' : ` · ${built.tines} 个卡齿`)
      : '';
  }
  const drawnTxt = drawnOk ? `${autoTxt ? ' + ' : ''}手绘 ${drawnOk} 段` : '';
  box.textContent = (autoTxt + drawnTxt) || '无法放置';
  box.classList.toggle('warn', n === 0 && !drawnOk);

  // `lead` = short + must-see, stays in the panel; `help` = how-it-works and
  // how-to-fix, goes behind the (i). Split so the panel doesn't read as a wall.
  const lead = [];
  const help = [];
  if (!n && !drawnOk) {
    // Nothing placed -- the box already says "none possible"; the why goes in the
    // (i), since it's a paragraph and the user can hover for it.
    help.push(explainNoFins(built));
  } else if (n) {
    if (built.mode === 'auto') {
      // Make "why no tines" legible: props never take tines, only the gripping
      // fins do, so a part that gets only props shows no tines and that's correct.
      const b = built.braceCount, p = built.propCount;
      if (b) {
        help.push(built.tines
          ? '卡齿会咬住零件，掰下支撑时随之弯断，不会留下毛刺。'
          : '支撑鳍与零件之间留了 0.2mm 间隙，可以直接掰下。想让它抓附零件请开启“卡齿”。');
      }
      if (p && !b) {
        help.push('这些是普通支撑柱，不是带抓附的支撑鳍。这里的悬垂太平缓或太弯曲，'
          + '立不住支撑鳍，所以没有卡齿可加。');
      } else if (p) {
        help.push(`这 ${p} 个支撑柱位于过浅、无法咬合的悬垂下方，因此不带卡齿。`);
      }
    } else if (built.mode === 'prop') {
      help.push('每个支撑柱都在零件下方留 0.2mm 间隙，可以直接掰下，无需剪钳。');
    }
  }
  if (drawnOk) {
    lead.push(`另外还有你手动添加的 ${drawnOk} 段支撑墙`);
  }
  // Hand-placement feedback has to surface here too (Suggest + Draw mix), or a
  // rejected wall fails silently -- the same silence-as-success trap as M5. This
  // one is an interactive failure, so it stays visible, not behind the (i).
  if (drawShown()) {
    const bad = drawnWalls.length - drawnOk;
    if (bad) {
      const one = drawnWalls.find((w) => !w.ok);
      lead.push(`${bad} 段手绘支撑墙无法附着在这里`
              + (one?.info?.reason ? `（${one.info.reason}）` : ''));
    }
    if (drawMsg) lead.push(drawMsg);
  }
  // Worth saying even when something WAS placed: a point-balanced part is
  // standing on the added pad and nothing else, so the pad is load-bearing,
  // not cosmetic. Must-see -> stays visible.
  if (n && built.seating?.kind === 'point') {
    lead.push(built.pad
      ? '零件只靠一点平衡，目前是底盘垫在支撑它，请保持底盘垫开启后再打印'
      : '零件只靠一点平衡，下方再无其他支撑。请开启底盘垫，或旋转到让它稳稳坐下');
  }
  if (built.sagRisk) {
    // The coverage slider is left of centre, so a broad flat overhang got rows
    // spaced wider than the 12mm anti-sag guide. That's allowed on purpose (fewer
    // supports), but the plate can bow between them -- must-see, so it's in the
    // panel, not behind the (i).
    lead.push('覆盖密度低于防下垂建议值，大悬垂面可能在支撑之间下垂 '
            + '—— 如果表面出现弯曲，把滑块往右移一点');
  }
  if (built.unserved) {
    // An un-served ledge is a shallow overhang with no room for a prop and too
    // flat to stand a fin against. The fix (tilt steeper) is a sentence, so it
    // rides in the (i) rather than the panel.
    help.push(`${built.unserved} 处悬垂在当前朝向下太平缓，立不住支撑鳍。`
            + '把零件倾斜得更陡，让支撑鳍能贴着它生长（可试“推荐摆放方向”），'
            + '或者手动添加一段支撑墙。');
  }
  if (built.skipped?.bore) {
    // A support standing INSIDE a bore or slot scars a surface you can't clean --
    // worse than a little sag. The tool refuses those on purpose; the honest fix
    // is to rotate the hole so it faces out and prints clean with no support.
    const b = built.skipped.bore;
    help.push(`有 ${b} 处悬垂位于内孔或槽内，在那里放支撑会留下你够不到的痕迹。`
            + `工具刻意不处理它们：把孔转到朝上，就能干净地打印出来。`);
  }
  setFinNote(lead, help);
  // ms is absent when a hand-drawn wall (Suggest + Draw mix) re-runs the readout
  // without rebuilding the auto fins -- don't touch the timing line then, and
  // never throw, or the updateReceipt() call after this one never happens.
  if (ms != null) el('s-time').textContent = `${analysisTiming} · 支撑 ${ms.toFixed(0)} ms`;
}

/** Show the Draw controls (hint + Undo/Clear) only while hand-placement is live,
 *  and word the hint for what the click does: a support fin in Draw, a two-point
 *  wall in the Suggest "+ Add" augment. */
function syncDrawControls() {
  el('draw-controls').hidden = !drawShown();
  el('draw-hint').innerHTML = '在悬垂上点<strong>两个点</strong>'
    + '（直接点在红色面上）即可沿这条线铺出一段可掰断的支撑墙。'
    + '按 <kbd>Esc</kbd> 或右键可取消。';
}

/** The "+ Add walls by hand" toggle, shown only in Suggest mode. */
function syncAugmentUI() {
  const show = finsVisible && finMode === 'auto';
  el('augment-toggle').hidden = !show;
  el('augment-toggle').classList.toggle('primary', drawAugment);
  el('augment-toggle').textContent = drawAugment ? '完成添加' : '+ 手动添加支撑墙';
}

el('fin-mode').addEventListener('change', (e) => {
  histPush();
  finMode = e.target.value;
  el('coverage-fld').hidden = finMode !== 'auto';  // row density only applies to Auto
  drawAugment = false;      // start each mode with hand-placement off
  drawMsg = '';
  clearPreview();
  syncAugmentUI();
  syncDrawControls();
  setGizmo();
  refreshFins();
});
el('bed-pad').addEventListener('change', refreshFins);
// A slider fires `input` on every pixel of a drag; on a big part one regenerate can
// take a while, so re-running it per tick freezes the page mid-drag. Coalesce the
// drag into a single rebuild once the value settles. `change` (fires on release) is
// too coarse -- no live preview at all -- so debounce instead: quick enough to feel
// live on a small part, one rebuild instead of dozens on a large one.
let refreshTimer = null;
function debouncedRefresh(ms = 180) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshFins(); }, ms);
}
// Tine grip only means anything when the tines are on, so hide its slider with the
// toggle (keeps the panel honest -- no dead control).
// Tine grip + layer height only matter when Tines is on -- hide both otherwise.
function syncTineGrip() {
  const on = el('tines').checked;
  el('tinegrip-fld').hidden = !on;
  el('layerh-fld').hidden = !on;
}
el('tines').addEventListener('change', () => { syncTineGrip(); refreshFins(); });
el('tine-density').addEventListener('input', () => debouncedRefresh());
el('layer-height').addEventListener('input', () => debouncedRefresh());
el('coverage').addEventListener('input', () => debouncedRefresh());
syncTineGrip();

// Gap tuning. PROP.gap / PAD.grab are read fresh on every build, so setting them
// here and rebuilding is all it takes. Clamp to the input's own range so a typed
// value can't drive the support into the part or float it off the overhang.
function wireGap(id, obj, key, lo, hi) {
  const input = el(id);
  input.addEventListener('input', () => {
    const v = input.valueAsNumber;
    if (Number.isFinite(v)) { obj[key] = Math.min(hi, Math.max(lo, v)); debouncedRefresh(); }
  });
}
wireGap('gap', PROP, 'gap', 0.1, 0.4);
wireGap('pad-grip', PAD, 'grab', -0.2, 0.3);

// Material profiles. PETG welds to a support far harder than the PLA every bite
// number here was tuned on, so PETG needs more clearance in all four places at
// once: the fin's tine standoff (FIN.gap) and how far each tine sinks into the
// part (FIN.tineBite), the plain breakaway prop's clearance (PROP.gap), and the
// bed pad -- thinner (FIN.padH) with a gap instead of a tack (PAD.grab < 0). PLA
// is exactly today's numbers, so switching to PLA (or never touching this) leaves
// existing prints unchanged. These objects are read fresh on every build, so
// applying a profile + rebuilding is all it takes. density is g/cm^3 for the
// grams receipt.
const MATERIAL = {
  pla:  { finGap: 0.2, tineBite: 0.30, padH: 0.5, padGrab:  0.05, propGap: 0.2,  density: 1.24 },
  petg: { finGap: 0.3, tineBite: 0.15, padH: 0.3, padGrab: -0.10, propGap: 0.3,  density: 1.27 },
};
let materialDensity = MATERIAL.pla.density;

function applyMaterial(name) {
  const m = MATERIAL[name] || MATERIAL.pla;
  FIN.gap = m.finGap;
  FIN.tineBite = m.tineBite;
  FIN.padH = m.padH;
  PAD.grab = m.padGrab;
  PROP.gap = m.propGap;
  materialDensity = m.density;
  // Reflect the profile's clearances in the exposed tunables so the numbers on
  // screen match what will actually print (and a later hand-tweak starts from the
  // material's baseline, not PLA's).
  el('gap').value = m.propGap;
  el('pad-grip').value = m.padGrab;
}

el('material').addEventListener('change', () => {
  applyMaterial(el('material').value);
  debouncedRefresh();
});
applyMaterial(el('material').value);   // sync density + tunables to the initial choice

/** The fins-toggle button's appearance for the current finsVisible. Factored out
 *  so undo/redo can re-sync it after restoring the flag. */
function syncFinsToggleUI() {
  el('fins-toggle').classList.toggle('primary', finsVisible);
  el('fins-toggle').textContent = finsVisible ? '支撑鳍已开' : '添加支撑鳍';
  el('fin-opts').hidden = !finsVisible;
}

el('fins-toggle').addEventListener('click', () => {
  histPush();
  finsVisible = !finsVisible;
  if (!finsVisible) drawAugment = false;
  syncFinsToggleUI();
  drawMsg = '';
  clearPreview();
  syncAugmentUI();
  syncDrawControls();
  setGizmo();
  refreshFins();
});

el('augment-toggle').addEventListener('click', () => {
  drawAugment = !drawAugment;
  drawMsg = '';
  clearPreview();
  syncAugmentUI();
  syncDrawControls();
  setGizmo();
  refreshFins();
});

// Undo/Clear act on the hand-drawn breakaway walls -- the thing both Draw and the
// Suggest "+ Add" augment now place.
el('draw-undo').addEventListener('click', () => {
  if (!drawnWalls.length) return;
  histPush();
  drawnWalls.pop();
  drawMsg = '';
  clearPreview();
  rebuildDrawn();
  updateReadout(lastBuilt);
  updateFit();
});
el('draw-clear').addEventListener('click', () => {
  if (!drawnWalls.length) return;
  histPush();
  drawnWalls = [];
  drawMsg = '';
  clearPreview();
  rebuildDrawn();
  updateReadout(lastBuilt);
  updateFit();
});

/**
 * Export the part AS ORIENTED, seated on the plate, with the fins as extra
 * solids in the same file. The whole promise of the tool is that the STL prints
 * the same way for whoever opens it, so the orientation has to be baked in --
 * exporting the original frame and hoping the user re-rotates defeats the point.
 */
/**
 * The part geometry AS ORIENTED and seated on the plate, plus the fins, kept in
 * two separate lists. STL flattens them into one solid; 3MF keeps them distinct.
 * Returns null when there is nothing to export.
 */
function transformPositions(positions, rot, dx, dy, dz) {
  const tris = new Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    tris[i / 3] = [
      rot[0] * x + rot[3] * y + rot[6] * z + dx,
      rot[1] * x + rot[4] * y + rot[7] * z + dy,
      rot[2] * x + rot[5] * y + rot[8] * z + dz,
    ];
  }
  return tris;
}

function buildExportGeometry() {
  if (!part || !topology || !lastResult) return null;
  const rot = rotM3.elements;
  const { x: dx, y: dy, z: dz } = lastResult.offset;
  const partTris = transformPositions(topology.pos, rot, dx, dy, dz);
  const meshes = sourceMeshes.map((mesh) => ({
    name: mesh.name,
    tris: transformPositions(mesh.positions, rot, dx, dy, dz),
  }));
  const finTris = [...activeAdded()];
  const base = partName.replace(/\.(stl|3mf|step|stp|iges|igs|brep)$/i, '') || 'part';
  return { partTris, meshes, finTris, base };
}

function exportFaceGroup(faces, baseName, groupIndex, sourceTopology = topology) {
  const rot = rotM3.elements;
  const { pos } = sourceTopology;
  const { x: dx, y: dy, z: dz } = lastResult.offset;
  const tris = new Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = face * 9 + vertex * 3;
      const x = pos[offset], y = pos[offset + 1], z = pos[offset + 2];
      tris[i * 3 + vertex] = [
        rot[0] * x + rot[3] * y + rot[6] * z + dx,
        rot[1] * x + rot[4] * y + rot[7] * z + dy,
        rot[2] * x + rot[5] * y + rot[8] * z + dz,
      ];
    }
  }
  return writeBinarySTL(tris, `${baseName}-part-${groupIndex + 1}`);
}

/**
 * Export the part AS ORIENTED, seated on the plate, with the fins as extra
 * solids in the same file. The whole promise of the tool is that the file prints
 * the same way for whoever opens it, so the orientation has to be baked in --
 * exporting the original frame and hoping the user re-rotates defeats the point.
 */
el('export').addEventListener('click', () => {
  const g = buildExportGeometry();
  if (!g) return;
  download(writeBinarySTL([...g.partTris, ...g.finTris], g.base), `${g.base}-fins.stl`);
});

// 3MF keeps the fins as a separate object and states millimeters, so the file
// opens correctly oriented and support-free in Bambu Studio, OrcaSlicer, or
// PrusaSlicer without a re-scale or a re-rotate.
el('export-3mf').addEventListener('click', () => {
  const g = buildExportGeometry();
  if (!g) return;
  download(writeThreeMF(g.meshes, g.finTris, g.base), `${g.base}-fins.3mf`);
});

async function splitSelectedMeshes() {
  if (!selectedMeshIndices.size || !topology || !lastResult) return;
  try {
    const files = [];
    for (const meshIndex of [...selectedMeshIndices].sort((a, b) => a - b)) {
      const mesh = sourceMeshes[meshIndex];
      const meshTopology = buildTopology({ getAttribute: () => ({ array: mesh.positions }) });
      const groups = connectedFaceComponents(meshTopology);
      const base = String(mesh.name || partName).split(/[\\/]/).pop()
        .replace(/\\.[^.]+$/, '').replace(/[<>:"/\\|?*\\x00-\\x1f]/g, '-') || 'part';
      for (const group of groups) {
        const blob = exportFaceGroup(group, base, files.length, meshTopology);
        files.push({
          name: `${String(files.length + 1).padStart(3, '0')}-${base}.stl`,
          data: new Uint8Array(await blob.arrayBuffer()),
        });
      }
    }
    if (selectedMeshIndices.size === 1 && files.length < 2) {
      alert('所选网格只有一个连通零件，无需拆分。');
      return;
    }
    if (!files.length) {
      alert('所选网格没有可拆分的三角面。');
      return;
    }
    download(zipStore(files), `${partName.replace(/\\.[^.]+$/, '') || '模型'}-选中网格拆分.zip`);
  } catch (error) {
    console.error('selected mesh split failed', error);
    alert(`拆分失败：${error.message}`);
  }
}

function exportSelectedMeshes3MF() {
  if (selectedMeshIndices.size < 2 || !lastResult) return;
  const { x: dx, y: dy, z: dz } = lastResult.offset;
  const meshes = [...selectedMeshIndices].sort((a, b) => a - b).map((index) => ({
    name: sourceMeshes[index].name,
    tris: transformPositions(sourceMeshes[index].positions, rotM3.elements, dx, dy, dz),
  }));
  const base = `${partName.replace(/\\.[^.]+$/, '') || '模型'}-选中网格组合`;
  download(writeThreeMF(meshes, [], base), `${base}.3mf`);
}

el('split-components').addEventListener('click', async () => {
  if (!part || !topology || !lastResult) return;
  const groups = connectedFaceComponents(topology);
  if (groups.length < 2) {
    alert('当前模型只有一个连通零件，无需拆分。');
    return;
  }

  const button = el('split-components');
  button.disabled = true;
  button.textContent = '正在拆分…';
  try {
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      const blob = exportFaceGroup(groups[i], partName.replace(/\.[^.]+$/, '') || 'part', i);
      files.push({
        name: `${String(i + 1).padStart(3, '0')}-part.stl`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    download(zipStore(files), `${partName.replace(/\.[^.]+$/, '') || 'part'}-拆分零件.zip`);
  } catch (error) {
    console.error('component split failed', error);
    alert(`拆分失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '拆分独立零件 ZIP';
  }
});

// ------------------------------------------------------------- undo / redo
// A snapshot stack, not a command log. Mesh edits store only selected mesh positions;
// restoring either kind re-runs the same analysis and support rebuild. Every mutation
// calls histPush() first;
// undo/redo swap snapshots between the two stacks.
let undoStack = [];
let redoStack = [];

function snapshot(meshIndices = [], includeMeshStructure = false) {
  const q = part.quaternion;
  return {
    quat: [q.x, q.y, q.z, q.w],
    walls: drawnWalls.map((w) => ({ a: w.a.clone(), b: w.b.clone() })),
    load: loadDir ? loadDir.clone() : null,
    finMode, finsVisible, drawAugment,
    selection: [...selectedMeshIndices],
    hiddenMeshes: [...hiddenMeshIndices],
    meshStructure: includeMeshStructure ? sourceMeshes.slice() : null,
    meshEdits: meshIndices.map((index) => ({ index, positions: sourceMeshes[index].positions.slice() })),
  };
}

/** Capture state BEFORE a mutation. A fresh action invalidates the redo stack. */
function histPush(meshIndices = [], includeMeshStructure = false) {
  if (!part) return;
  undoStack.push(snapshot(meshIndices, includeMeshStructure));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  syncHistButtons();
}

function restoreState(s) {
  part.quaternion.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3]);
  hiddenMeshIndices = new Set(s.hiddenMeshes || []);
  selectedMeshIndices = new Set(s.selection || []);
  if (s.meshStructure) {
    sourceMeshes = s.meshStructure.slice();
    rebuildPartMeshes();
  } else if (s.meshEdits?.length) {
    const positions = part.geometry.getAttribute('position').array;
    for (const { index, positions: saved } of s.meshEdits) {
      sourceMeshes[index].positions.set(saved);
      sourceMeshes[index].bounds = boundsForPositions(sourceMeshes[index].positions);
      positions.set(saved, meshFaceRanges[index].start * 9);
    }
    rebuildMeshAnalysis();
  } else {
    applyMeshVisibility();
  }
  drawnWalls = s.walls.map((w) => ({ a: w.a.clone(), b: w.b.clone(), ok: false, info: null }));
  loadDir = s.load ? s.load.clone() : null;
  layPlacing = false;
  controls.enabled = true;
  updateLoadArrowMesh();
  syncLoadUI();
  finMode = s.finMode;
  finsVisible = s.finsVisible;
  drawAugment = s.drawAugment ?? false;
  drawStart = null;
  clearPreview();
  // Re-sync every control that mirrors the restored state, then rebuild the
  // scene the same way a normal edit would.
  el('fin-mode').value = finMode;
  syncFinsToggleUI();
  syncAugmentUI();
  syncDrawControls();
  setGizmo();
  el('rot-delta').textContent = '';
  hideSuggestions();
  shade();
  refreshFins();
  updateMeshSelectionStatus();
  syncHistButtons();
}

function undo() {
  if (!undoStack.length) return;
  if (meshEditActive && !gizmo.dragging) leaveMeshEdit(false);
  const state = undoStack.pop();
  redoStack.push(snapshot((state.meshEdits || []).map(({ index }) => index), !!state.meshStructure));
  restoreState(state);
}

function redo() {
  if (!redoStack.length) return;
  if (meshEditActive && !gizmo.dragging) leaveMeshEdit(false);
  const state = redoStack.pop();
  undoStack.push(snapshot((state.meshEdits || []).map(({ index }) => index), !!state.meshStructure));
  restoreState(state);
}

function syncHistButtons() {
  el('undo').disabled = !undoStack.length;
  el('redo').disabled = !redoStack.length;
}

el('undo').addEventListener('click', undo);
el('redo').addEventListener('click', redo);

// Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes. Ignored while typing
// in a field so it never eats a text-edit undo.
// Hotkeys, 3ds Max style: Q select, W move, E rotate, R scale; Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo.
// Shared by this window's own keydown and by keys the file manager forwards when focus is
// outside the iframe (side panel, back button), so Ctrl+Z works wherever the user last clicked.
let hotkeyHintTimer = null;
function flashStatus(text) {
  meshSelectionStatus.textContent = text;
  clearTimeout(hotkeyHintTimer);
  hotkeyHintTimer = setTimeout(updateMeshSelectionStatus, 1800);
}

function enterSelectMode() {
  if (measureActive) setMeasureMode(false);
  if (meshEditActive) leaveMeshEdit();
  if (boxSelectActive) toggleBoxSelect();
}

function enterTransformMode(mode) {
  if (!selectedMeshIndices.size) { flashStatus('请先选择网格（Q 选择，单击或框选）'); return; }
  if (measureActive) setMeasureMode(false);
  startMeshEdit(mode);
}

/** @returns {boolean} true when the key was consumed. */
function handleHotkey(key, ctrl, shift) {
  if (!part) return false;
  const k = String(key).toLowerCase();
  if (ctrl) {
    if (k === 'z') { shift ? redo() : undo(); return true; }
    if (k === 'y') { redo(); return true; }
    return false;
  }
  if (gizmo.dragging || boxSelectionDrag) return false;
  if (k === 'q') { enterSelectMode(); return true; }
  if (k === 'w') { enterTransformMode('translate'); return true; }
  if (k === 'e') { enterTransformMode('rotate'); return true; }
  if (k === 'r') { enterTransformMode('scale'); return true; }
  return false;
}

addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.isComposing) return;
  if (e.altKey || (!(e.metaKey || e.ctrlKey) && e.shiftKey)) return;
  if (handleHotkey(e.key, e.metaKey || e.ctrlKey, e.shiftKey)) e.preventDefault();
});

addEventListener('message', (event) => {
  if (window.parent === window || event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'collabo:key' || typeof data.key !== 'string') return;
  handleHotkey(data.key, !!data.ctrl, !!data.shift);
});

// ---------------------------------------------------------------- orientation

/** Rotate 90 degrees about a world axis, keeping the part seated. */
function rotate90(name, axis) {
  if (!part) return;
  histPush();
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2);
  part.quaternion.premultiply(q);   // premultiply = about the WORLD axis
  showDelta(name.toUpperCase(), Math.PI / 2);
  shade();
}

/**
 * Click a face to lay it flat on the plate. This is the fastest way to reach a
 * sane orientation -- far quicker than hunting for it on the rings -- and it is
 * how you actually think about the problem: "put THAT face down".
 */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const DOWN = new THREE.Vector3(0, 0, -1);
const layQuat = new THREE.Quaternion();
const faceNormal = new THREE.Vector3();
let pressAt = null;

/**
 * The hovered face, drawn as a single highlighted triangle. Without this,
 * click-to-lay is invisible: nothing on screen suggests the part is clickable,
 * so a first-time user never discovers the fastest control in the app.
 * Parented to the part so it inherits the orientation for free.
 */
const hoverGeom = new THREE.BufferGeometry();
hoverGeom.setAttribute(
  'position', new THREE.BufferAttribute(new Float32Array(9), 3));
const hoverFace = new THREE.Mesh(hoverGeom, new THREE.MeshBasicMaterial({
  color: 0x4da3ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
  depthTest: true, polygonOffset: true,
  polygonOffsetFactor: -4, polygonOffsetUnits: -4,
}));
hoverFace.visible = false;
hoverFace.renderOrder = 1;

/** Ray the pointer into the part; returns the intersection or null. */
function pickFace(ev) {
  if (!part || !topology) return null;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1,
              -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(part, false);
  return hits.find((hit) => hit.faceIndex != null && !hiddenMeshIndices.has(meshIndexForFace(hit.faceIndex, meshFaceRanges))) || null;
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (measureActive) { hoverFace.visible = false; return; }
  // Draw / Suggest "+ Add": the pointer places wall endpoints ON the overhang, so
  // face-lay hover is off and the cursor / band / ghost track the surface instead.
  // Draw picks ANY surface point the user aims at -- including the red overhang
  // faces themselves -- because a drawn breakaway wall sweeps under the line you
  // draw, wherever you draw it; there is no "grippable face" gate to fight.
  if (drawActive()) {
    hoverFace.visible = false;
    const hit = pickFace(ev);
    if (hit) {
      updatePreview(hit.point);
      renderer.domElement.style.cursor = 'crosshair';
    } else {
      drawCursor.visible = drawBand.visible = false;
      if (ghostMesh) { scene.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
      renderer.domElement.style.cursor = '';
    }
    return;
  }
  // Face-lay hover ONLY while armed: ordinary clicks select a mesh and never
  // change the part's orientation.
  if (!layActive() || !part || gizmo.dragging || gizmo.axis || pressAt) {
    hoverFace.visible = false;
    return;
  }
  const hit = pickFace(ev);
  hoverFace.visible = !!hit;
  hoverFace.material.color.setHex(0x4da3ff);   // reset from Draw's green/grey tint
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  if (!hit) return;

  const pos = hoverGeom.getAttribute('position');
  const src = part.geometry.getAttribute('position').array;
  const o = hit.faceIndex * 9;
  for (let i = 0; i < 9; i++) pos.array[i] = src[o + i];
  pos.needsUpdate = true;
  hoverGeom.computeBoundingSphere();
});

renderer.domElement.addEventListener('pointerleave', () => {
  hoverFace.visible = false;
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  // Plain left-drag orbits the view. Box selection is Ctrl/Shift + left-drag (additive),
  // so the two gestures never share a mode; the old toggle button is kept only as a lock.
  const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
  if (e.button !== 0 || drawActive() || layActive() || measureActive) return;
  if (!boxSelectActive && !modifier) return;
  if (!boxSelectActive && gizmo.axis) return;      // pointer is on a gizmo handle: let it drag
  boxSelectionDrag = { x: e.clientX, y: e.clientY, additive: modifier };
  controls.enabled = false;
  selectionRect.hidden = false;
  selectionRect.style.left = `${e.clientX}px`;
  selectionRect.style.top = `${e.clientY}px`;
  selectionRect.style.width = '0px';
  selectionRect.style.height = '0px';
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!boxSelectionDrag) return;
  const left = Math.min(boxSelectionDrag.x, e.clientX);
  const top = Math.min(boxSelectionDrag.y, e.clientY);
  selectionRect.style.left = `${left}px`;
  selectionRect.style.top = `${top}px`;
  selectionRect.style.width = `${Math.abs(e.clientX - boxSelectionDrag.x)}px`;
  selectionRect.style.height = `${Math.abs(e.clientY - boxSelectionDrag.y)}px`;
  e.stopImmediatePropagation();
}, true);

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!boxSelectionDrag) return;
  const drag = boxSelectionDrag;
  boxSelectionDrag = null;
  selectionRect.hidden = true;
  controls.enabled = !gizmo.dragging;
  const rect = {
    left: Math.min(drag.x, e.clientX), right: Math.max(drag.x, e.clientX),
    top: Math.min(drag.y, e.clientY), bottom: Math.max(drag.y, e.clientY),
  };
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
    selectMeshesInRect(rect, drag.additive);
  } else {
    const hit = pickFace(e);
    const index = hit ? meshIndexForFace(hit.faceIndex, meshFaceRanges) : -1;
    if (index >= 0) setMeshSelection(drag.additive && selectedMeshIndices.has(index)
      ? [...selectedMeshIndices].filter((item) => item !== index)
      : drag.additive ? [...selectedMeshIndices, index] : [index]);
    else if (!drag.additive) setMeshSelection([]);
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

renderer.domElement.addEventListener('pointercancel', () => {
  if (!boxSelectionDrag) return;
  boxSelectionDrag = null;
  selectionRect.hidden = true;
  controls.enabled = !gizmo.dragging;
}, true);

renderer.domElement.addEventListener('pointerdown', (e) => {
  pressAt = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  const from = pressAt;
  pressAt = null;
  if (!from || !part || !topology) return;

  // a drag is an orbit, not a pick
  if (e.button !== 0 || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;

  if (measureActive) { handleMeasureClick(e); return; }

  // Draw / Suggest "+ Add": first click sets the start of a wall on the overhang,
  // second commits it. A breakaway wall sweeps under the line between the two
  // points, so the user draws it straight onto the red overhang -- no face gate.
  if (drawActive()) {
    const hit = pickFace(e);
    if (!hit) return;
    if (!drawStart) {
      drawStart = part.worldToLocal(hit.point.clone());
      drawMsg = '';
      updatePreview(hit.point);
      updateReadout(lastBuilt);
    } else {
      placeSecondPoint(hit.point);
    }
    return;
  }

  if (gizmo.dragging || gizmo.axis) return;

  const hit = pickFace(e);
  if (!layActive()) {
    const index = hit ? meshIndexForFace(hit.faceIndex, meshFaceRanges) : -1;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (index >= 0) setMeshSelection(additive && selectedMeshIndices.has(index)
      ? [...selectedMeshIndices].filter((item) => item !== index)
      : additive ? [...selectedMeshIndices, index] : [index]);
    else if (!additive) setMeshSelection([]);
    return;
  }
  if (!hit) return;

  // Snapshot before laying so Ctrl-Z brings the old pose back.
  histPush();
  // Use OUR winding-derived normal, not the STL's stored one, for the same
  // reason the analysis does: exported normals are not trustworthy.
  const i = hit.faceIndex * 3;
  faceNormal.set(topology.nrm[i], topology.nrm[i + 1], topology.nrm[i + 2])
            .applyQuaternion(part.quaternion);
  layQuat.setFromUnitVectors(faceNormal, DOWN);
  part.quaternion.premultiply(layQuat);
  cancelLay();            // one-shot: disarm after a lay so the next click is safe
  shade();
});

// Escape closes menus / selection mode, or cancels an armed tool.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!meshContextMenu.hidden) { closeMeshContextMenu(); return; }
  if (measureActive) {
    if (measurePending) resetMeasurePending();
    else setMeasureMode(false);
    return;
  }
  if (boxSelectionDrag) {
    boxSelectionDrag = null;
    selectionRect.hidden = true;
    controls.enabled = !gizmo.dragging;
    return;
  }
  if (meshEditActive && !gizmo.dragging) { leaveMeshEdit(); return; }
  if (boxSelectActive) { toggleBoxSelect(); return; }
  if (layActive()) { cancelLay(); return; }
  if (drawActive() && drawStart) {
    clearPreview();
    updateReadout(lastBuilt);
  }
});
// Right-drag pans (OrbitControls). Windows still fires `contextmenu` when that drag is
// released, so only a right CLICK -- not a pan -- may open the mesh menu.
let rightPressAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2) rightPressAt = { x: e.clientX, y: e.clientY };
}, true);
renderer.domElement.addEventListener('contextmenu', (e) => {
  const panned = rightPressAt && Math.hypot(e.clientX - rightPressAt.x, e.clientY - rightPressAt.y) > 4;
  rightPressAt = null;
  if (panned) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (measureActive) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (measurePending) resetMeasurePending();
    return;
  }
  if (layActive()) { e.preventDefault(); e.stopImmediatePropagation(); cancelLay(); return; }
  if (drawActive()) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (drawStart) { clearPreview(); updateReadout(lastBuilt); }
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  const hit = pickFace(e);
  showMeshContextMenu(e, hit ? meshIndexForFace(hit.faceIndex, meshFaceRanges) : -1);
}, true);

// ---------------------------------------------------------------- measure distance
// Same behaviour as the file manager's own preview: click two points on the model
// surface (snapping to the nearest triangle vertex), read the straight-line distance.
const measureToggle = el('measure-toggle');
const measureClear = el('measure-clear');
const measureHint = el('measure-hint');
const MEASURE_COLOR = 0xff7a00;
const measurements = [];     // { object, label } -- object is parented to the part
let measurePending = null;   // first point, part-local
const measureLineMat = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true });
const measurePointMat = new THREE.PointsMaterial({
  color: MEASURE_COLOR, size: 9, sizeAttenuation: false, depthTest: false, transparent: true,
});
const measureHoverMat = new THREE.PointsMaterial({
  color: 0xffffff, size: 11, sizeAttenuation: false, depthTest: false, transparent: true,
});
const measureHover = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), measureHoverMat);
measureHover.renderOrder = 20;
measureHover.visible = false;
measureHover.frustumCulled = false;
scene.add(measureHover);
const measureRubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), measureLineMat);
measureRubber.renderOrder = 19;
measureRubber.visible = false;
measureRubber.frustumCulled = false;
scene.add(measureRubber);
const measurePendingMarker = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), measurePointMat);
measurePendingMarker.renderOrder = 20;
measurePendingMarker.visible = false;
measurePendingMarker.frustumCulled = false;
scene.add(measurePendingMarker);
const _mv = new THREE.Vector3();
const _mp = new THREE.Vector3();

function syncMeasureUI() {
  measureToggle.disabled = !part || drawActive() || layActive();
  measureToggle.classList.toggle('active', measureActive);
  measureToggle.setAttribute('aria-pressed', String(measureActive));
  measureClear.disabled = measurements.length === 0 && !measurePending;
  measureHint.hidden = !measureActive;
}

/** Nearest vertex of the hit triangle within a few pixels, else the raw surface point. */
function snapMeasurePoint(hit, ev) {
  const pos = part.geometry.getAttribute('position');
  const r = renderer.domElement.getBoundingClientRect();
  let best = null;
  let bestD = 14;
  for (let k = 0; k < 3; k++) {
    _mv.fromBufferAttribute(pos, hit.faceIndex * 3 + k);
    part.localToWorld(_mv);
    _mp.copy(_mv).project(camera);
    const sx = (_mp.x * 0.5 + 0.5) * r.width + r.left;
    const sy = (-_mp.y * 0.5 + 0.5) * r.height + r.top;
    const d = Math.hypot(sx - ev.clientX, sy - ev.clientY);
    if (d < bestD) { bestD = d; best = _mv.clone(); }
  }
  return best || hit.point.clone();
}

function setMarkerPosition(points, world) {
  const attr = points.geometry.getAttribute('position');
  attr.setXYZ(0, world.x, world.y, world.z);
  attr.needsUpdate = true;
  points.geometry.computeBoundingSphere();
}

function resetMeasurePending() {
  measurePending = null;
  measurePendingMarker.visible = false;
  measureRubber.visible = false;
  syncMeasureUI();
}

function addMeasurement(aLocal, bLocal) {
  const group = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([aLocal, bLocal]), measureLineMat);
  const points = new THREE.Points(new THREE.BufferGeometry().setFromPoints([aLocal, bLocal]), measurePointMat);
  line.renderOrder = points.renderOrder = 18;
  line.frustumCulled = points.frustumCulled = false;
  group.add(line, points);
  part.add(group);
  const label = document.createElement('div');
  label.className = 'measure-label';
  label.textContent = `${aLocal.distanceTo(bLocal).toFixed(2)} mm`;
  document.body.appendChild(label);
  measurements.push({ object: group, label, a: aLocal.clone(), b: bLocal.clone() });
  syncMeasureUI();
}

function clearMeasurements() {
  for (const item of measurements) {
    item.object.parent?.remove(item.object);
    item.object.traverse((child) => child.geometry?.dispose());
    item.label.remove();
  }
  measurements.length = 0;
  measurePending = null;
  measurePendingMarker.visible = false;
  measureRubber.visible = false;
  measureHover.visible = false;
  syncMeasureUI();
}

function setMeasureMode(on) {
  if (on && (!part || drawActive() || layActive())) return;
  if (on === measureActive) return;
  if (on) {
    if (meshEditActive) leaveMeshEdit(false);
    if (boxSelectActive) toggleBoxSelect();
    closeMeshContextMenu();
  }
  measureActive = on;
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  if (!on) {
    measurePending = null;
    measurePendingMarker.visible = false;
    measureRubber.visible = false;
    measureHover.visible = false;
  }
  setGizmo();
  updateMeshSelectionStatus();
}

/** Keep each distance label glued to the middle of its segment. */
const _lm = new THREE.Vector3();
function updateMeasureLabels() {
  if (!measurements.length) return;
  const r = renderer.domElement.getBoundingClientRect();
  for (const item of measurements) {
    _lm.copy(item.a).add(item.b).multiplyScalar(0.5);
    part.localToWorld(_lm).project(camera);
    const visible = _lm.z > -1 && _lm.z < 1;
    item.label.style.display = visible ? 'block' : 'none';
    item.label.style.left = `${(_lm.x * 0.5 + 0.5) * r.width + r.left}px`;
    item.label.style.top = `${(-_lm.y * 0.5 + 0.5) * r.height + r.top}px`;
  }
}

function handleMeasureClick(ev) {
  const hit = pickFace(ev);
  if (!hit) return;
  const local = part.worldToLocal(snapMeasurePoint(hit, ev));
  if (!measurePending) {
    measurePending = local;
    setMarkerPosition(measurePendingMarker, part.localToWorld(local.clone()));
    measurePendingMarker.visible = true;
    syncMeasureUI();
  } else {
    if (local.distanceTo(measurePending) > 1e-6) addMeasurement(measurePending, local);
    resetMeasurePending();
  }
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!measureActive || !part || !topology || ev.buttons) { measureHover.visible = false; return; }
  const hit = pickFace(ev);
  if (!hit) { measureHover.visible = false; measureRubber.visible = false; return; }
  const world = snapMeasurePoint(hit, ev);
  setMarkerPosition(measureHover, world);
  measureHover.visible = true;
  if (measurePending) {
    const attr = measureRubber.geometry.getAttribute('position');
    const from = part.localToWorld(measurePending.clone());
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, world.x, world.y, world.z);
    attr.needsUpdate = true;
    measureRubber.geometry.computeBoundingSphere();
    measureRubber.visible = true;
  }
});

measureToggle.addEventListener('click', () => setMeasureMode(!measureActive));
measureClear.addEventListener('click', clearMeasurements);

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0),
               z: new THREE.Vector3(0, 0, 1) };
for (const a of ['x', 'y', 'z']) {
  el(`rot-${a}`).addEventListener('click', () => rotate90(a, AXES[a]));
}
el('rot-reset').addEventListener('click', () => {
  if (!part) return;
  histPush();
  part.quaternion.identity();
  el('rot-delta').textContent = '';
  hideSuggestions();   // a manual turn invalidates the ranking's "active" mark
  shade();
});

// -------------------------------------------------------- suggest orientation

const _sm4 = new THREE.Matrix4();
let suggestions = [];

/** Turn the part to a suggested pose. `rot` is a column-major 3x3. */
function applySuggestion(rot) {
  histPush();
  // Matrix4.set takes ROW-major args; rot is column-major (THREE.Matrix3 order).
  _sm4.set(rot[0], rot[3], rot[6], 0,
           rot[1], rot[4], rot[7], 0,
           rot[2], rot[5], rot[8], 0,
           0, 0, 0, 1);
  part.quaternion.setFromRotationMatrix(_sm4);
  el('rot-delta').textContent = '';
  shade();
}

// Overhangs the CURRENT pose refuses to support inside a bore/slot (scarring a fit
// surface) — the count buildFins reports as skipped.bore. We only celebrate a pose
// for CLEARING the bore when the current one actually has that problem, so the
// "points the holes up" verdict never fires on a part with no bores. Set before
// renderSuggestions runs.
let suggestCurBore = 0;

/**
 * The "best support is no support" verdict for a suggested pose — the product's
 * whole thesis made a first-class outcome instead of a gray "0 fins". Two tiers:
 *   free      — the pose needs NO support fins at all (regions === 0): 0 g added.
 *               A leftover rough sliver (c.holes) is a cosmetic caveat, not a
 *               support cost, so it's mentioned but doesn't disqualify the win.
 *   holeclean — it still needs external fins, but every bore prints support-free,
 *               so nothing ever stands inside a hole and scars a fit surface. This
 *               is the "point the bore up" win (bore_bracket: 5 in-bore → 0).
 * Returns null for an ordinary supported pose, so the caller falls back to the
 * normal confidence line.
 */
function noSupportVerdict(c) {
  if (c.regions === 0) {
    const rough = c.holes ?? 0;
    const roughCaveat = rough ? ` 可能有小面积打印略粗糙。` : '';
    // The suggester ranks for printability, not strength (it can't know the load).
    // If this pose also stands the part's long axis up the layers, that's the weak
    // print direction, so add a heads-up and point at the Strength arrow.
    const lv = c.size ? layerVerdict(c.size) : null;
    const strengthCaveat = lv?.posture === 'weak'
      ? ` 不过它打得很高，属于较弱的方向，如承受载荷请看看受力箭头。`
      : '';
    return { tier: 'free', badge: '无需支撑',
      note: `这样摆放不需要任何支撑鳍，新增材料 0 g。${roughCaveat}${strengthCaveat}` };
  }
  if ((c.bore ?? 0) === 0 && suggestCurBore > 0) {
    const grams = (c.volume ?? 0) * materialDensity / 1000;
    return { tier: 'holeclean', badge: '孔内干净',
      note: `这样摆放时内孔都朝上，没有支撑伸进孔里划伤配合面`
          + `（支撑鳍共 ${fmtGrams(grams)} g，全部在外部）。` };
  }
  return null;
}

function renderSuggestions() {
  const list = el('suggest-list');
  list.replaceChildren();
  suggestions.forEach((c, i) => {
    const row = document.createElement('button');
    row.className = 'btn suggest-row';
    const point = c.seating === 'point';
    const overs = c.walls === 0 ? '无需支撑' : `${c.walls} 个支撑鳍`;
    // Rough holes = the small hole/slot/bore-top overhangs this pose leaves
    // unsupported (dropped slivers + bore-refused). Showing it is what makes a
    // hole-friendly pose legible: "Best · 12 rough" over "#3 · 561".
    const rough = (c.holes ?? 0) + (c.bore ?? 0);
    const roughTxt = rough ? ` · ${rough} 处粗糙` : '';
    // A support-free pose is the headline outcome, not a footnote — badge it green
    // instead of letting it read as a dull "no overhangs → 0 fins".
    const verdict = point ? null : noSupportVerdict(c);
    // The support-free win is already carried by the green left border (.free) and
    // the "no fins" text, so its badge would just be noise. The "Bores clean" win
    // isn't obvious from the line, so that one earns a badge -- flowed inline so it
    // wraps with the text instead of floating to a lonely top-right corner.
    const badge = verdict?.tier === 'holeclean' ? ` <span class="sr-badge">${verdict.badge}</span>` : '';
    // One tight line per pose: rank · height · fins · rough holes. Bed area was
    // dropped to fit -- height already stands in for how it sits.
    const tail = point ? ' · 无法打印（仅一点接触）' : roughTxt;
    row.innerHTML =
      `<span class="sr-rank">${i === 0 ? '最佳' : `#${i + 1}`}</span>` +
      `<span class="sr-line">${c.height.toFixed(0)} mm · ${overs}${tail}${badge}</span>`;
    if (point) row.classList.add('bad');
    if (verdict?.tier === 'free') row.classList.add('free');
    row.addEventListener('click', () => {
      applySuggestion(c.rot);
      for (const r of list.children) r.classList.remove('active');
      row.classList.add('active');
    });
    list.append(row);
  });
  list.hidden = false;
}

/** Clear the suggestion results entirely (new part, or a manual turn that
 *  invalidates the ranking). The disclosure chevron does NOT come through here --
 *  it only collapses/expands what's already there. */
function hideSuggestions() {
  el('suggest-list').hidden = true;
  el('suggest-list').replaceChildren();
  const note = el('suggest-note');
  note.textContent = '';
  note.className = 'hint';
  const tog = el('suggest-toggle');
  tog.hidden = true;
  tog.setAttribute('aria-expanded', 'true');   // next results open expanded
  el('suggest-body').hidden = false;
}

el('suggest-orient').addEventListener('click', () => {
  if (!part || !topology) return;
  const btn = el('suggest-orient');
  btn.disabled = true; btn.textContent = '正在评估…';
  // let the button repaint before the (up to ~1s) solve blocks the thread
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      const { candidates, confidence } = suggestOrientations(topology, { top: 3, threshold });
      suggestions = candidates;
      // In-bore overhangs the current pose refuses (would scar a fit surface) — the
      // baseline the "points the bores up" verdict measures its win against.
      suggestCurBore = lastBuilt?.skipped?.bore ?? 0;
      // Fresh results always land expanded, with the collapse chevron available.
      const tog = el('suggest-toggle');
      tog.hidden = false;
      tog.setAttribute('aria-expanded', 'true');
      tog.setAttribute('aria-label', '收起推荐结果');
      tog.title = '收起';
      el('suggest-body').hidden = false;
      if (!candidates.length || confidence === 'none') {
        el('suggest-list').hidden = true;
        el('suggest-note').textContent = confidence === 'none'
          ? '没有任何可打印的朝向：这个零件无论怎么转都只靠一点平衡。'
          : '这个零件没有可推荐的方向。';
      } else {
        renderSuggestions();
        // Lead with the win when the best pose needs no support (or clears every
        // bore); otherwise fall back to the honest confidence line.
        const note = el('suggest-note');
        const verdict = candidates[0].seating === 'point' ? null : noSupportVerdict(candidates[0]);
        if (verdict) {
          note.textContent = verdict.note;
          note.className = 'hint good';
        } else {
          note.textContent = '点选一个朝向来旋转零件。';
          note.className = 'hint';
        }
      }
    } finally {
      btn.disabled = false; btn.textContent = '推荐摆放方向';
    }
  }));
});

// Collapse/expand the results in place, keeping them (and the ranking) intact.
el('suggest-toggle').addEventListener('click', () => {
  const tog = el('suggest-toggle');
  const open = tog.getAttribute('aria-expanded') !== 'false';
  const next = !open;
  tog.setAttribute('aria-expanded', String(next));
  tog.setAttribute('aria-label', next ? '收起推荐结果' : '展开推荐结果');
  tog.title = next ? '收起' : '展开';
  el('suggest-body').hidden = !next;
});

// --------------------------------------------------------------- load arrow

el('show-layers').addEventListener('change', (e) => {
  layersOn = e.target.checked;
  layerViz.visible = layersOn && !!part;
});

// Strength-arrow pad: each button points the load along a world direction.
for (const key of Object.keys(PAD_DIRS)) {
  el(`load-${key}`).addEventListener('click', () => setLoadWorld(key));
}
el('load-clear').addEventListener('click', clearLoad);

// Lay a face flat -- armed behind a button so a stray click can't re-lay the part.
el('lay-face').addEventListener('click', () => {
  if (layPlacing) cancelLay();
  else beginLay();
});

// Turn the part to the strongest PRINTABLE pose for the placed load. Unlike
// "Suggest orientation" (which minimises support), this is strength-driven: it
// lays the load most in-plane, but only among poses that actually sit on the bed,
// so it can't produce the needle-tower. If the current pose is already about as
// good as it gets, say so instead of turning to an equivalent orientation.
el('load-suggest').addEventListener('click', () => {
  if (!part || !topology || !loadDir) return;
  const pose = suggestStrengthPose(topology, [loadDir.x, loadDir.y, loadDir.z], { threshold });
  const w = loadDir.clone().applyQuaternion(part.quaternion);
  const cur = loadAlignment([w.x, w.y, w.z]);
  const note = el('load-note');
  if (!pose || (cur && pose.cross >= cur.cross - 0.05)) {
    note.textContent = '对这组受力来说，这已经是可打印的最强朝向了 '
      + '—— 更顺层的摆法都无法稳坐在底板上。';
    note.className = `load-verdict ${cur ? cur.quality : 'mixed'}`;
    note.hidden = false;
    el('load-suggest').hidden = true;
    return;
  }
  applySuggestion(pose.rot);   // turns the part; shade() refreshes the verdict + button
});

let threshold = DEFAULT_THRESHOLD;
const thrInput = el('thr');
thrInput.value = String(threshold);
thrInput.addEventListener('input', () => {
  threshold = Number(thrInput.value);
  el('thr-val').textContent = `${threshold}°`;
  computeFlatBaseline();   // the flat baseline moves with the overhang threshold
  shade();
});

const volumeSelect = el('volume');
const customRow = el('custom-vol');
const customInputs = ['vx', 'vy', 'vz'].map(el);

for (const v of VOLUMES) volumeSelect.add(new Option(volLabel(v), volLabel(v)));
volumeSelect.add(new Option('自定义…', 'custom'));

let volume = { ...DEFAULT_VOLUME };
try {
  const saved = JSON.parse(localStorage.getItem(VOLUME_STORE) || 'null');
  if (saved && saved.x > 0 && saved.y > 0 && saved.z > 0) volume = saved;
} catch { /* corrupt or unavailable storage is not worth failing over */ }

const isPreset = (v) => VOLUMES.some((p) => volLabel(p) === volLabel(v));
volumeSelect.value = isPreset(volume) ? volLabel(volume) : 'custom';
customInputs.forEach((inp, i) => { inp.value = String([volume.x, volume.y, volume.z][i]); });

const currentVolume = () => volume;

function applyVolume() {
  customRow.hidden = volumeSelect.value !== 'custom';
  buildPlate(volume.x, volume.y, volume.z);
  try {
    localStorage.setItem(VOLUME_STORE, JSON.stringify(volume));
  } catch { /* private mode; the app still works, it just forgets */ }
  if (part) shade();
}

volumeSelect.addEventListener('change', () => {
  if (volumeSelect.value !== 'custom') {
    volume = VOLUMES.find((v) => volLabel(v) === volumeSelect.value) ?? volume;
    customInputs.forEach((inp, i) => {
      inp.value = String([volume.x, volume.y, volume.z][i]);
    });
  }
  applyVolume();
});

for (const inp of customInputs) {
  inp.addEventListener('input', () => {
    const [x, y, z] = customInputs.map((n) => Number(n.value));
    if (x > 0 && y > 0 && z > 0) { volume = { x, y, z }; applyVolume(); }
  });
}

// ------------------------------------------------------------------- file I/O

const loader = new STLLoader();

// Which parser gets the file is decided in step.js's sniffModel: by CONTENT first (a
// 3MF is an OPC package and opens with the ZIP magic, a STEP starts 'ISO-10303-21', an
// IGES is 80-column records, a BREP starts 'DBRep_DrawableShape'), with the file
// extension only as a last resort. That way a file a slicer renamed still lands in the
// right parser instead of being mangled by the STL reader.

/** A three.js BufferGeometry from a flat mm position array (the STL layout). */
function geometryFromPositions(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Concatenate several picked objects' position arrays into one part. */
function mergeObjectPositions(objs) {
  if (objs.length === 1) return objs[0].positions;
  let total = 0;
  for (const o of objs) total += o.positions.length;
  const all = new Float32Array(total);
  let off = 0;
  for (const o of objs) { all.set(o.positions, off); off += o.positions.length; }
  return all;
}

/**
 * A 3MF plate can hold several distinct objects (a Bambu/MakerWorld download
 * usually does) and this tool fins ONE part. Show the list and resolve to the
 * chosen objects, or null on cancel. Largest by triangle count is pre-selected
 * (the model, not its base/skirt); checking several merges them. Esc cancels,
 * Enter loads.
 */
function pickObjects(objects) {
  const modal = el('picker');
  const list = el('picker-list');
  const hint = el('picker-hint');
  const loadBtn = el('picker-load');
  const cancelBtn = el('picker-cancel');

  const order = objects.map((_, i) => i).sort((a, b) => objects[b].tris - objects[a].tris);
  list.replaceChildren();
  const boxes = [];
  order.forEach((idx, rank) => {
    const o = objects[idx];
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rank === 0;                   // largest pre-selected
    cb.dataset.idx = String(idx);
    cb.addEventListener('change', refresh);
    const name = document.createElement('span');
    name.className = 'pk-name';
    name.textContent = o.name;
    const meta = document.createElement('span');
    meta.className = 'pk-meta';
    const s = o.bbox.size.map((v) => Math.round(v));
    meta.textContent = `${o.tris.toLocaleString()} 三角面 · ${s[0]}×${s[1]}×${s[2]} mm`;
    label.append(cb, name, meta);
    li.append(label);
    list.append(li);
    boxes.push(cb);
  });

  const selected = () => boxes.filter((b) => b.checked).map((b) => objects[+b.dataset.idx]);
  function refresh() {
    const n = selected().length;
    loadBtn.disabled = n === 0;
    loadBtn.textContent = n > 1 ? `组合 ${n} 个并载入` : '载入';
    hint.textContent = n > 1 ? `已选 ${n} 个 —— 保留独立网格，3MF 导出时仍可单独选择` : '';
  }
  refresh();
  modal.hidden = false;

  return new Promise((resolve) => {
    function close(result) {
      modal.hidden = true;
      loadBtn.removeEventListener('click', onLoad);
      cancelBtn.removeEventListener('click', onCancel);
      removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onLoad() { const sel = selected(); if (sel.length) close(sel); }
    function onCancel() { close(null); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onLoad(); }
    }
    loadBtn.addEventListener('click', onLoad);
    cancelBtn.addEventListener('click', onCancel);
    addEventListener('keydown', onKey);
  });
}

/**
 * Bytes in, three.js geometry out, for either format (or null if the user
 * cancels the 3MF object picker). The 3MF reader hands back the same flat mm
 * position array STLLoader produces, so everything downstream (setPart, the
 * weld, the whole engine) is unchanged.
 */
async function parseModel(buffer, filename = '', showObjectPicker = true) {
  importNote = '';
  const kind = sniffModel(buffer, filename);
  if (kind === 'zip') return parseThreeMF(buffer, filename, showObjectPicker);
  if (isStepFamily(kind)) return parseStep(buffer, kind, filename, showObjectPicker);
  const geometry = loader.parse(buffer);
  return {
    geometry,
    meshes: [{ name: filename || '模型', positions: new Float32Array(geometry.getAttribute('position').array) }],
  };
}

/**
 * A 3MF plate goes through the object picker because it can hold several distinct
 * objects; selected objects are analyzed as one assembly but kept as separate 3MF meshes.
 */
async function parseThreeMF(buffer, filename = '', showObjectPicker = true) {
  const { objects, unit, skipped } = await readThreeMF(new Uint8Array(buffer));

  // One object loads straight in; a plate of several goes to the picker so the
  // user chooses which body to fin rather than us merging distinct models.
  let chosen = objects;
  if (showObjectPicker && objects.length > 1) {
    chosen = await pickObjects(objects);
    if (!chosen) return null;               // cancelled: keep the current part
  }

  if (!chosen || chosen.length === 0) return null;
  const meshes = chosen.map((object, index) => ({
    name: filename ? `${filename} — ${object.name || `对象 ${index + 1}`}` : object.name || `对象 ${index + 1}`,
    positions: new Float32Array(object.positions),
  }));
  const geometry = geometryFromPositions(mergeObjectPositions(chosen));

  // Say what we decided for them: which/how many bodies, any support bodies left
  // on the plate, and any unit conversion.
  const notes = [];
  if (objects.length > 1) {
    notes.push(chosen.length === 1
      ? `已从 ${objects.length} 个对象中载入“${chosen[0].name}”`
      : `已将 ${chosen.length} 个对象组合载入，导出 3MF 时会保留独立网格`);
  } else if (chosen[0].meshes > 1) {
    notes.push(`已把 ${chosen[0].meshes} 个实体合并为一个零件`);
  }
  if (skipped) notes.push(`已忽略 ${skipped} 个支撑/不可打印实体`);
  if (unit && unit !== 'millimeter') notes.push(`已从 ${unit} 换算为毫米`);
  importNote = notes.length ? `3MF：${notes.join('；')}。` : '';

  return { geometry, meshes };
}

/**
 * STEP / IGES / BREP: the file describes B-rep surfaces, so it goes through the
 * OpenCascade engine (worker, lazily loaded -- see step.js) and comes back as triangle
 * soups. Everything after this point is exactly the 3MF path: one body loads straight
 * in, an assembly goes to the picker, and the status panel says what we decided.
 */
async function parseStep(buffer, kind, filename, showObjectPicker = true) {
  const label = FORMAT_LABEL[kind] || 'CAD';
  const res = await convertStepFile(buffer, kind, filename);
  if (!res.ok) throw new Error(res.error);

  let chosen = res.bodies;
  if (showObjectPicker && res.bodies.length > 1) {
    chosen = await pickObjects(res.bodies);
    if (!chosen) return null;               // cancelled: keep the current part
  }
  if (!chosen || !chosen.length) return null;

  const notes = [...res.notes];
  if (res.bodies.length > 1) {
    notes.push(chosen.length === 1
      ? `已从 ${res.bodies.length} 个实体中载入“${chosen[0].name}”`
      : `已将 ${chosen.length} 个实体组合载入，导出 3MF 时会保留独立网格`);
  }
  // One body made of several shells says so -- the same honesty the 3MF note carries.
  // "面" and not "实体": a faceted STEP solid arrives as one mesh per face, so a plain
  // sphere legitimately reports thousands of them, and calling those "solids" would
  // read as a broken file.
  else if (chosen[0].meshes > 1) {
    notes.push(`已载入 ${chosen[0].meshes} 个独立网格；导出 3MF 时保留各网格`);
  }
  importNote = `${label}：${notes.join('；')}。`;

  const meshes = chosen.map((body, index) => ({
    name: filename ? `${filename} — ${body.name || `实体 ${index + 1}`}` : body.name || `实体 ${index + 1}`,
    positions: new Float32Array(body.positions),
  }));
  return { geometry: geometryFromPositions(mergeObjectPositions(chosen)), meshes };
}

async function loadFile(file) {
  if (!file) return;
  try {
    const parsed = await parseModel(await file.arrayBuffer(), file.name);
    if (parsed) setPart(parsed.geometry, file.name, parsed.meshes);
  } catch (err) {
    console.error(err);
    clearImportNote();
    alert(`无法读取 ${file.name}：\n${err.message}`);
  }
}

async function loadMergedFiles(fileList) {
  const files = Array.from(fileList || []);
  const input = el('merge-files');
  input.value = '';
  if (files.length < 2) {
    alert('请选择至少两个模型文件。');
    return;
  }
  if (files.length > 100) {
    alert('一次最多合并 100 个文件。');
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 512 * 1024 * 1024) {
    alert('合并文件总大小不能超过 512 MB。');
    return;
  }

  const label = el('merge-label');
  const originalText = label.textContent;
  label.textContent = '正在读取…';
  input.disabled = true;
  try {
    const meshes = [];
    const notes = [];
    for (const file of files) {
      const parsed = await parseModel(await file.arrayBuffer(), file.name, false);
      if (!parsed) return;
      for (const mesh of parsed.meshes) meshes.push(mesh);
      if (importNote) notes.push(importNote);
    }

    let totalPositions = 0;
    for (const mesh of meshes) totalPositions += mesh.positions.length;
    if (!totalPositions) throw new Error('所选文件没有可合并的网格');
    const positions = new Float32Array(totalPositions);
    let offset = 0;
    for (const mesh of meshes) {
      positions.set(mesh.positions, offset);
      offset += mesh.positions.length;
    }

    const title = `${files.length} 个模型组合`;
    importNote = `已组合 ${files.length} 个文件、${meshes.length} 个独立网格；位置按各文件原始坐标保留。` +
      (notes.length ? ` ${notes.join('；')}` : '');
    setPart(geometryFromPositions(positions), title, meshes);
  } catch (error) {
    console.error('model merge failed', error);
    clearImportNote();
    alert(`合并失败：${error.message}`);
  } finally {
    input.disabled = false;
    input.value = '';
    label.textContent = originalText;
  }
}

/** A failed import must not leave "正在加载引擎…" sitting in the status panel. */
function clearImportNote() {
  importNote = '';
  const note = el('s-import-note');
  if (note) note.textContent = '';
}

// While a STEP-family file is being tessellated (seconds, and 7.6MB on first use) the
// status panel says so; report() then replaces it with the import note.
onStepStatus((msg) => {
  const note = el('s-import-note');
  if (note) note.textContent = msg;
  el('status').hidden = false;
});

el('file').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});
el('merge-files').addEventListener('change', (e) => loadMergedFiles(e.target.files));

/** Load a model that is already on the web (the sample model, a demo link). */
async function loadURL(url, combineObjects = false) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const name = decodeURIComponent(url.split('/').pop());
  const parsed = await parseModel(await res.arrayBuffer(), name, !combineObjects);
  if (!parsed) return;                       // picker cancelled
  setPart(parsed.geometry, name, parsed.meshes);
  // Drop ?stl= once it has been consumed: the path is nobody's business but the
  // user's, and a stale one in the address bar is misleading after they open a
  // different file.
  history.replaceState(null, '', location.pathname);
}

const drop = el('drop');
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (dragDepth++ === 0) drop.classList.remove('hidden'), drop.classList.add('armed');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.classList.remove('armed');
    drop.classList.add('hidden');
  }
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('armed');
  drop.classList.add('hidden');
  loadFile(e.dataTransfer.files[0]);
});

// ----------------------------------------------------------------- main loop

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);          // must update CSS size too, or a 2x DPR
  camera.aspect = w / h;           // canvas lays out at 2x and we see a quadrant
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const fpsEl = el('fps');
let frames = 0, last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  controls.update();
  renderer.render(scene, camera);
  updateMeasureLabels();
  if (++frames >= 20) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (now - last))} fps`;
    frames = 0;
    last = now;
  }
}

applyVolume();
resize();
frame(new THREE.Vector3(60, 60, 60));
requestAnimationFrame(tick);

// debug surface, used to cross-check against the Python probes
window.__sf = { get part() { return part; }, get topo() { return topology; },
                analyze, get threshold() { return threshold; },
                get rot() { return rotM3.elements; },
                get result() { return lastResult; },
                get finTris() { return finTris; },
                get padTris() { return padTris; },
                get drawnTris() { return drawnTris; },
                get drawnWalls() { return drawnWalls; },
                buildFins, findWallPatches, drawnWall, buildExportGeometry };

const launchParams = new URLSearchParams(location.search);
const wanted = launchParams.get('stl');
const combineObjects = launchParams.get('all') === '1';
if (wanted) {
  const note = el('s-import-note');
  if (note) note.textContent = '正在载入当前预览模型…';
  el('status').hidden = false;
  loadURL(wanted, combineObjects).then(() => {
    if (!window.__sf.part && note) note.textContent = '载入完成，但文件未包含可显示网格。';
  }).catch((err) => {
    console.error('?stl=', err);
    if (note) note.textContent = `自动载入模型失败：${err && err.message ? err.message : err}`;
    el('status').hidden = false;
  });
}
