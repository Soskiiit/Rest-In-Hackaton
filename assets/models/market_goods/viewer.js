import * as THREE from 'three';
import {GLTFLoader}from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls}from 'three/addons/controls/OrbitControls.js';
const $=id=>document.getElementById(id),host=$('viewport');
const scene=new THREE.Scene();scene.background=new THREE.Color('#f0eadd');
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;host.append(renderer.domElement);renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label','Осмотр предмета: стрелки — поворот, плюс и минус — масштаб, Home — сброс');
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,30),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.minZoom=.55;controls.maxZoom=3;controls.maxPolarAngle=Math.PI*.495;controls.enablePan=false;
scene.add(new THREE.HemisphereLight(0xfff7df,0x8a9e8b,2.2));const light=new THREE.DirectionalLight(0xfff0d5,3);light.position.set(-3,5,4);light.castShadow=true;light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-2,right:2,top:3,bottom:-2});light.shadow.normalBias=.003;scene.add(light);const fill=new THREE.DirectionalLight(0xe6f3ff,1.3);fill.position.set(3,3,-3);scene.add(fill);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:'#f0eadd',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.004;floor.receiveShadow=true;scene.add(floor);
let manifest,entries=[],current=null,category='all',view='angle',ready=false,pending=false;
function render(){renderer.render(scene,camera);}
function requestRender(){if(!pending){pending=true;requestAnimationFrame(()=>{pending=false;render();});}}
controls.addEventListener('change',requestRender);
function frame(width,height){renderer.setSize(width,height);const aspect=width/height,h=1.05;camera.left=-h*aspect;camera.right=h*aspect;camera.top=h;camera.bottom=-h;camera.updateProjectionMatrix();}
function resize(){if(host.clientWidth&&host.clientHeight){frame(host.clientWidth,host.clientHeight);render();}}
new ResizeObserver(resize).observe(host);
function setView(value){view=value;camera.zoom=1;const y=current?current.height/2:.5;controls.target.set(0,y,0);camera.up.set(0,value==='top'?0:1,value==='top'?-1:0);const directions={angle:[2.5,2.0,3],front:[0,.05,4],side:[4,.05,0],top:[0,4,.0001]};camera.position.copy(controls.target).add(new THREE.Vector3(...directions[value]));controls.update();camera.updateProjectionMatrix();for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===value));render();}
function activate(entry){for(const e of entries)e.holder.visible=e===entry;current=entry;setView('angle');}
function showGallery(){current=null;for(const e of entries)e.holder.visible=false;$('inspector').hidden=true;$('gallery').hidden=false;$('count').textContent=(category==='all'?entries:entries.filter(e=>e.category===category)).length+' предметов';for(const e of entries)e.tile.hidden=category!=='all'&&e.category!==category;requestRender();}
function inspect(id,{focus=false}={}){
 const e=entries.find(e=>e.id===id);if(!e)return;activate(e);$('gallery').hidden=true;$('inspector').hidden=false;$('item-select').value=id;$('category-label').textContent=manifest.categories[e.category];$('hanzi').textContent=e.zh;$('pinyin').textContent=e.py;$('meaning').textContent=e.ru;$('note').textContent=e.note_ru??'Рассмотрите предмет со всех сторон и свяжите его форму с китайским названием.';$('download').href='./'+e.file;$('download').download=e.file;$('dimensions').textContent=Object.values(e.dimensions_m).map(v=>(v*100).toFixed(1)).join(' × ')+' см';resize();if(focus)renderer.domElement.focus({preventScroll:true});
}
function filter(value){category=value;for(const b of document.querySelectorAll('[data-category]'))b.setAttribute('aria-pressed',String(b.dataset.category===value));showGallery();}
function zoom(factor){camera.zoom=THREE.MathUtils.clamp(camera.zoom*factor,.55,3);camera.updateProjectionMatrix();render();}
async function initialize(){
 const response=await fetch('./manifest.json');if(!response.ok)throw Error('Не удалось прочитать каталог');manifest=await response.json();$('triangle-total').textContent=manifest.total_triangles;
 const loader=new GLTFLoader();
 for(const entry of manifest.models){
  const gltf=await loader.loadAsync('./'+entry.file),root=gltf.scene,holder=new THREE.Group(),span=Math.max(...Object.values(entry.dimensions_m)),scale=1.35/span;holder.scale.setScalar(scale);holder.add(root);holder.visible=false;root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});scene.add(holder);
  const e={...entry,holder,height:entry.dimensions_m.y*scale};entries.push(e);const option=document.createElement('option');option.value=e.id;option.textContent=e.ru;$('item-select').append(option);
 }
 frame(256,256);
 for(const e of entries){
  activate(e);render();const tile=document.createElement('button');tile.className='tile';tile.dataset.id=e.id;tile.setAttribute('aria-label',`${e.ru}: ${e.zh}, ${e.py}. Осмотреть`);
  const img=new Image();img.src=renderer.domElement.toDataURL('image/png');img.alt='Low-poly: '+e.ru;img.width=256;img.height=256;
  const body=document.createElement('div');body.className='tile-body';const title=document.createElement('div');title.className='tile-title';const zh=document.createElement('span');zh.className='zh';zh.lang='zh-Hans';zh.textContent=e.zh;const arrow=document.createElement('span');arrow.className='arrow';arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');title.append(zh,arrow);const py=document.createElement('span');py.className='py';py.textContent=e.py;const ru=document.createElement('span');ru.className='ru';ru.textContent=e.ru;body.append(title,py,ru);tile.append(img,body);tile.onclick=()=>inspect(e.id,{focus:true});e.tile=tile;$('gallery').append(tile);
 }
 showGallery();$('status').textContent='';ready=true;
}
for(const b of document.querySelectorAll('[data-category]'))b.onclick=()=>filter(b.dataset.category);
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view);
$('back').onclick=()=>{const id=current?.id;showGallery();entries.find(e=>e.id===id)?.tile.focus();};$('item-select').onchange=e=>inspect(e.target.value);$('zoom-in').onclick=()=>zoom(1.2);$('zoom-out').onclick=()=>zoom(1/1.2);$('reset').onclick=()=>setView('angle');
renderer.domElement.onkeydown=e=>{if(!current)return;if(['+','=','-','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))e.preventDefault();if(['+','='].includes(e.key))zoom(1.2);else if(e.key==='-')zoom(1/1.2);else if(e.key==='Home')setView('angle');else if(e.key.startsWith('Arrow')){const v=camera.position.clone().sub(controls.target),s=new THREE.Spherical().setFromVector3(v);s.theta+=e.key==='ArrowLeft'?-.15:e.key==='ArrowRight'?.15:0;s.phi=THREE.MathUtils.clamp(s.phi+(e.key==='ArrowUp'?-.15:e.key==='ArrowDown'?.15:0),.01,Math.PI*.495);camera.up.set(0,1,0);camera.position.copy(controls.target).add(v.setFromSpherical(s));controls.update();render();}};
window.goodsPreview={get ready(){return ready;},inspect,filter,setView,snapshot:()=>({selected:current?.id??null,category,view,zoom:camera.zoom,camera:camera.position.toArray(),models:entries.map(e=>({id:e.id,triangles:e.triangles})),dimensions:current?.dimensions_m})};
initialize().catch(error=>{console.error(error);$('status').textContent='Не удалось загрузить товары. Проверьте локальный сервер и установку зависимостей.';});