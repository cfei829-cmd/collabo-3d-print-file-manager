// 场景工具：缩略图渲染 + 交互预览
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/addons/OrbitControls.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // 3D 打印模型以 Z 轴向上

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, -1.5, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-2, 1, 0.5);
  scene.add(fill);
}

export function fitCamera(camera, box, controls, dir = new THREE.Vector3(1, -1.15, 0.8)) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-3);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  camera.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = dist * 20;
  camera.up.set(0, 0, 1);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  if (controls) { controls.target.copy(center); controls.update(); }
}

let thumbRenderer = null;
export function renderThumbnail(group, box, size = 320) {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
  }
  thumbRenderer.setSize(size, size, false);
  thumbRenderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  addLights(scene);
  scene.add(group);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
  fitCamera(camera, box, null);
  thumbRenderer.render(scene, camera);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  scene.remove(group);
  return url;
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    addLights(this.scene);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.group = null;
    this.box = null;
    this.grid = null;
    this.raf = 0;
    this.wire = false;
    this._loop = () => {
      this.raf = requestAnimationFrame(this._loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
  }
  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setModel(group, box) {
    this.clear();
    this.group = group;
    this.box = box;
    this.scene.add(group);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 1) * 1.6;
    const grid = new THREE.GridHelper(span, 20, 0x7a8aa0, 0x4c5666);
    grid.rotation.x = Math.PI / 2;
    grid.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z - 1e-3);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.grid = grid;
    this.scene.add(grid);
    this.setWireframe(this.wire);
    this.resize();
    fitCamera(this.camera, box, this.controls);
    if (!this.raf) this._loop();
  }
  setWireframe(on) {
    this.wire = on;
    if (!this.group) return;
    this.group.traverse((o) => { if (o.isMesh) o.material.wireframe = on; });
  }
  resetView() { if (this.box) fitCamera(this.camera, this.box, this.controls); }
  clear() {
    if (this.group) { this.scene.remove(this.group); this.group = null; }
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); this.grid = null; }
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
