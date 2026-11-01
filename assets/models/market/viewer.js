import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GROUPS = { carts: ['cart_jianbing', 'cart_tanghulu'], stalls: ['stall_pavilion', 'stall_awning'] };
const MODELS = [...GROUPS.carts, ...GROUPS.stalls];
const host = document.querySelector('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e2dfd3');
scene.fog = new THREE.Fog('#e2dfd3', 14, 30);
const camera = new THREE.PerspectiveCamera(32, 1, .05, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2; controls.maxDistance = 20;
controls.maxPolarAngle = Math.PI * .51;
scene.add(new THREE.HemisphereLight(0xfff7df, 0x758976, 2.0));
const key = new THREE.DirectionalLight(0xffe7c3, 3.0);
key.position.set(-3, 7, 6); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -7; key.shadow.camera.right = 7;
key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
key.shadow.normalBias = .02; scene.add(key);
const fill = new THREE.DirectionalLight(0xe6f4ff, 1.4); fill.position.set(4, 3, -3); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#dfdcce', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const items = [], loader = new GLTFLoader();
const slotMarker = new THREE.MeshBasicMaterial({ color: '#1c8f5a' });
let paused = false, clip = 'Idle', selection = 'all', view = 'angle', width = 0;
const status = document.querySelector('#status');
function resize() { renderer.setSize(host.clientWidth, host.clientHeight); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(host);
function setView(value) {
  view = value;
  const dist = 3.2 + width * 1.15;
  controls.target.set(0, 1.15, 0);
  camera.position.set(value === 'angle' ? dist * .5 : 0, value === 'angle' ? 2.6 + width * .2 : 1.5, value === 'back' ? -dist : dist * (value === 'angle' ? .87 : 1));
  controls.update();
}
function play(name) {
  clip = name;
  for (const it of items) {
    it.mixer.stopAllAction();
    // A model without the requested clip keeps idling.
    const found = it.clips.find(a => a.name === name) ?? it.clips.find(a => a.name === 'Idle');
    const action = it.mixer.clipAction(found).reset();
    // Open/Close are one-shot interactions: hold the end pose; play with timeScale -1 to revert.
    if (found.name === 'Open' || found.name === 'Close') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    action.play(); it.mixer.update(0);
  }
  for (const b of document.querySelectorAll('[data-clip]')) b.setAttribute('aria-pressed', String(b.dataset.clip === name));
}
function select(name) {
  selection = name;
  const shown = name === 'all' ? MODELS : GROUPS[name] ?? [name];
  const gap = .7;
  const sizes = shown.map(n => items.find(i => i.name === n).size[0]);
  width = sizes.reduce((s, w) => s + w, 0) + gap * (shown.length - 1);
  let x = -width / 2;
  for (const it of items) it.root.visible = false;
  shown.forEach((n, k) => { const it = items.find(i => i.name === n); it.root.visible = true; it.root.position.x = x + sizes[k] / 2 - it.center; x += sizes[k] + gap; });
  setView(view);
}
function showSlots(on) {
  for (const it of items) for (const m of it.markers) m.visible = on;
  document.querySelector('#slots').setAttribute('aria-pressed', String(on));
}
function stats() {
  return items.map(it => ({ name: it.name, triangles: it.triangles, slots: it.markers.length, clips: it.clips.map(a => ({ name: a.name, duration: a.duration })), size: it.size }));
}
try {
  for (const name of MODELS) {
    const gltf = await loader.loadAsync('./' + name + '.glb');
    let triangles = 0; const markers = [];
    gltf.scene.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3()).toArray();
    gltf.scene.traverse(o => {
      if (o.name.startsWith('Slot_')) { const m = new THREE.Mesh(new THREE.SphereGeometry(.035, 8, 6), slotMarker); m.position.y = .035; m.visible = false; o.add(m); markers.push(m); }
    });
    scene.add(gltf.scene);
    items.push({ name, root: gltf.scene, mixer: new THREE.AnimationMixer(gltf.scene), clips: gltf.animations, triangles, size, center: (box.min.x + box.max.x) / 2, markers });
  }
  select('all'); play('Idle');
  status.textContent = MODELS.length + ' модели · ' + items.reduce((s, i) => s + i.triangles, 0).toLocaleString('ru') + ' треугольников · ' + items.reduce((s, i) => s + i.markers.length, 0) + ' слотов';
  window.marketPreview = {
    ready: true, stats, select, setView, play, showSlots,
    pose(name, time) { play(name); for (const it of items) it.mixer.setTime(time); paused = true; controls.update(); renderer.render(scene, camera); },
    render() { controls.update(); renderer.render(scene, camera); },
    // Local pose of animated parts, for automated checks of Roll / Open / Close.
    snapshot(names) { return Object.fromEntries(items.map(it => [it.name, Object.fromEntries(names.map(n => { const o = it.root.getObjectByName(n); return [n, o ? { q: o.quaternion.toArray(), p: o.position.toArray() } : null]; }))])); },
  };
} catch (error) { status.textContent = 'Ошибка загрузки: ' + error.message; status.classList.add('error'); console.error(error); }
for (const b of document.querySelectorAll('[data-clip]')) b.onclick = () => play(b.dataset.clip);
document.querySelector('#pause').onclick = event => { paused = !paused; event.target.setAttribute('aria-pressed', String(paused)); event.target.textContent = paused ? 'Продолжить' : 'Пауза'; };
document.querySelector('#slots').onclick = event => showSlots(event.target.getAttribute('aria-pressed') !== 'true');
document.querySelector('#camera').onchange = e => setView(e.target.value);
document.querySelector('#model').onchange = e => select(e.target.value);
setView('angle'); resize();
let last = performance.now();
renderer.setAnimationLoop(now => { const dt = Math.min((now - last) / 1000, .05); last = now; if (!paused) for (const it of items) it.mixer.update(dt); controls.update(); renderer.render(scene, camera); });
