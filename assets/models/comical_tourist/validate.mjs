import fs from'node:fs';import assert from'node:assert/strict';import{createRequire}from'node:module';import{createHash}from'node:crypto';import*as THREE from'three';import{GLTFLoader}from'three/addons/loaders/GLTFLoader.js';
const validator=createRequire(import.meta.url)('gltf-validator'),bytes=fs.readFileSync(new URL('./comical_tourist.glb',import.meta.url)),manifest=JSON.parse(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));const report=await validator.validateBytes(new Uint8Array(bytes),{uri:manifest.file});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));assert.equal(report.issues.numWarnings,0,JSON.stringify(report.issues));
const d=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12))),expected={Idle:3.2,Walk:1,Run:.65,Wave:2.2,Angry:1.8,Jump:1.2,FallBack:3.6};assert.deepEqual(d.animations.map(c=>c.name),Object.keys(expected));assert(!d.images?.length&&!d.textures?.length&&!d.skins?.length);assert(d.buffers.every(b=>!b.uri));assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);assert(manifest.triangles<=2000);assert(Math.abs(manifest.eye_height_m-1.7)<.001);
for(const c of d.animations)for(const channel of c.channels){assert.notEqual(channel.target.node,0);const a=d.accessors[c.samplers[channel.sampler].input];assert.equal(a.min[0],0);assert(Math.abs(a.max[0]-expected[c.name])<1e-5);}
const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),root=gltf.scene,mixer=new THREE.AnimationMixer(root),initial=new Map();root.traverse(n=>initial.set(n,{p:n.position.clone(),q:n.quaternion.clone(),s:n.scale.clone()}));
let triangles=0;root.traverse(n=>{if(n.isMesh)triangles+=n.geometry.index?n.geometry.index.count/3:n.geometry.attributes.position.count/3;});assert.equal(triangles,manifest.triangles);
function pose(clip,t){mixer.stopAllAction();for(const[n,s]of initial){n.position.copy(s.p);n.quaternion.copy(s.q);n.scale.copy(s.s);}const a=mixer.clipAction(clip);a.reset();a.clampWhenFinished=true;a.setLoop(THREE.LoopOnce,1).play();mixer.setTime(t);root.updateMatrixWorld(true);}
function state(){const data=[];root.traverse(n=>data.push(...n.position,...n.quaternion,...n.scale));return data;}
function minY(){let y=Infinity;root.traverse(n=>{if(n.isMesh){const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)y=Math.min(y,new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(n.matrixWorld).y);}});return y;}
const results=[];
for(const clip of gltf.animations){
 pose(clip,0);const start=state();let low=Infinity,high=-Infinity;
 for(let i=0;i<=240;i++){
  pose(clip,clip.duration*i/240);const floor=minY();low=Math.min(low,floor);high=Math.max(high,floor);assert(floor>=-.001,`${clip.name}: below ground ${floor}`);
  for(const side of ['L','R']){
   const hand=root.getObjectByName(side+'_Hand'),positions=hand.geometry.attributes.position;
   for(const name of ['BigHead','Shirt','BackpackBody','CameraBody']){
    const target=root.getObjectByName(name),inverse=target.matrixWorld.clone().invert();
    for(let k=0;k<positions.count;k++){const v=new THREE.Vector3().fromBufferAttribute(positions,k).applyMatrix4(hand.matrixWorld).applyMatrix4(inverse);assert(v.lengthSq()>.8,`${clip.name}: ${side} hand intersects ${name}`);}
   }
  }
 }
 pose(clip,clip.duration);const end=state(),delta=Math.max(...start.map((v,i)=>Math.abs(v-end[i])));assert(delta<1e-5,`${clip.name}: endpoint mismatch ${delta}`);results.push({clip:clip.name,minY:low,maxClearance:high});
}
for(const name of ['Walk','Run']){
 const clip=gltf.animations.find(c=>c.name===name);
 for(const side of ['L','R']){let previous=null,stance=0,swing=0;for(let i=0;i<=120;i++){const phase=i/120*2*Math.PI+(side==='L'?0:Math.PI);pose(clip,clip.duration*i/120);const z=root.getObjectByName(side+'_Ankle').getWorldPosition(new THREE.Vector3()).z,contact=Math.sin(phase)<-1e-5;if(previous&&contact&&previous.contact){assert(z<previous.z,`${name}: stance travels backward`);stance++;}if(previous&&!contact&&!previous.contact&&Math.sin(phase)>1e-5){assert(z>previous.z,`${name}: swing travels forward`);swing++;}previous={z,contact};}assert(stance>40&&swing>40);}
}
assert(results.find(c=>c.clip==='Jump').maxClearance>.4);assert(results.find(c=>c.clip==='FallBack').maxClearance>.4);
assert.equal(root.getObjectByName('Panama').parent.name,'Head');assert.equal(root.getObjectByName('Backpack').parent.name,'Torso');assert.equal(root.getObjectByName('Camera').parent.name,'Torso');
pose(gltf.animations[0],0);for(const name of ['CameraBody','CameraLens','BackpackBody','BackpackPocket']){const target=root.getObjectByName(name),shirt=root.getObjectByName('Shirt'),inverse=shirt.matrixWorld.clone().invert(),a=target.geometry.attributes.position;for(let i=0;i<a.count;i++){const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(target.matrixWorld).applyMatrix4(inverse);assert(v.lengthSq()>.8,`${name} enters shirt`);}}
console.log(JSON.stringify({errors:report.issues.numErrors,warnings:report.issues.numWarnings,triangles,bytes:bytes.length,clips:results},null,2));console.log('PASS: seven clips, closed endpoints, grounded poses, forward gait, hand/accessory clearance, no root motion');