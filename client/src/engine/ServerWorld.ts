import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ChunkBuilder, disposeHierarchy } from './ChunkBuilder';

export interface Entity { id: string; x: number; z: number }
export interface ServerChunk {
  chunk_id: string;
  buildings?: Array<{ x: number; z: number }>;
  lanterns?: Array<{ x: number; y: number; z: number }>;
  npcs?: Array<{ npc_id: string; x: number; y?: number; z: number }>;
  items?: Array<{ item_id: string; x: number; y?: number; z: number }>;
}

/** Only server-authorized chunks are retained in online mode. */
export class ServerWorld {
  private chunks = new Map<string, { group: THREE.Group; data: ServerChunk }>();
  private loader = new GLTFLoader();
  public dataPercent = 0;
  constructor(private scene: THREE.Scene) {}
  get count(): number { return this.chunks.size; }
  load(data: ServerChunk): void {
    this.unload([data.chunk_id]);
    const [cx, cz] = data.chunk_id.split('_').map(Number);
    const group = new THREE.Group();
    group.name = `server_chunk_${data.chunk_id}`;
    group.position.set(cx * 20, 0, cz * 20);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x292b32, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(10, 0.03, 10);
    group.add(ground);
    for (const building of data.buildings ?? []) group.add(ChunkBuilder.buildStall({ ...building, hasLantern: false }));
    for (const lantern of data.lanterns ?? []) group.add(ChunkBuilder.buildLantern(lantern));
    this.chunks.set(data.chunk_id, { group, data });
    this.scene.add(group);
    for (const npc of data.npcs ?? []) {
      const base = new THREE.Group();
      base.position.set(npc.x, npc.y ?? 0, npc.z);
      base.name = npc.npc_id;
      group.add(base);
      const url = npc.npc_id === 'lao_wang' || npc.npc_id === 'chef_chen'
        ? `/models/vendors/${npc.npc_id}.glb` : '/models/npc_man.glb';
      this.loader.load(url, (gltf) => {
        if (this.chunks.get(data.chunk_id)?.group !== group) { disposeHierarchy(gltf.scene); return; }
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const height = box.getSize(new THREE.Vector3()).y || 1;
        gltf.scene.scale.setScalar(1.8 / height);
        base.add(gltf.scene);
      }, undefined, () => {
        if (this.chunks.get(data.chunk_id)?.group !== group) return;
        const marker = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1), new THREE.MeshStandardMaterial({ color: 0xb23037 }));
        marker.position.y = 0.9;
        base.add(marker);
      });
    }
    for (const item of data.items ?? []) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xd3b567, metalness: 0.3, roughness: 0.5 }));
      mesh.name = item.item_id;
      mesh.position.set(item.x, item.y ?? 1, item.z);
      group.add(mesh);
    }
  }
  unload(ids: string[]): void {
    for (const id of ids) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      this.scene.remove(chunk.group);
      disposeHierarchy(chunk.group);
      this.chunks.delete(id);
    }
  }
  clear(): void { this.unload([...this.chunks.keys()]); this.dataPercent = 0; }
  nearest(kind: 'npcs' | 'items', x: number, z: number): Entity | null {
    let nearest: Entity | null = null;
    let distance = 25;
    for (const { data } of this.chunks.values()) {
      const [cx, cz] = data.chunk_id.split('_').map(Number);
      for (const entry of data[kind] ?? []) {
        const id = 'npc_id' in entry ? entry.npc_id : entry.item_id;
        const target = { id, x: cx * 20 + entry.x, z: cz * 20 + entry.z };
        const d = (target.x - x) ** 2 + (target.z - z) ** 2;
        if (d <= distance) { nearest = target; distance = d; }
      }
    }
    return nearest;
  }
}
