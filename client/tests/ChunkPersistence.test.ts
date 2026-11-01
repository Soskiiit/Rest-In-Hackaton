/**
 * ChunkPersistence.test.ts
 *
 * Automated Vitest Test Suite for Milestone M4:
 * Chunk Configuration Persistence, Go-Compatible Serialization,
 * Coordinate Transformations, Cross-Chunk Entity Migration & Storage Backends.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CHUNK_SIZE,
  WORLD_GRID_SIZE,
  WORLD_MAX,
  getChunkCoords,
  worldToLocal,
  localToWorld,
  createEmptyChunk,
  validateChunkData,
  sanitizeChunkData,
  isValidLocalCoord,
  serializeEntitiesToChunks,
  deserializeChunkToEntities,
  migrateEntity,
  ChunkPersistence,
  RawChunkData,
} from '../src/editor/ChunkPersistence';
import {
  HttpChunkStorage,
  LocalStorageChunkStorage,
  MockChunkStorage,
  CompositeChunkStorage,
} from '../src/editor/ChunkStorage';
// @ts-ignore
import { levelEditorPlugin } from '../vite.config';

describe('Milestone M4: Chunk Persistence, Coordinate Transforms & Go Schema', () => {
  // ==========================================================================
  // 1. Coordinate Transformation Engine
  // ==========================================================================
  describe('1. Coordinate Transformations (World <-> Chunk / Local Math)', () => {
    it('should map world coordinates to chunk grid indices and format chunkId as cx_cz', () => {
      // Origin
      expect(getChunkCoords(0, 0)).toEqual({ cx: 0, cz: 0, chunkId: '0_0' });
      // Within first chunk
      expect(getChunkCoords(10.5, 19.9)).toEqual({ cx: 0, cz: 0, chunkId: '0_0' });
      // Boundary crossing into chunk (1, 1)
      expect(getChunkCoords(20.0, 20.0)).toEqual({ cx: 1, cz: 1, chunkId: '1_1' });
      // Middle of world (100, 100)
      expect(getChunkCoords(100.0, 100.0)).toEqual({ cx: 5, cz: 5, chunkId: '5_5' });
      // Far corner (180..200)
      expect(getChunkCoords(185.0, 199.9)).toEqual({ cx: 9, cz: 9, chunkId: '9_9' });
    });

    it('should safely clamp out-of-bounds coordinates to the 10x10 world grid', () => {
      // Negative coordinates clamp to 0
      expect(getChunkCoords(-15.0, -50.0)).toEqual({ cx: 0, cz: 0, chunkId: '0_0' });
      // Beyond 200 coordinates clamp to 9
      expect(getChunkCoords(250.0, 500.0)).toEqual({ cx: 9, cz: 9, chunkId: '9_9' });
    });

    it('should calculate local coordinates strictly within [0..20) range', () => {
      // Inside chunk 0_0
      expect(worldToLocal(0, 0)).toEqual({ lx: 0, lz: 0 });
      expect(worldToLocal(5.25, 14.75)).toEqual({ lx: 5.25, lz: 14.75 });

      // Inside chunk 1_2 (world coords 25, 47)
      expect(worldToLocal(25.0, 47.0)).toEqual({ lx: 5.0, lz: 7.0 });

      // Seam edge at 20.0 -> local 0.0 of next chunk
      expect(worldToLocal(20.0, 40.0)).toEqual({ lx: 0.0, lz: 0.0 });

      // Near boundary edge (19.99)
      const nearEdge = worldToLocal(19.99, 39.99);
      expect(nearEdge.lx).toBeCloseTo(19.99, 2);
      expect(nearEdge.lz).toBeCloseTo(19.99, 2);
      expect(nearEdge.lx).toBeLessThan(20.0);
      expect(nearEdge.lz).toBeLessThan(20.0);

      // Boundary clamp on extreme coordinates
      const clampedMax = worldToLocal(200.0, 200.0);
      expect(clampedMax.lx).toBeLessThan(20.0);
      expect(clampedMax.lz).toBeLessThan(20.0);
      expect(clampedMax.lx).toBeGreaterThanOrEqual(0.0);
      expect(clampedMax.lz).toBeGreaterThanOrEqual(0.0);
    });

    it('should transform local coordinates back to world coordinates accurately', () => {
      // Chunk 0_0
      expect(localToWorld(0, 0, 5, 7)).toEqual({ wx: 5, wz: 7 });
      // Chunk 2_3: wx = 2 * 20 + 4 = 44, wz = 3 * 20 + 8.5 = 68.5
      expect(localToWorld(2, 3, 4, 8.5)).toEqual({ wx: 44, wz: 68.5 });
      // Chunk 9_9: wx = 9 * 20 + 15 = 195, wz = 9 * 20 + 19 = 199
      expect(localToWorld(9, 9, 15, 19)).toEqual({ wx: 195, wz: 199 });
    });

    it('should perform reversible roundtrip transformations (world -> local -> world)', () => {
      const testPoints = [
        { wx: 3.5, wz: 7.2 },
        { wx: 25.1, wz: 42.8 },
        { wx: 105.0, wz: 112.5 },
        { wx: 178.4, wz: 189.9 },
      ];

      for (const pt of testPoints) {
        const { cx, cz } = getChunkCoords(pt.wx, pt.wz);
        const { lx, lz } = worldToLocal(pt.wx, pt.wz);
        const reconstructed = localToWorld(cx, cz, lx, lz);

        expect(reconstructed.wx).toBeCloseTo(pt.wx, 3);
        expect(reconstructed.wz).toBeCloseTo(pt.wz, 3);
      }
    });

    it('should expose static coordinate helpers on ChunkPersistence orchestrator', () => {
      expect(ChunkPersistence.CHUNK_SIZE).toBe(CHUNK_SIZE);
      expect(ChunkPersistence.WORLD_GRID_SIZE).toBe(WORLD_GRID_SIZE);
      expect(ChunkPersistence.WORLD_MAX).toBe(WORLD_MAX);
      expect(ChunkPersistence.getChunkCoords(10, 10)).toEqual(getChunkCoords(10, 10));
      expect(ChunkPersistence.worldToLocal(10, 10)).toEqual(worldToLocal(10, 10));
      expect(ChunkPersistence.localToWorld(0, 0, 10, 10)).toEqual(localToWorld(0, 0, 10, 10));
    });
  });

  // ==========================================================================
  // 2. Go-Compatible Schema Validation & Strict Non-Null Invariants
  // ==========================================================================
  describe('2. Go-Compatible Schema Validation & Strict Non-Null Arrays', () => {
    it('should create an empty chunk with all 5 arrays initialized non-null', () => {
      const chunk = createEmptyChunk('3_4');
      expect(chunk.chunk_id).toBe('3_4');
      expect(Array.isArray(chunk.buildings)).toBe(true);
      expect(Array.isArray(chunk.lanterns)).toBe(true);
      expect(Array.isArray(chunk.signs)).toBe(true);
      expect(Array.isArray(chunk.npcs)).toBe(true);
      expect(Array.isArray(chunk.items)).toBe(true);

      expect(chunk.buildings.length).toBe(0);
      expect(chunk.lanterns.length).toBe(0);
      expect(chunk.signs.length).toBe(0);
      expect(chunk.npcs.length).toBe(0);
      expect(chunk.items.length).toBe(0);

      // Must validate successfully
      expect(validateChunkData(chunk)).toBe(true);
    });

    it('should validate valid populated chunks matching server/world/chunks structure', () => {
      const validChunk: RawChunkData = {
        chunk_id: '5_6',
        buildings: [
          { type: 'stall', x: 3, z: 4 },
          { type: 'stall', x: 15, z: 16 },
        ],
        lanterns: [
          { x: 4, y: 3, z: 5 },
          { x: 14, y: 3, z: 15 },
        ],
        signs: [{ text: '夜市', x: 3, y: 3, z: 4 }],
        npcs: [{ npc_id: 'lao_wang', x: 0, y: 0, z: 4 }],
        items: [
          { item_id: 'teapot', x: 1, y: 1, z: 4 },
          { item_id: 'jade_amulet', x: 1, y: 1, z: 5 },
        ],
      };

      expect(validateChunkData(validChunk)).toBe(true);
    });

    it('should reject invalid chunks missing any required array slice', () => {
      // Null buildings array (which causes Go unmarshal error)
      const missingBuildings = {
        chunk_id: '0_0',
        buildings: null as any,
        lanterns: [],
        signs: [],
        npcs: [],
        items: [],
      };
      expect(validateChunkData(missingBuildings)).toBe(false);

      // Undefined npcs array
      const missingNpcs = {
        chunk_id: '0_0',
        buildings: [],
        lanterns: [],
        signs: [],
        items: [],
      };
      expect(validateChunkData(missingNpcs)).toBe(false);

      // Invalid chunk_id format
      const invalidId = {
        chunk_id: 'invalid_format',
        buildings: [],
        lanterns: [],
        signs: [],
        npcs: [],
        items: [],
      };
      expect(validateChunkData(invalidId)).toBe(false);
    });

    it('should reject entities with out-of-bounds local coordinates', () => {
      expect(isValidLocalCoord(0, 0)).toBe(true);
      expect(isValidLocalCoord(19.99, 19.99)).toBe(true);
      expect(isValidLocalCoord(-0.1, 5)).toBe(false);
      expect(isValidLocalCoord(5, 20.0)).toBe(false);
      expect(isValidLocalCoord(NaN, 5)).toBe(false);
      expect(isValidLocalCoord(5, Infinity)).toBe(false);

      const invalidBuildingChunk: RawChunkData = {
        chunk_id: '1_1',
        buildings: [{ type: 'stall', x: 20.5, z: 5 }],
        lanterns: [],
        signs: [],
        npcs: [],
        items: [],
      };
      expect(validateChunkData(invalidBuildingChunk)).toBe(false);
    });

    it('should sanitize partial or malformed chunk data into strict non-null arrays', () => {
      const malformed: any = {
        chunk_id: '4_2',
        buildings: [{ type: 'stall', x: 2, z: 3 }],
        // lanterns, signs, npcs, items omitted
      };

      const sanitized = sanitizeChunkData(malformed);
      expect(sanitized.chunk_id).toBe('4_2');
      expect(sanitized.buildings.length).toBe(1);
      expect(Array.isArray(sanitized.lanterns)).toBe(true);
      expect(Array.isArray(sanitized.signs)).toBe(true);
      expect(Array.isArray(sanitized.npcs)).toBe(true);
      expect(Array.isArray(sanitized.items)).toBe(true);
      expect(validateChunkData(sanitized)).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Cross-Chunk Boundary Migration
  // ==========================================================================
  describe('3. Cross-Chunk Entity Boundary Migration', () => {
    let chunks: Map<string, RawChunkData>;

    beforeEach(() => {
      chunks = new Map<string, RawChunkData>();
      const chunk00 = createEmptyChunk('0_0');
      chunk00.buildings.push({ type: 'stall', x: 5, z: 5 });
      chunk00.npcs.push({ npc_id: 'lao_wang', x: 2, y: 0, z: 2 });
      chunks.set('0_0', chunk00);
    });

    it('should update local coordinates when entity moves within the same chunk', () => {
      const entity = { type: 'npc', npc_id: 'lao_wang', id: 'lao_wang', x: 2, y: 0, z: 2 };
      const res = migrateEntity(chunks, entity, 2, 2, 8, 8, 0);

      expect(res.migrated).toBe(false);
      expect(res.oldChunkId).toBe('0_0');
      expect(res.newChunkId).toBe('0_0');
      expect(res.newLocalCoords).toEqual({ lx: 8, lz: 8 });

      const c00 = chunks.get('0_0')!;
      expect(c00.npcs.length).toBe(1);
      expect(c00.npcs[0]!.npc_id).toBe('lao_wang');
      expect(c00.npcs[0]!.x).toBe(8);
      expect(c00.npcs[0]!.z).toBe(8);
    });

    it('should migrate entity across chunk boundary from chunk c1 to chunk c2', () => {
      // Move from (5, 5) in chunk 0_0 to (25, 5) in chunk 1_0 (crosses X=20 boundary)
      const entity = { type: 'building', buildingType: 'stall', id: 'stall_1', x: 5, z: 5 };
      const res = migrateEntity(chunks, entity, 5, 5, 25, 5, 0);

      expect(res.migrated).toBe(true);
      expect(res.oldChunkId).toBe('0_0');
      expect(res.newChunkId).toBe('1_0');
      // Local coordinate in chunk 1_0: 25 - 20 = 5
      expect(res.newLocalCoords).toEqual({ lx: 5, lz: 5 });

      // Check chunk 0_0: building removed
      const c00 = chunks.get('0_0')!;
      expect(c00.buildings.length).toBe(0);

      // Check chunk 1_0: building added with local coordinates
      const c10 = chunks.get('1_0')!;
      expect(c10).toBeDefined();
      expect(c10.buildings.length).toBe(1);
      expect(c10.buildings[0]!.type).toBe('stall');
      expect(c10.buildings[0]!.x).toBe(5);
      expect(c10.buildings[0]!.z).toBe(5);
    });

    it('should handle diagonal boundary crossing into a newly created chunk', () => {
      // Move from (2, 2) in 0_0 to (65, 85) in 3_4
      const entity = { type: 'npc', npc_id: 'lao_wang', id: 'lao_wang' };
      const res = migrateEntity(chunks, entity, 2, 2, 65, 85, 1.5);

      expect(res.migrated).toBe(true);
      expect(res.oldChunkId).toBe('0_0');
      expect(res.newChunkId).toBe('3_4');
      // Local coordinates: 65 - 3 * 20 = 5; 85 - 4 * 20 = 5
      expect(res.newLocalCoords).toEqual({ lx: 5, lz: 5 });

      // Old chunk npcs empty
      expect(chunks.get('0_0')!.npcs.length).toBe(0);

      // New chunk 3_4 created and npc indexed with 3D Y coordinate
      const c34 = chunks.get('3_4')!;
      expect(c34).toBeDefined();
      expect(c34.npcs.length).toBe(1);
      expect(c34.npcs[0]).toEqual({ npc_id: 'lao_wang', x: 5, y: 1.5, z: 5 });
    });

    it('should update mutable entity position and tracking properties on migration', () => {
      const positionObj = { x: 5, y: 0, z: 5, set: vi.fn() };
      const mutableEntity = {
        type: 'lantern',
        chunkId: '0_0',
        worldX: 5,
        worldZ: 5,
        localX: 5,
        localZ: 5,
        position: positionObj,
      };

      migrateEntity(chunks, mutableEntity, 5, 5, 45, 65, 3);

      expect(mutableEntity.chunkId).toBe('2_3');
      expect(mutableEntity.worldX).toBe(45);
      expect(mutableEntity.worldZ).toBe(65);
      expect(mutableEntity.localX).toBe(5);
      expect(mutableEntity.localZ).toBe(5);
      expect(positionObj.set).toHaveBeenCalledWith(45, 3, 65);
    });
  });

  // ==========================================================================
  // 4. Serialization & Roundtrip Deserialization
  // ==========================================================================
  describe('4. Serialization & Roundtrip Deserialization', () => {
    it('should serialize mixed entities into proper chunks with non-null arrays', () => {
      const entities = [
        { type: 'building', assetId: 'stall', worldX: 3, worldZ: 4 },
        { type: 'lantern', worldX: 4, worldY: 3, worldZ: 5 },
        { type: 'sign', text: '夜市', worldX: 3, worldY: 3, worldZ: 4 },
        { type: 'npc', npc_id: 'lao_wang', worldX: 20, worldY: 0, worldZ: 24 }, // chunk 1_1
        { type: 'item', item_id: 'teapot', worldX: 21, worldY: 1, worldZ: 24 }, // chunk 1_1
      ];

      const chunkMap = serializeEntitiesToChunks(entities);
      expect(chunkMap.size).toBe(2);
      expect(chunkMap.has('0_0')).toBe(true);
      expect(chunkMap.has('1_1')).toBe(true);

      const c00 = chunkMap.get('0_0')!;
      expect(c00.buildings).toEqual([{ type: 'stall', x: 3, z: 4 }]);
      expect(c00.lanterns).toEqual([{ x: 4, y: 3, z: 5 }]);
      expect(c00.signs).toEqual([{ text: '夜市', x: 3, y: 3, z: 4 }]);
      expect(c00.npcs).toEqual([]);
      expect(c00.items).toEqual([]);

      const c11 = chunkMap.get('1_1')!;
      expect(c11.npcs).toEqual([{ npc_id: 'lao_wang', x: 0, y: 0, z: 4 }]);
      expect(c11.items).toEqual([{ item_id: 'teapot', x: 1, y: 1, z: 4 }]);
      expect(c11.buildings).toEqual([]);
      expect(c11.lanterns).toEqual([]);
      expect(c11.signs).toEqual([]);

      expect(validateChunkData(c00)).toBe(true);
      expect(validateChunkData(c11)).toBe(true);
    });

    it('should deserialize chunk data into entities with matching world and local coordinates', () => {
      const rawChunk: RawChunkData = {
        chunk_id: '2_3',
        buildings: [{ type: 'stall', x: 4, z: 6 }],
        lanterns: [{ x: 5, y: 3, z: 7 }],
        signs: [{ text: 'Market', x: 4, y: 2, z: 6 }],
        npcs: [{ npc_id: 'guard_zhang', x: 1, y: 0, z: 2 }],
        items: [{ item_id: 'noodles', x: 8, y: 1, z: 9 }],
      };

      const entities = deserializeChunkToEntities(rawChunk);
      expect(entities.length).toBe(5);

      // Building check: cx=2, cz=3 -> wx = 2*20 + 4 = 44, wz = 3*20 + 6 = 66
      const building = entities.find((e) => e.type === 'building')!;
      expect(building.worldX).toBe(44);
      expect(building.worldZ).toBe(66);
      expect(building.localX).toBe(4);
      expect(building.localZ).toBe(6);
      expect(building.chunkId).toBe('2_3');

      // NPC check: wx = 2*20 + 1 = 41, wz = 3*20 + 2 = 62
      const npc = entities.find((e) => e.type === 'npc')!;
      expect(npc.npc_id).toBe('guard_zhang');
      expect(npc.worldX).toBe(41);
      expect(npc.worldZ).toBe(62);
      expect(npc.worldY).toBe(0);
    });

    it('should perform flawless roundtrip: Chunk -> Deserialized Entities -> Serialized Chunk', () => {
      const originalChunk: RawChunkData = {
        chunk_id: '5_6',
        buildings: [
          { type: 'stall', x: 3, z: 4 },
          { type: 'stall', x: 15, z: 16 },
        ],
        lanterns: [
          { x: 4, y: 3, z: 5 },
          { x: 14, y: 3, z: 15 },
        ],
        signs: [{ text: '夜市', x: 3, y: 3, z: 4 }],
        npcs: [{ npc_id: 'lao_wang', x: 0, y: 0, z: 4 }],
        items: [
          { item_id: 'teapot', x: 1, y: 1, z: 4 },
          { item_id: 'jade_amulet', x: 1, y: 1, z: 5 },
        ],
      };

      const deserialized = deserializeChunkToEntities(originalChunk);
      const reserializedMap = serializeEntitiesToChunks(deserialized);
      const reserializedChunk = reserializedMap.get('5_6')!;

      expect(reserializedChunk).toBeDefined();
      expect(reserializedChunk.chunk_id).toBe('5_6');
      expect(reserializedChunk.buildings).toEqual(originalChunk.buildings);
      expect(reserializedChunk.lanterns).toEqual(originalChunk.lanterns);
      expect(reserializedChunk.signs).toEqual(originalChunk.signs);
      expect(reserializedChunk.npcs).toEqual(originalChunk.npcs);
      expect(reserializedChunk.items).toEqual(originalChunk.items);
      expect(validateChunkData(reserializedChunk)).toBe(true);
    });

    it('should support entities with rootObject Three.js structure', () => {
      const mockThreeEntity = {
        type: 'prop',
        assetId: 'arch',
        rootObject: {
          position: { x: 42.5, y: 0, z: 64.5 },
        },
      };

      const map = serializeEntitiesToChunks([mockThreeEntity]);
      expect(map.has('2_3')).toBe(true);
      const chunk = map.get('2_3')!;
      expect(chunk.buildings.length).toBe(1);
      expect(chunk.buildings[0]!.type).toBe('arch');
      expect(chunk.buildings[0]!.x).toBe(2.5);
      expect(chunk.buildings[0]!.z).toBe(4.5);
    });
  });

  // ==========================================================================
  // 5. Chunk Storage Implementations
  // ==========================================================================
  describe('5. Chunk Storage Backends (Mock, LocalStorage, Http & Composite)', () => {
    describe('MockChunkStorage', () => {
      let storage: MockChunkStorage;

      beforeEach(() => {
        storage = new MockChunkStorage();
      });

      it('should save, load, and list chunks correctly in memory', async () => {
        expect(await storage.listChunks()).toEqual([]);
        expect(await storage.loadChunk('0_0')).toBeNull();

        const chunk00 = createEmptyChunk('0_0');
        chunk00.buildings.push({ type: 'stall', x: 2, z: 3 });

        const saveRes = await storage.saveChunk('0_0', chunk00);
        expect(saveRes).toBe(true);

        const loaded = await storage.loadChunk('0_0');
        expect(loaded).toEqual(chunk00);
        expect(await storage.listChunks()).toEqual(['0_0']);
      });

      it('should track dirty chunks and batch save them', async () => {
        storage.markDirty('0_0');
        storage.markDirty('1_1');
        expect(storage.getDirtyCount()).toBe(2);
        expect(storage.isDirty('0_0')).toBe(true);
        expect(storage.isDirty('1_1')).toBe(true);

        const dirtyMap = new Map<string, RawChunkData>();
        dirtyMap.set('0_0', createEmptyChunk('0_0'));
        dirtyMap.set('1_1', createEmptyChunk('1_1'));

        const savedCount = await storage.saveAllDirtyChunks(dirtyMap);
        expect(savedCount).toBe(2);
        expect(storage.getDirtyCount()).toBe(0);
        expect(storage.isDirty('0_0')).toBe(false);
      });

      it('should clear all chunks and dirty tracking on clear()', async () => {
        await storage.saveChunk('0_0', createEmptyChunk('0_0'));
        storage.markDirty('0_0');
        storage.clear();

        expect(storage.getChunkCount()).toBe(0);
        expect(storage.getDirtyCount()).toBe(0);
        expect(await storage.listChunks()).toEqual([]);
      });
    });

    describe('LocalStorageChunkStorage', () => {
      let storage: LocalStorageChunkStorage;

      beforeEach(() => {
        storage = new LocalStorageChunkStorage();
        storage.clear();
      });

      it('should operate safely with in-memory fallback in headless node test environment', async () => {
        const chunk = createEmptyChunk('2_2');
        chunk.buildings.push({ type: 'lantern', x: 1, z: 1 });

        await storage.saveChunk('2_2', chunk);
        const loaded = await storage.loadChunk('2_2');
        expect(loaded).toEqual(chunk);

        const list = await storage.listChunks();
        expect(list).toContain('2_2');

        storage.clear();
        expect(await storage.loadChunk('2_2')).toBeNull();
      });
    });

    describe('HttpChunkStorage', () => {
      it('should make REST calls to /api/editor/chunks endpoints', async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: any) => {
          if (url.endsWith('/api/editor/chunks') && (!opts || opts.method === 'GET')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(['0_0', '1_1']),
            });
          }
          if (url.endsWith('/api/editor/chunks/0_0') && (!opts || opts.method === 'GET')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(createEmptyChunk('0_0')),
            });
          }
          if (opts && opts.method === 'POST') {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, chunkId: '0_0', bytesWritten: 120 }),
            });
          }
          return Promise.resolve({ ok: false, status: 404 });
        });

        const origFetch = global.fetch;
        global.fetch = mockFetch;

        try {
          const httpStorage = new HttpChunkStorage('http://localhost:5173');

          const list = await httpStorage.listChunks();
          expect(list).toEqual(['0_0', '1_1']);
          expect(mockFetch).toHaveBeenCalledWith('http://localhost:5173/api/editor/chunks');

          const chunk = await httpStorage.loadChunk('0_0');
          expect(chunk?.chunk_id).toBe('0_0');

          const saved = await httpStorage.saveChunk('0_0', createEmptyChunk('0_0'));
          expect(saved).toBe(true);
        } finally {
          global.fetch = origFetch;
        }
      });
    });

    describe('CompositeChunkStorage', () => {
      it('should save to both HTTP and LocalStorage for dual durability', async () => {
        const mockHttp = new MockChunkStorage();
        const mockLocal = new MockChunkStorage();
        const composite = new CompositeChunkStorage(mockHttp, mockLocal);

        const chunk = createEmptyChunk('4_4');
        const saveRes = await composite.saveChunk('4_4', chunk);
        expect(saveRes).toBe(true);

        // Verify saved to both
        expect(await mockLocal.loadChunk('4_4')).toBeDefined();
        expect(await mockHttp.loadChunk('4_4')).toBeDefined();

        // Load checks local first
        const loaded = await composite.loadChunk('4_4');
        expect(loaded?.chunk_id).toBe('4_4');
      });

      it('should fallback to HTTP storage if chunk is not present in local storage', async () => {
        const mockHttp = new MockChunkStorage();
        const mockLocal = new MockChunkStorage();
        const composite = new CompositeChunkStorage(mockHttp, mockLocal);

        // Seed only in HTTP
        const chunk = createEmptyChunk('7_7');
        await mockHttp.saveChunk('7_7', chunk);

        const loaded = await composite.loadChunk('7_7');
        expect(loaded?.chunk_id).toBe('7_7');

        // Verify it was cached to local storage for offline use
        expect(await mockLocal.loadChunk('7_7')).toBeDefined();
      });

      it('should prefer the shared HTTP copy over a stale local copy', async () => {
        const mockHttp = new MockChunkStorage();
        const mockLocal = new MockChunkStorage();
        const composite = new CompositeChunkStorage(mockHttp, mockLocal);

        const stale = createEmptyChunk('3_3');
        await mockLocal.saveChunk('3_3', stale);
        const shared = createEmptyChunk('3_3');
        shared.buildings.push({ type: 'prop_crate', x: 2, z: 2 });
        await mockHttp.saveChunk('3_3', shared);

        const loaded = await composite.loadChunk('3_3');
        expect(loaded?.buildings).toHaveLength(1);
        // The fresh copy replaces the stale cache for offline use
        expect((await mockLocal.loadChunk('3_3'))?.buildings).toHaveLength(1);
      });

      it('should fall back to the local copy and report no shared chunks when HTTP is down', async () => {
        const failingHttp = new MockChunkStorage();
        failingHttp.loadChunk = async () => {
          throw new Error('offline');
        };
        failingHttp.saveChunk = async () => {
          throw new Error('offline');
        };
        const mockLocal = new MockChunkStorage();
        const composite = new CompositeChunkStorage(failingHttp, mockLocal);

        await mockLocal.saveChunk('1_1', createEmptyChunk('1_1'));
        expect((await composite.loadChunk('1_1'))?.chunk_id).toBe('1_1');

        const saved = await composite.saveAllDirtyChunks(new Map([['1_1', createEmptyChunk('1_1')]]));
        expect(saved).toBe(1);
        expect(composite.lastSharedChunkIds).toEqual([]);
      });

      it('should list chunks that reached the shared HTTP storage', async () => {
        const composite = new CompositeChunkStorage(new MockChunkStorage(), new MockChunkStorage());
        await composite.saveAllDirtyChunks(new Map([['4_4', createEmptyChunk('4_4')], ['4_5', createEmptyChunk('4_5')]]));
        expect(composite.lastSharedChunkIds).toEqual(['4_4', '4_5']);
      });
    });
  });

  // ==========================================================================
  // 6. Vite Dev Server Plugin Middleware Unit Verification
  // ==========================================================================
  describe('6. Vite Dev Server Plugin (levelEditorPlugin)', () => {
    it('should instantiate Vite plugin with configureServer hook', () => {
      const plugin = levelEditorPlugin();
      expect(plugin.name).toBe('level-editor-plugin');
      expect(typeof plugin.configureServer).toBe('function');
    });

    it('should route /api/editor/chunks GET requests properly', async () => {
      const plugin = levelEditorPlugin();
      let middlewareFn: any = null;

      const mockServer: any = {
        middlewares: {
          use: (fn: any) => {
            middlewareFn = fn;
          },
        },
      };

      (plugin.configureServer as any)(mockServer);
      expect(typeof middlewareFn).toBe('function');

      // Test GET /api/editor/chunks
      const req: any = {
        url: '/api/editor/chunks',
        method: 'GET',
      };
      let responseBody = '';
      const res: any = {
        setHeader: vi.fn(),
        statusCode: 200,
        end: (data: string) => {
          responseBody = data;
        },
      };
      const next = vi.fn();

      await middlewareFn(req, res, next);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      const chunkIds = JSON.parse(responseBody);
      expect(Array.isArray(chunkIds)).toBe(true);
      expect(chunkIds).toContain('0_0');
      expect(chunkIds).toContain('5_6');
      expect(chunkIds.length).toBe(100); // 100 chunks in server/world/chunks
    });

    it('should read existing chunk JSON via GET /api/editor/chunks/:id', async () => {
      const plugin = levelEditorPlugin();
      let middlewareFn: any = null;
      const mockServer: any = {
        middlewares: {
          use: (fn: any) => {
            middlewareFn = fn;
          },
        },
      };
      (plugin.configureServer as any)(mockServer);

      const req: any = {
        url: '/api/editor/chunks/0_0',
        method: 'GET',
      };
      let responseBody = '';
      const res: any = {
        setHeader: vi.fn(),
        statusCode: 200,
        end: (data: string) => {
          responseBody = data;
        },
      };

      await middlewareFn(req, res, () => {});
      const chunk = JSON.parse(responseBody);
      expect(chunk.chunk_id).toBe('0_0');
      expect(Array.isArray(chunk.buildings)).toBe(true);
      expect(validateChunkData(chunk)).toBe(true);
    });

    it('should reject invalid chunk IDs with 400 Bad Request', async () => {
      const plugin = levelEditorPlugin();
      let middlewareFn: any = null;
      const mockServer: any = {
        middlewares: {
          use: (fn: any) => {
            middlewareFn = fn;
          },
        },
      };
      (plugin.configureServer as any)(mockServer);

      const req: any = {
        url: '/api/editor/chunks/../../etc/passwd',
        method: 'GET',
      };
      const res: any = {
        setHeader: vi.fn(),
        statusCode: 200,
        end: vi.fn(),
      };

      await middlewareFn(req, res, () => {});
      expect(res.statusCode).toBe(400);
    });

    it('should save chunk JSON via POST /api/editor/chunks/:id ensuring Go-compatible non-null arrays', async () => {
      const plugin = levelEditorPlugin();
      let middlewareFn: any = null;
      const mockServer: any = {
        middlewares: {
          use: (fn: any) => {
            middlewareFn = fn;
          },
        },
      };
      (plugin.configureServer as any)(mockServer);

      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const testChunkPath = path.resolve(__dirname, '../../server/world/chunks/99_99.json');

      try {
        const chunkToSave: RawChunkData = {
          chunk_id: '99_99',
          buildings: [{ type: 'stall', x: 3, z: 4 }, { type: 'stall', x: 15, z: 16 }],
          lanterns: [{ x: 4, y: 3, z: 5 }, { x: 14, y: 3, z: 15 }],
          signs: [{ text: '夜市', x: 3, y: 3, z: 4 }],
          npcs: [],
          items: [],
        };

        const listeners: Record<string, ((...args: any[]) => void)[]> = {};
        const req: any = {
          url: '/api/editor/chunks/99_99',
          method: 'POST',
          on: (event: string, cb: (...args: any[]) => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
          },
        };

        let responseBody = '';
        const res: any = {
          setHeader: vi.fn(),
          statusCode: 200,
          end: (data: string) => {
            responseBody = data;
          },
        };

        await middlewareFn(req, res, () => {});

        // Simulate streaming request data and end
        listeners['data']?.forEach((cb) => cb(JSON.stringify(chunkToSave)));
        await Promise.resolve();
        listeners['end']?.forEach((cb) => cb());

        // Yield event loop for async fs.writeFile completion
        await new Promise((resolve) => setTimeout(resolve, 50));

        const parsedRes = JSON.parse(responseBody);
        expect(parsedRes.success).toBe(true);
        expect(parsedRes.chunkId).toBe('99_99');
        expect(parsedRes.bytesWritten).toBeGreaterThan(0);

        // Verify file actually written to disk
        const savedRaw = await fs.readFile(testChunkPath, 'utf-8');
        const savedObj = JSON.parse(savedRaw);
        expect(savedObj.chunk_id).toBe('99_99');
        expect(validateChunkData(savedObj)).toBe(true);
      } finally {
        await fs.unlink(testChunkPath).catch(() => {});
      }
    });
  });
});
