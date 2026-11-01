import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODELS = ['cart_banh_mi', 'cart_thai_noodle'];
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
scene.fog = new THREE.Fog('#e2dfd3', 9, 20);
const camera = new THREE.PerspectiveCamera(32, 1, .05, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2; controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * .51;
scene.add(new THREE.HemisphereLight(0xfff7df, 0x758976, 2.0));
const key = new THREE.DirectionalLight(0xffe7c3, 3.0);
key.position.set(-3, 6, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4; key.shadow.camera.right = 4;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
key.shadow.normalBias = .02; scene.add(key);
const fill = new THREE.DirectionalLight(0xe6f4ff, 1.4); fill.position.set(4, 3, -3); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#dfdcce', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const carts = [], loader = new GLTFLoader();
let paused = false, clip = 'Idle', model = 'both', view = 'angle';
const status = document.querySelector('#status');
function resize() { renderer.setSize(host.clientWidth, host.clientHeight); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(host);
function setView(value) {
  view = value; const single = model !== 'both';
  controls.target.set(0, single ? 1.25 : 1.1, 0);
  const dist = single ? 5.4 : 6.6;
  camera.position.set(value === 'angle' ? dist * .55 : 0, value === 'angle' ? 2.5 : 1.4, value === 'back' ? -dist : dist * (value === 'angle' ? .85 : 1));
  controls.update();
}
function play(name) {
  clip = name;
  for (const c of carts) {
    c.mixer.stopAllAction();
    const action = c.mixer.clipAction(c.clips.find(a => a.name === name)).reset();
    // Open is a one-shot interaction: hold the open pose; play with timeScale -1 to close.
    if (name === 'Open') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    action.play(); c.mixer.update(0);
  }
  for (const b of document.querySelectorAll('[data-clip]')) b.setAttribute('aria-pressed', String(b.dataset.clip === name));
}
function selectModel(name) {
  model = name;
  for (const c of carts) { c.root.visible = name === 'both' || c.name === name; c.root.position.x = name === 'both' ? (c.name === MODELS[0] ? -1.25 : 1.25) : 0; }
  document.querySelector('#label-' + MODELS[0]).hidden = name === MODELS[1];
  document.querySelector('#label-' + MODELS[1]).hidden = name === MODELS[0];
  setView(view);
}
function stats() {
  return carts.map(c => ({ name: c.name, triangles: c.triangles, clips: c.clips.map(a => ({ name: a.name, duration: a.duration })), size: c.size }));
}
try {
  for (const name of MODELS) {
    const gltf = await loader.loadAsync('./' + name + '.glb');
    let triangles = 0;
    gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
    const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).toArray();
    scene.add(gltf.scene);
    carts.push({ name, root: gltf.scene, mixer: new THREE.AnimationMixer(gltf.scene), clips: gltf.animations, triangles, size });
  }
  selectModel('both'); play('Idle');
  status.textContent = 'Обе модели загружены · ' + carts.reduce((s, c) => s + c.triangles, 0).toLocaleString('ru') + ' треугольников · Idle / Roll / Open';
  window.cartPreview = {
    ready: true, stats, selectModel, setView, play,
    pose(name, time) { play(name); for (const c of carts) c.mixer.setTime(time); paused = true; controls.update(); renderer.render(scene, camera); },
    render() { controls.update(); renderer.render(scene, camera); },
    // Local pose of animated parts, for automated checks of Roll / Open.
    snapshot(names) { return Object.fromEntries(carts.map(c => [c.name, Object.fromEntries(names.map(n => { const o = c.root.getObjectByName(n); return [n, o ? { q: o.quaternion.toArray(), p: o.position.toArray() } : null]; }))])); },
  };
} catch (error) { status.textContent = 'Ошибка загрузки: ' + error.message; status.classList.add('error'); console.error(error); }
for (const b of document.querySelectorAll('[data-clip]')) b.onclick = () => play(b.dataset.clip);
document.querySelector('#pause').onclick = event => { paused = !paused; event.target.setAttribute('aria-pressed', String(paused)); event.target.textContent = paused ? 'Продолжить' : 'Пауза'; };
document.querySelector('#camera').onchange = e => setView(e.target.value);
document.querySelector('#model').onchange = e => selectModel(e.target.value);
setView('angle'); resize();
let last = performance.now();
renderer.setAnimationLoop(now => { const dt = Math.min((now - last) / 1000, .05); last = now; if (!paused) for (const c of carts) c.mixer.update(dt); controls.update(); renderer.render(scene, camera); });
