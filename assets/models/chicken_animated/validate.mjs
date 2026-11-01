import fs from'node:fs';import assert from'node:assert/strict';import {createRequire}from'node:module';const require=createRequire(import.meta.url),validator=require('gltf-validator');
const bytes=fs.readFileSync(new URL('./chicken_animated.glb',import.meta.url));const r=await validator.validateBytes(new Uint8Array(bytes),{uri:'chicken_animated.glb'});console.log(JSON.stringify({errors:r.issues.numErrors,warnings:r.issues.numWarnings,messages:r.issues.messages.slice(0,8)},null,2));assert.equal(r.issues.numErrors,0);assert.equal(r.issues.numWarnings,0);
const d=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));assert.deepEqual(d.animations.map(a=>a.name),['Run','Peck','PanicRun']);assert.equal(d.skins[0].joints.length,12);assert(d.buffers.every(b=>!b.uri));assert(!d.images?.length);for(const a of d.animations)for(const c of a.channels)assert.notEqual(c.target.node,0);console.log('PASS: three embedded clips, 12 joints, no root motion or external resources');
// Regression: both feet must move backward during contact, forward during swing.
const binaryStart=28+bytes.readUInt32LE(12);
function values(index){const a=d.accessors[index],v=d.bufferViews[a.bufferView],width={SCALAR:1,VEC3:3,VEC4:4}[a.type];assert.equal(a.componentType,5126);return Array.from({length:a.count},(_,i)=>Array.from({length:width},(_,k)=>bytes.readFloatLE(binaryStart+(v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??width*4)+k*4)));}
for(const name of ['Run','PanicRun']){
 const a=d.animations.find(a=>a.name===name);
 for(const foot of ['Foot_L','Foot_R']){
  const node=d.nodes.findIndex(n=>n.name===foot),channel=a.channels.find(c=>c.target.node===node&&c.target.path==='translation');assert(channel);
  const s=a.samplers[channel.sampler],points=values(s.output),times=values(s.input).flat();assert(Math.abs(times.at(-1)-(name==='Run'?.72:.52))<1e-6);
  let contact=0,swing=0;
  for(let i=1;i<points.length;i++){const p=points[i-1],q=points[i],dz=q[2]-p[2];if(p[1]<-.0679&&q[1]<-.0679){assert(dz<0,`${name}/${foot}: backward gait`);contact++;}else if(p[1]>-.0679&&q[1]>-.0679){assert(dz>0,`${name}/${foot}: reversed swing`);swing++;}}
  assert(contact>=12&&swing>=12);assert(points[0].every((v,k)=>Math.abs(v-points.at(-1)[k])<1e-6));
 }
}
const headJoint=d.skins[0].joints.indexOf(d.nodes.findIndex(n=>n.name==='Head'));
for(const n of d.nodes.filter(n=>/^(Pixel|LensGlint|Temple)/.test(n.name??''))){for(const p of d.meshes[n.mesh].primitives){const a=d.accessors[p.attributes.JOINTS_0],v=d.bufferViews[a.bufferView];for(let i=0;i<a.count;i++)assert.equal(bytes.readUInt16LE(binaryStart+(v.byteOffset??0)+(a.byteOffset??0)+i*8),headJoint);}}
console.log('PASS: forward stance/swing for both feet and both runs; closed cycles; glasses weighted to Head');