import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const host=document.querySelector('#viewport'),status=document.querySelector('#status');
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;host.append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#f3d9d0');
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,30),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minZoom=.65;controls.maxZoom=2.5;controls.maxPolarAngle=Math.PI*.52;
scene.add(new THREE.HemisphereLight(0xfff7e4,0xb5a7a2,2));
const key=new THREE.DirectionalLight(0xffeed5,2.6);key.position.set(-3,6,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-2;key.shadow.camera.right=2;key.shadow.camera.top=2;key.shadow.camera.bottom=-2;key.shadow.normalBias=.015;scene.add(key);
const fill=new THREE.DirectionalLight(0xeaf4ff,1);fill.position.set(3,2,-2);scene.add(fill);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:'#f3d9d0',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.007;floor.receiveShadow=true;scene.add(floor);
let root,mixer,clips=[],active,paused=false,speed=1,view='front',selection='all';
const figures=[];
const each=callback=>{const saved={root,mixer,clips,active};for(const f of figures.filter(f=>f.holder.visible)){({root,mixer,clips,active}=f);callback(f);f.active=active;}({root,mixer,clips,active}=saved);};
function resize(){renderer.setSize(host.clientWidth,host.clientHeight);const aspect=host.clientWidth/host.clientHeight,h=selection==='all'?2.35:selection==='vendor_round'?1.45:1.03;camera.left=-h*aspect;camera.right=h*aspect;camera.top=h;camera.bottom=-h;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(host);
function setView(value){view=value;camera.zoom=1;controls.target.set(0,.85,0);const positions={front:[0,1.1,5],angle:[3,1.8,5],side:[5,1.1,0],back:[0,1.1,-5]};camera.position.fromArray(positions[value]);controls.update();camera.updateProjectionMatrix();}
function playOne(name){if(!mixer)return;const clip=clips.find(c=>c.name===name);if(!clip)return;const next=mixer.clipAction(clip);next.reset();next.enabled=true;next.setEffectiveWeight(1);next.setEffectiveTimeScale(1);next.setLoop(['Wave','Angry','FallBack'].includes(name)?THREE.LoopOnce:THREE.LoopRepeat,Infinity);next.clampWhenFinished=true;if(active&&active!==next){active.crossFadeTo(next,.12,false);}next.play();active=next;for(const button of document.querySelectorAll('[data-clip]'))button.setAttribute('aria-pressed',String(button.dataset.clip===name));}
function poseOne(name,time){paused=true;document.querySelector('#pause').textContent='Продолжить';document.querySelector('#pause').setAttribute('aria-pressed','true');mixer.stopAllAction();root.traverse(node=>{const initial=node.userData.initial;if(initial){node.position.fromArray(initial.position);node.quaternion.fromArray(initial.quaternion);node.scale.fromArray(initial.scale);}});const clip=clips.find(c=>c.name===name),action=mixer.clipAction(clip);action.reset();action.clampWhenFinished=true;action.setLoop(THREE.LoopOnce,1).play();active=action;mixer.setTime(time);root.updateMatrixWorld(true);}
function snapshot(){root.updateMatrixWorld(true);const nodes={};for(const name of ['Hips','Head','L_Shoulder','R_Shoulder','L_Hip','R_Hip','L_BrowPivot','R_BrowPivot','MustachePivot']){const node=root.getObjectByName(name);nodes[name]={position:node.position.toArray(),quaternion:node.quaternion.toArray(),world:node.getWorldPosition(new THREE.Vector3()).toArray()};}const box=new THREE.Box3();root.traverse(n=>{if(n.isMesh){const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)box.expandByPoint(new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(n.matrixWorld));}});return {nodes,bounds:{min:box.min.toArray(),max:box.max.toArray()},clips:clips.map(c=>({name:c.name,duration:c.duration})),view,paused};}
function play(name){each(()=>playOne(name));}
function pose(name,time,render=true){each(()=>poseOne(name,time));if(render)renderer.render(scene,camera);}
function selectCharacter(value){
 selection=value;floor.visible=value!=='all';
 figures.forEach((f,i)=>{f.holder.visible=value==='all'?i>0:f.id===value;if(value==='all'){const n=i-1,row=Math.floor(n/4),columns=Math.min(4,figures.length-1-row*4);f.holder.position.set((n%4-(columns-1)/2)*1.8,row===0?1.15:-1.05,0);}else f.holder.position.set(0,0,0);f.platform.visible=value==='all';});
 const f=figures.find(f=>f.holder.visible);({root,mixer,clips,active}=f);document.querySelector('a[download]').href=value==='all'?'./variants.json':'./'+f.file;document.querySelector('a[download]').textContent=value==='all'?'Манифест набора ↓':'Скачать GLB ↓';
 document.querySelector('[data-clip=FallBack]').disabled=value!=='vendor_round';
 setView(view);resize();
 status.textContent=value==='all'?'Семь вариантов · выберите круглощёкого для падения':f.label+' · '+f.triangles+' треугольников';
}
async function initialize(){
 const variants=await(await fetch('./variants.json')).json();
 const entries=[{id:'original',label:'Исходный красный',file:'comical_vendor.glb',triangles:1180},...variants.models];
 for(const entry of entries){
  const gltf=await new GLTFLoader().loadAsync('./'+entry.file),holder=new THREE.Group();root=gltf.scene;clips=gltf.animations;
  root.traverse(node=>{node.userData.initial={position:node.position.toArray(),quaternion:node.quaternion.toArray(),scale:node.scale.toArray()};if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
  holder.add(root);scene.add(holder);mixer=new THREE.AnimationMixer(root);active=null;
  const platform=new THREE.Mesh(new THREE.CylinderGeometry(.78,.78,.025,32),new THREE.MeshStandardMaterial({color:'#e8c9bc',roughness:1}));platform.position.y=-.022;platform.receiveShadow=true;holder.add(platform);
  const figure={...entry,root,clips,mixer,holder,platform,active};figures.push(figure);
  mixer.addEventListener('finished',event=>{if(event.action.getClip().name==='FallBack')return;if(!paused){const old={root,mixer,clips,active};({root,mixer,clips,active}=figure);playOne('Idle');figure.active=active;({root,mixer,clips,active}=old);}});
  playOne('Idle');figure.active=active;
  const option=document.createElement('option');option.value=entry.id;option.textContent=entry.label;document.querySelector('#character').append(option);
 }
 selectCharacter('all');window.vendorPreview.ready=true;
}
initialize().catch(error=>{status.classList.add('error');status.textContent='Не удалось загрузить коллекцию';console.error(error);});
document.querySelector('#character').onchange=e=>selectCharacter(e.target.value);
for(const button of document.querySelectorAll('[data-clip]'))button.addEventListener('click',()=>{paused=false;document.querySelector('#pause').textContent='Пауза';document.querySelector('#pause').setAttribute('aria-pressed','false');play(button.dataset.clip);});
document.querySelector('#pause').onclick=()=>{paused=!paused;document.querySelector('#pause').textContent=paused?'Продолжить':'Пауза';document.querySelector('#pause').setAttribute('aria-pressed',String(paused));};
document.querySelector('#camera').onchange=event=>setView(event.target.value);
document.querySelector('#speed').oninput=event=>{speed=Number(event.target.value);document.querySelector('#speed-value').textContent=speed+'×';};
window.vendorPreview={ready:false,play,pose,snapshot,setView,selectCharacter,list:()=>figures.map(f=>({id:f.id,label:f.label,clips:f.clips.map(c=>({name:c.name,duration:c.duration}))})),render:()=>renderer.render(scene,camera)};
setView('front');resize();let last=performance.now();renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(!paused)for(const f of figures)if(f.holder.visible)f.mixer.update(dt*speed);controls.update();renderer.render(scene,camera);});
