// Geometry regressions on the exported GLB, using the same Three.js loader as the viewer.
import fs from 'node:fs';import assert from 'node:assert/strict';import * as THREE from 'three';import {GLTFLoader}from 'three/addons/loaders/GLTFLoader.js';
const bytes=fs.readFileSync(new URL('./vendor_round.glb',import.meta.url));
const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const root=gltf.scene,mixer=new THREE.AnimationMixer(root),initial=new Map();root.traverse(n=>initial.set(n,{p:n.position.clone(),q:n.quaternion.clone(),s:n.scale.clone()}));
function pose(clip,time){mixer.stopAllAction();for(const[n,v]of initial){n.position.copy(v.p);n.quaternion.copy(v.q);n.scale.copy(v.s);}const a=mixer.clipAction(clip);a.reset();a.clampWhenFinished=true;a.setLoop(THREE.LoopOnce,1).play();mixer.setTime(time);root.updateMatrixWorld(true);}
function state(){const result=[];root.traverse(n=>result.push(...n.position,...n.quaternion,...n.scale));return result;}
function minimum(){let y=Infinity;root.traverse(n=>{if(n.isMesh){const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)y=Math.min(y,new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(n.matrixWorld).y);}});return y;}
const results=[];
for(const clip of gltf.animations){
 pose(clip,0);const start=state();let minY=Infinity,maxY=-Infinity;
 for(let i=0;i<=240;i++){
  pose(clip,clip.duration*i/240);const y=minimum();minY=Math.min(minY,y);maxY=Math.max(maxY,y);assert(y>=-.001,`${clip.name}: geometry below ground: ${y}`);
  if(clip.name==='FallBack'&&Math.abs(root.getObjectByName('ActionPivot').quaternion.x)>.21){
   const inverse=root.getObjectByName('Hat').matrixWorld.clone().invert();
   root.getObjectByName('Head').traverse(n=>{if(n.isMesh&&!['ConeHat','HatUnderside'].includes(n.name)){const a=n.geometry.attributes.position;for(let k=0;k<a.count;k++){const v=new THREE.Vector3().fromBufferAttribute(a,k).applyMatrix4(n.matrixWorld).applyMatrix4(inverse);assert(v.y<0,'falling hat must clear the head and face');}}});
  }
  for(const side of ['L','R']){
   const hand=root.getObjectByName(side+'_Mitten'),head=root.getObjectByName('BigHead'),coat=root.getObjectByName('Coat');
   for(const target of [head,coat]){
    const inverse=target.matrixWorld.clone().invert(),a=hand.geometry.attributes.position;
    for(let k=0;k<a.count;k++){const v=new THREE.Vector3().fromBufferAttribute(a,k).applyMatrix4(hand.matrixWorld).applyMatrix4(inverse);assert(v.lengthSq()>.8,`${clip.name}: hand enters ${target.name}`);}
   }
  }
 }
 pose(clip,clip.duration);const end=state();assert(Math.max(...start.map((v,i)=>Math.abs(v-end[i])))<1e-5,`${clip.name}: endpoints differ`);
 results.push({clip:clip.name,minY,maxY});
}
assert(results.find(r=>r.clip==='FallBack').maxY>.4,'jump must lift entire character');
console.log('PASS: Three.js geometry, 1205 sampled poses, grounded clips, hand clearance, jump and endpoints',JSON.stringify(results));