import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
scene.fog = new THREE.Fog('#e2dfd3', 8, 18);
const camera = new THREE.PerspectiveCamera(32, 1, .05, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2.5; controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * .51;
scene.add(new THREE.HemisphereLight(0xfff7df, 0x758976, 2.0));
const key = new THREE.DirectionalLight(0xffe7c3, 3.0);
key.position.set(-3, 6, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4;key.shadow.camera.right = 4;
key.shadow.camera.top = 4;key.shadow.camera.bottom = -4;
key.shadow.normalBias = .02;scene.add(key);
const fill = new THREE.DirectionalLight(0xe6f4ff, 1.4);fill.position.set(4,3,-3);scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200), new THREE.MeshStandardMaterial({color:'#dfdcce',roughness:1}));
ground.rotation.x = -Math.PI/2;ground.position.y=-.023;ground.receiveShadow=true;scene.add(ground);
const figures = [], loader = new GLTFLoader();
let paused=false, clip='Idle', model='both', view='angle';
const status = document.querySelector('#status');
function resize(){renderer.setSize(host.clientWidth,host.clientHeight);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(host);
function setView(value){
  view=value; const single=model!=='both';
  controls.target.set(0,1.0,0);
  const dist=single?3.65:5.25;
  camera.position.set(value==='angle'?dist*.39:0, value==='angle'?2.25:1.32, value==='back'?-dist:dist);
  controls.update();
}
function play(name){
  clip=name;
  for(const f of figures){f.mixer.stopAllAction();f.mixer.clipAction(f.clips.find(c=>c.name===name)).reset().play();f.mixer.update(0);}
  for(const b of document.querySelectorAll('[data-clip]')) b.setAttribute('aria-pressed',String(b.dataset.clip===name));
}
function selectModel(name){
  model=name;
  for(const f of figures){f.root.visible=name==='both'||f.name===name;f.root.position.x=name==='both'?(f.name==='lao_wang'?-.70:.70):0;}
  document.querySelector('#label-lao_wang').hidden=name==='chef_chen';
  document.querySelector('#label-chef_chen').hidden=name==='lao_wang';
  setView(view);
}
function stats(){
  return figures.map(f=>({name:f.name,triangles:f.triangles,clips:f.clips.map(c=>({name:c.name,duration:c.duration})),bounds:f.bounds,size:f.size}));
}
try{
  for(const name of ['lao_wang','chef_chen']){
    const gltf=await loader.loadAsync('./'+name+'.glb');
    let triangles=0;
    gltf.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;triangles+=(o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count)/3;}});
    const box=new THREE.Box3().setFromObject(gltf.scene);
    const size=box.getSize(new THREE.Vector3()).toArray();
    const bounds={min:box.min.toArray(),max:box.max.toArray()};
    scene.add(gltf.scene);
    figures.push({name,root:gltf.scene,mixer:new THREE.AnimationMixer(gltf.scene),clips:gltf.animations,triangles,size,bounds});
  }
  selectModel('both');play('Idle');
  status.textContent='Обе модели загружены · 6 688 треугольников · Idle / Wave';
  window.vendorPreview={
    ready:true,stats,
    selectModel, setView,play,
    pose(name,time){play(name);for(const f of figures)f.mixer.setTime(time);paused=true;controls.update();renderer.render(scene,camera);},
    render(){controls.update();renderer.render(scene,camera);},
    snapshot(){return figures.map(f=>({name:f.name,shoulder:f.root.getObjectByName('L_Shoulder').quaternion.toArray(),prop:f.root.getObjectByName('HeldProp').getWorldPosition(new THREE.Vector3()).toArray()}));}
  };
}catch(error){status.textContent='Ошибка загрузки: '+error.message;status.classList.add('error');console.error(error);}
for(const b of document.querySelectorAll('[data-clip]'))b.onclick=()=>play(b.dataset.clip);
document.querySelector('#pause').onclick=event=>{paused=!paused;event.target.setAttribute('aria-pressed',String(paused));event.target.textContent=paused?'Продолжить':'Пауза';};
document.querySelector('#camera').onchange=e=>setView(e.target.value);
document.querySelector('#model').onchange=e=>selectModel(e.target.value);
setView('angle');resize();
let last=performance.now();
renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(!paused)for(const f of figures)f.mixer.update(dt);controls.update();renderer.render(scene,camera);});
