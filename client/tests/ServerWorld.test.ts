import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { ServerWorld } from '../src/engine/ServerWorld';

describe('Server-authoritative online chunks', () => {
  it('uses server item coordinates and evicts entities and GPU geometry on unload', () => {
    const scene = new THREE.Scene();
    const world = new ServerWorld(scene);
    world.load({ chunk_id:'5_5', items:[{item_id:'teapot',x:12,y:1,z:10}] });
    expect(world.nearest('items',112,110)).toEqual({id:'teapot',x:112,z:110});
    const mesh = (scene.children[0] as THREE.Group).children[0] as THREE.Mesh;
    const dispose = vi.spyOn(mesh.geometry,'dispose');
    world.unload(['5_5']);
    expect(dispose).toHaveBeenCalledOnce();
    expect(world.nearest('items',112,110)).toBeNull();
    expect(world.count).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
  it('replaces duplicate chunks and resets server telemetry across reconnects', () => {
    const scene = new THREE.Scene();
    const world = new ServerWorld(scene);
    world.load({chunk_id:'0_0'});
    world.load({chunk_id:'0_0'});
    expect(scene.children).toHaveLength(1);
    expect(world.count).toBe(1);
    world.dataPercent = 9;
    world.clear();
    expect(world.dataPercent).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});
