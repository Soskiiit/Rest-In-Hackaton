import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),validator=require('gltf-validator');
const dir=path.dirname(fileURLToPath(import.meta.url));
const entries=[{file:'comical_vendor.glb'},...JSON.parse(fs.readFileSync(path.join(dir,'variants.json'),'utf8')).models];
for(const entry of entries){
const bytes=fs.readFileSync(path.join(dir,entry.file));
const result=await validator.validateBytes(new Uint8Array(bytes),{uri:entry.file});
assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues));assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues));
const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
assert.deepEqual(doc.animations.map(a=>a.name),entry.file==='vendor_round.glb'?['Idle','Wave','Angry','Walk','FallBack']:['Idle','Wave','Angry','Walk']);assert(!doc.images?.length);assert(!doc.skins?.length);assert(!doc.extensionsRequired?.length);assert(doc.buffers.every(b=>!b.uri));
let triangles=0;for(const node of doc.nodes)if(node.mesh!==undefined)for(const primitive of doc.meshes[node.mesh].primitives){triangles+=doc.accessors[primitive.indices].count/3;assert(primitive.attributes.NORMAL!==undefined);}
assert(triangles<=2000);const durations={Idle:3.2,Wave:2.2,Angry:1.8,Walk:1,FallBack:3.6};
for(const clip of doc.animations){for(const channel of clip.channels){assert.notEqual(channel.target.node,0,'root motion is forbidden');const sampler=clip.samplers[channel.sampler],input=doc.accessors[sampler.input],output=doc.accessors[sampler.output];assert.equal(input.count,output.count);assert.equal(input.min[0],0);assert(Math.abs(input.max[0]-durations[clip.name])<1e-5);}}
console.log(JSON.stringify({file:entry.file,triangles,bytes:bytes.length,materials:doc.materials.length,errors:result.issues.numErrors,warnings:result.issues.numWarnings,clips:doc.animations.map(a=>a.name)},null,2));

}

await import('./test_round.mjs');
