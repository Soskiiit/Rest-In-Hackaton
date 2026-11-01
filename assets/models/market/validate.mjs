import fs from 'node:fs';
import assert from 'node:assert/strict';
import validator from 'gltf-validator';
const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
for(const entry of manifest.models){
  const bytes=fs.readFileSync(entry.file);
  const result=await validator.validateBytes(new Uint8Array(bytes),{uri:entry.file,maxIssues:100});
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues,null,2));
  assert.equal(result.issues.numWarnings,0,JSON.stringify(result.issues,null,2));
  assert.equal(bytes.readUInt32LE(0),0x46546c67);
  assert.equal(bytes.readUInt32LE(8),bytes.length);
  const jsonLength=bytes.readUInt32LE(12);
  const doc=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
  assert.equal(doc.asset.version,'2.0');
  assert.deepEqual(doc.animations.map(a=>a.name),entry.animations);
  assert(entry.animations.every(name=>name in manifest.clips));
  assert(!doc.extensionsRequired?.length);
  assert(!doc.buffers.some(b=>b.uri));
  assert(!doc.images?.length);
  assert(!doc.skins?.length);
  let triangles=0;
  for(const node of doc.nodes)if(node.mesh!==undefined){
    for(const primitive of doc.meshes[node.mesh].primitives){
      const positions=doc.accessors[primitive.attributes.POSITION];
      assert(primitive.attributes.NORMAL!==undefined);
      const count=primitive.indices!==undefined?doc.accessors[primitive.indices].count:positions.count;
      assert.equal(count%3,0);triangles+=count/3;
    }
  }
  assert.equal(triangles,entry.triangles);assert(triangles<=1000);assert.equal(doc.meshes.length,entry.draw_calls);assert(entry.draw_calls<=16);assert(bytes.length<1_000_000);
  for(const anim of doc.animations){
    const targets=new Set();
    for(const channel of anim.channels){
      assert(doc.nodes[channel.target.node]);
      assert(['rotation','translation'].includes(channel.target.path));
      const key=channel.target.node+'/'+channel.target.path;
      assert(!targets.has(key),anim.name+': duplicate target '+key);targets.add(key);
      const sampler=anim.samplers[channel.sampler];
      const input=doc.accessors[sampler.input], output=doc.accessors[sampler.output];
      assert.equal(input.count,output.count);assert.equal(input.min[0],0);
      assert.equal(input.max[0],manifest.clips[anim.name]);
    }
  }
  const slots=doc.nodes.filter(n=>n.name.startsWith('Slot_'));
  assert.equal(slots.length,entry.slots);
  assert(slots.every(n=>n.mesh===undefined&&!n.children));
  // Slot_* anchors are intentionally empty nodes.
  const infos=result.issues.messages.filter(m=>m.severity>1&&!(m.code==='NODE_EMPTY'&&doc.nodes[+m.pointer.split('/')[2]].name.startsWith('Slot_')));
  console.log(entry.file+': '+triangles+' triangles, '+entry.draw_calls+' draw calls, '+slots.length+' slots, '+bytes.length+' bytes; Khronos validator: 0 errors, 0 warnings');
  if(infos.length)console.log('Info:',JSON.stringify(infos));
}
