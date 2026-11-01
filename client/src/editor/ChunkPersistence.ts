/**
 * ChunkPersistence.ts
 *
 * Implements Milestone M4: Chunk Configuration Persistence, Go-Compatible
 * Serialization, Coordinate Transformations, and Cross-Chunk Entity Migration.
 * Strictly adheres to Go schema in server/internal/game/world.go and server/world/chunks/*.json.
 */

export interface BuildingData {
  type: string;
  x: number;
  z: number;
}

export interface LanternData {
  x: number;
  y: number;
  z: number;
}

export interface SignData {
  text: string;
  x: number;
  y: number;
  z: number;
}

export interface NPCData {
  npc_id: string;
  x: number;
  y: number;
  z: number;
}

export interface ItemData {
  item_id: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Strict Go-compatible RawChunkData interface matching server/internal/game/world.go:
 * type Chunk struct {
 *   ID        string     `json:"chunk_id"`
 *   Buildings []Building `json:"buildings"`
 *   Lanterns  []Vec3     `json:"lanterns"`
 *   Signs     []Sign     `json:"signs"`
 *   NPCs      []NPCRef   `json:"npcs"`
 *   Items     []ItemRef  `json:"items"`
 * }
 *
 * ALL array fields MUST be non-null arrays `[]` (mandatory Go validator check).
 */
export interface RawChunkData {
  chunk_id: string;
  buildings: Array<{ type: string; x: number; z: number }>;
  lanterns: Array<{ x: number; y: number; z: number }>;
  signs: Array<{ text: string; x: number; y: number; z: number }>;
  npcs: Array<{ npc_id: string; x: number; y: number; z: number }>;
  items: Array<{ item_id: string; x: number; y: number; z: number }>;
}

export const CHUNK_SIZE = 20;
export const WORLD_GRID_SIZE = 10;
export const WORLD_MAX = CHUNK_SIZE * WORLD_GRID_SIZE; // 200

/**
 * Validates that local coordinate satisfies Go server constraint:
 * 0 <= x < 20 and 0 <= z < 20 and Finite.
 */
export function isValidLocalCoord(x: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(z) && x >= 0 && z >= 0 && x < CHUNK_SIZE && z < CHUNK_SIZE;
}

/**
 * Creates an empty chunk with all arrays initialized to empty arrays `[]`
 * satisfying the Go validator non-null slice check.
 */
export function createEmptyChunk(chunkId: string): RawChunkData {
  return {
    chunk_id: chunkId,
    buildings: [],
    lanterns: [],
    signs: [],
    npcs: [],
    items: [],
  };
}

/**
 * Sanitizes partial chunk data ensuring strict non-null arrays.
 */
export function sanitizeChunkData(data: Partial<RawChunkData> & { chunk_id: string }): RawChunkData {
  return {
    chunk_id: data.chunk_id,
    buildings: Array.isArray(data.buildings) ? data.buildings : [],
    lanterns: Array.isArray(data.lanterns) ? data.lanterns : [],
    signs: Array.isArray(data.signs) ? data.signs : [],
    npcs: Array.isArray(data.npcs) ? data.npcs : [],
    items: Array.isArray(data.items) ? data.items : [],
  };
}

/**
 * Validates whether chunk data complies with Go server requirements.
 */
export function validateChunkData(chunk: unknown): chunk is RawChunkData {
  if (!chunk || typeof chunk !== 'object') return false;
  const c = chunk as Record<string, any>;
  if (typeof c.chunk_id !== 'string' || !/^\d+_\d+$/.test(c.chunk_id)) {
    return false;
  }
  if (
    !Array.isArray(c.buildings) ||
    !Array.isArray(c.lanterns) ||
    !Array.isArray(c.signs) ||
    !Array.isArray(c.npcs) ||
    !Array.isArray(c.items)
  ) {
    return false;
  }

  for (const b of c.buildings) {
    if (
      !b ||
      typeof b.type !== 'string' ||
      b.type.trim() === '' ||
      typeof b.x !== 'number' ||
      typeof b.z !== 'number' ||
      !isValidLocalCoord(b.x, b.z)
    ) {
      return false;
    }
  }
  for (const l of c.lanterns) {
    if (
      !l ||
      typeof l.x !== 'number' ||
      typeof l.y !== 'number' ||
      typeof l.z !== 'number' ||
      !isValidLocalCoord(l.x, l.z) ||
      !Number.isFinite(l.y)
    ) {
      return false;
    }
  }
  for (const s of c.signs) {
    if (
      !s ||
      typeof s.text !== 'string' ||
      s.text === '' ||
      typeof s.x !== 'number' ||
      typeof s.y !== 'number' ||
      typeof s.z !== 'number' ||
      !isValidLocalCoord(s.x, s.z) ||
      !Number.isFinite(s.y)
    ) {
      return false;
    }
  }
  for (const n of c.npcs) {
    if (
      !n ||
      typeof n.npc_id !== 'string' ||
      n.npc_id.trim() === '' ||
      typeof n.x !== 'number' ||
      typeof n.y !== 'number' ||
      typeof n.z !== 'number' ||
      !isValidLocalCoord(n.x, n.z) ||
      !Number.isFinite(n.y)
    ) {
      return false;
    }
  }
  for (const it of c.items) {
    if (
      !it ||
      typeof it.item_id !== 'string' ||
      it.item_id.trim() === '' ||
      typeof it.x !== 'number' ||
      typeof it.y !== 'number' ||
      typeof it.z !== 'number' ||
      !isValidLocalCoord(it.x, it.z) ||
      !Number.isFinite(it.y)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Coordinate transformation engine:
 * Maps world coordinates (0..200) to grid coordinates cx, cz in [0..9]
 * and chunk identifier string `${cx}_${cz}`.
 */
export function getChunkCoords(
  worldX: number,
  worldZ: number
): { cx: number; cz: number; chunkId: string } {
  let cx = Math.floor(worldX / CHUNK_SIZE);
  let cz = Math.floor(worldZ / CHUNK_SIZE);

  if (cx < 0) cx = 0;
  if (cx >= WORLD_GRID_SIZE) cx = WORLD_GRID_SIZE - 1;
  if (cz < 0) cz = 0;
  if (cz >= WORLD_GRID_SIZE) cz = WORLD_GRID_SIZE - 1;

  return {
    cx,
    cz,
    chunkId: `${cx}_${cz}`,
  };
}

/**
 * Transforms world coordinates to chunk local coordinates [0..20)
 * lx = worldX - cx * 20
 */
export function worldToLocal(
  worldX: number,
  worldZ: number
): { lx: number; lz: number } {
  const { cx, cz } = getChunkCoords(worldX, worldZ);
  let lx = worldX - cx * CHUNK_SIZE;
  let lz = worldZ - cz * CHUNK_SIZE;

  // Clamp to [0, 20) with floating precision guard
  if (lx < 0) lx = 0;
  if (lx >= CHUNK_SIZE) lx = CHUNK_SIZE - 0.001;
  if (lz < 0) lz = 0;
  if (lz >= CHUNK_SIZE) lz = CHUNK_SIZE - 0.001;

  lx = Math.round(lx * 10000) / 10000;
  lz = Math.round(lz * 10000) / 10000;

  if (lx >= CHUNK_SIZE) lx = CHUNK_SIZE - 0.001;
  if (lz >= CHUNK_SIZE) lz = CHUNK_SIZE - 0.001;

  return { lx, lz };
}

/**
 * Transforms chunk local coordinates to world coordinates
 * wx = cx * 20 + lx
 */
export function localToWorld(
  cx: number,
  cz: number,
  lx: number,
  lz: number
): { wx: number; wz: number } {
  const wx = Math.round((cx * CHUNK_SIZE + lx) * 10000) / 10000;
  const wz = Math.round((cz * CHUNK_SIZE + lz) * 10000) / 10000;
  return { wx, wz };
}

export interface DeserializedEntity {
  id: string;
  type: 'building' | 'lantern' | 'sign' | 'npc' | 'item';
  assetId: string;
  chunkId: string;
  subType?: string;
  text?: string;
  npc_id?: string;
  npcId?: string;
  item_id?: string;
  itemId?: string;
  x: number;
  y: number;
  z: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  localX: number;
  localY: number;
  localZ: number;
  position: { x: number; y: number; z: number };
}

/**
 * Deserializes raw Go-compatible chunk JSON into editor entity objects.
 */
export function deserializeChunkToEntities(chunkData: RawChunkData): DeserializedEntity[] {
  const sanitized = sanitizeChunkData(chunkData);
  const entities: DeserializedEntity[] = [];

  const parts = sanitized.chunk_id.split('_').map(Number);
  const cx = Number.isFinite(parts[0]) ? parts[0]! : 0;
  const cz = Number.isFinite(parts[1]) ? parts[1]! : 0;

  sanitized.buildings.forEach((b, idx) => {
    const { wx, wz } = localToWorld(cx, cz, b.x, b.z);
    entities.push({
      id: `building_${sanitized.chunk_id}_${idx}`,
      type: 'building',
      assetId: b.type,
      subType: b.type,
      chunkId: sanitized.chunk_id,
      x: wx,
      y: 0,
      z: wz,
      worldX: wx,
      worldY: 0,
      worldZ: wz,
      localX: b.x,
      localY: 0,
      localZ: b.z,
      position: { x: wx, y: 0, z: wz },
    });
  });

  sanitized.lanterns.forEach((l, idx) => {
    const { wx, wz } = localToWorld(cx, cz, l.x, l.z);
    entities.push({
      id: `lantern_${sanitized.chunk_id}_${idx}`,
      type: 'lantern',
      assetId: 'lantern',
      chunkId: sanitized.chunk_id,
      x: wx,
      y: l.y,
      z: wz,
      worldX: wx,
      worldY: l.y,
      worldZ: wz,
      localX: l.x,
      localY: l.y,
      localZ: l.z,
      position: { x: wx, y: l.y, z: wz },
    });
  });

  sanitized.signs.forEach((s, idx) => {
    const { wx, wz } = localToWorld(cx, cz, s.x, s.z);
    entities.push({
      id: `sign_${sanitized.chunk_id}_${idx}`,
      type: 'sign',
      assetId: 'sign',
      text: s.text,
      chunkId: sanitized.chunk_id,
      x: wx,
      y: s.y,
      z: wz,
      worldX: wx,
      worldY: s.y,
      worldZ: wz,
      localX: s.x,
      localY: s.y,
      localZ: s.z,
      position: { x: wx, y: s.y, z: wz },
    });
  });

  sanitized.npcs.forEach((n) => {
    const { wx, wz } = localToWorld(cx, cz, n.x, n.z);
    entities.push({
      id: n.npc_id,
      type: 'npc',
      npc_id: n.npc_id,
      npcId: n.npc_id,
      assetId: n.npc_id,
      chunkId: sanitized.chunk_id,
      x: wx,
      y: n.y,
      z: wz,
      worldX: wx,
      worldY: n.y,
      worldZ: wz,
      localX: n.x,
      localY: n.y,
      localZ: n.z,
      position: { x: wx, y: n.y, z: wz },
    });
  });

  sanitized.items.forEach((it) => {
    const { wx, wz } = localToWorld(cx, cz, it.x, it.z);
    entities.push({
      id: it.item_id,
      type: 'item',
      item_id: it.item_id,
      itemId: it.item_id,
      assetId: it.item_id,
      chunkId: sanitized.chunk_id,
      x: wx,
      y: it.y,
      z: wz,
      worldX: wx,
      worldY: it.y,
      worldZ: wz,
      localX: it.x,
      localY: it.y,
      localZ: it.z,
      position: { x: wx, y: it.y, z: wz },
    });
  });

  return entities;
}

/**
 * Serializes entity list into Go-compatible RawChunkData indexed by chunkId.
 */
export function serializeEntitiesToChunks(entities: any[]): Map<string, RawChunkData> {
  const map = new Map<string, RawChunkData>();

  for (const entity of entities) {
    if (!entity) continue;

    let wx = 0;
    let wy = 0;
    let wz = 0;

    if (entity.rootObject && entity.rootObject.position) {
      wx = entity.rootObject.position.x ?? 0;
      wy = entity.rootObject.position.y ?? 0;
      wz = entity.rootObject.position.z ?? 0;
    } else if (entity.position) {
      wx = entity.position.x ?? 0;
      wy = entity.position.y ?? 0;
      wz = entity.position.z ?? 0;
    } else {
      wx = entity.worldX ?? entity.x ?? 0;
      wy = entity.worldY ?? entity.y ?? 0;
      wz = entity.worldZ ?? entity.z ?? 0;
    }

    const { chunkId } = getChunkCoords(wx, wz);
    let chunk = map.get(chunkId);
    if (!chunk) {
      chunk = createEmptyChunk(chunkId);
      map.set(chunkId, chunk);
    }

    const { lx, lz } = worldToLocal(wx, wz);
    const type = String(entity.type || entity.category || 'building').toLowerCase();

    if (type === 'npc' || type === 'npcs') {
      const npcId = entity.npc_id || entity.npcId || entity.assetId || entity.id || 'npc_vendor';
      chunk.npcs.push({ npc_id: String(npcId), x: lx, y: wy, z: lz });
    } else if (type === 'item' || type === 'items') {
      const itemId = entity.item_id || entity.itemId || entity.assetId || entity.id || 'item_generic';
      chunk.items.push({ item_id: String(itemId), x: lx, y: wy, z: lz });
    } else if (type === 'lantern') {
      chunk.lanterns.push({ x: lx, y: wy, z: lz });
    } else if (type === 'sign') {
      const text = entity.text || entity.signText || '夜市';
      chunk.signs.push({ text: String(text), x: lx, y: wy, z: lz });
    } else {
      const bType =
        entity.buildingType ||
        entity.subType ||
        entity.assetId ||
        (entity.type !== 'building' ? entity.type : 'stall') ||
        'stall';
      chunk.buildings.push({ type: String(bType), x: lx, z: lz });
    }
  }

  map.forEach((chunk, id) => {
    map.set(id, sanitizeChunkData(chunk));
  });

  return map;
}

export interface MigrationResult {
  migrated: boolean;
  oldChunkId: string;
  newChunkId: string;
  entity: any;
  oldLocalCoords: { lx: number; lz: number };
  newLocalCoords: { lx: number; lz: number };
}

/**
 * Cross-chunk entity migration:
 * When an object moves from (oldWorldX, oldWorldZ) to (newWorldX, newWorldZ),
 * if it crosses chunk boundaries, automatically remove it from oldChunk and index
 * it into newChunk with updated local coordinates.
 */
export function migrateEntity(
  chunks: Map<string, RawChunkData>,
  entity: any,
  oldWorldX: number,
  oldWorldZ: number,
  newWorldX: number,
  newWorldZ: number,
  newWorldY: number = 0
): MigrationResult {
  const { chunkId: oldChunkId } = getChunkCoords(oldWorldX, oldWorldZ);
  const { chunkId: newChunkId } = getChunkCoords(newWorldX, newWorldZ);
  const oldLocal = worldToLocal(oldWorldX, oldWorldZ);
  const newLocal = worldToLocal(newWorldX, newWorldZ);

  const type = String(entity.type || entity.category || 'building').toLowerCase();
  const entityId = entity.id || entity.npc_id || entity.item_id || entity.assetId;

  const removeFromChunk = (chunk: RawChunkData) => {
    if (type === 'npc' || type === 'npcs') {
      const idx = chunk.npcs.findIndex(
        (n) =>
          (entityId && n.npc_id === entityId) ||
          (Math.abs(n.x - oldLocal.lx) < 0.05 && Math.abs(n.z - oldLocal.lz) < 0.05)
      );
      if (idx !== -1) chunk.npcs.splice(idx, 1);
    } else if (type === 'item' || type === 'items') {
      const idx = chunk.items.findIndex(
        (it) =>
          (entityId && it.item_id === entityId) ||
          (Math.abs(it.x - oldLocal.lx) < 0.05 && Math.abs(it.z - oldLocal.lz) < 0.05)
      );
      if (idx !== -1) chunk.items.splice(idx, 1);
    } else if (type === 'lantern') {
      const idx = chunk.lanterns.findIndex(
        (l) => Math.abs(l.x - oldLocal.lx) < 0.05 && Math.abs(l.z - oldLocal.lz) < 0.05
      );
      if (idx !== -1) chunk.lanterns.splice(idx, 1);
    } else if (type === 'sign') {
      const idx = chunk.signs.findIndex(
        (s) =>
          (entity.text && s.text === entity.text) ||
          (Math.abs(s.x - oldLocal.lx) < 0.05 && Math.abs(s.z - oldLocal.lz) < 0.05)
      );
      if (idx !== -1) chunk.signs.splice(idx, 1);
    } else {
      const bType =
        entity.buildingType || entity.subType || entity.assetId || entity.type || 'stall';
      const idx = chunk.buildings.findIndex(
        (b) =>
          (b.type === bType &&
            Math.abs(b.x - oldLocal.lx) < 0.05 &&
            Math.abs(b.z - oldLocal.lz) < 0.05) ||
          (Math.abs(b.x - oldLocal.lx) < 0.05 && Math.abs(b.z - oldLocal.lz) < 0.05)
      );
      if (idx !== -1) chunk.buildings.splice(idx, 1);
    }
  };

  const addToChunk = (chunk: RawChunkData) => {
    if (type === 'npc' || type === 'npcs') {
      const npcId = entity.npc_id || entity.npcId || entity.assetId || entity.id || 'npc_vendor';
      chunk.npcs.push({ npc_id: npcId, x: newLocal.lx, y: newWorldY, z: newLocal.lz });
    } else if (type === 'item' || type === 'items') {
      const itemId = entity.item_id || entity.itemId || entity.assetId || entity.id || 'item_generic';
      chunk.items.push({ item_id: itemId, x: newLocal.lx, y: newWorldY, z: newLocal.lz });
    } else if (type === 'lantern') {
      chunk.lanterns.push({ x: newLocal.lx, y: newWorldY, z: newLocal.lz });
    } else if (type === 'sign') {
      chunk.signs.push({ text: entity.text || '夜市', x: newLocal.lx, y: newWorldY, z: newLocal.lz });
    } else {
      const bType =
        entity.buildingType || entity.subType || entity.assetId || entity.type || 'stall';
      chunk.buildings.push({ type: bType, x: newLocal.lx, z: newLocal.lz });
    }
  };

  const isCrossChunk = oldChunkId !== newChunkId;

  if (isCrossChunk) {
    const oldChunk = chunks.get(oldChunkId);
    if (oldChunk) {
      removeFromChunk(oldChunk);
    }

    let newChunk = chunks.get(newChunkId);
    if (!newChunk) {
      newChunk = createEmptyChunk(newChunkId);
      chunks.set(newChunkId, newChunk);
    }
    addToChunk(newChunk);
  } else {
    let chunk = chunks.get(oldChunkId);
    if (!chunk) {
      chunk = createEmptyChunk(oldChunkId);
      chunks.set(oldChunkId, chunk);
    }
    removeFromChunk(chunk);
    addToChunk(chunk);
  }

  // Mutate entity tracking properties if present
  if (typeof entity === 'object' && entity !== null) {
    if (entity.chunkId !== undefined) entity.chunkId = newChunkId;
    if (entity.worldX !== undefined) entity.worldX = newWorldX;
    if (entity.worldZ !== undefined) entity.worldZ = newWorldZ;
    if (entity.localX !== undefined) entity.localX = newLocal.lx;
    if (entity.localZ !== undefined) entity.localZ = newLocal.lz;
    if (entity.position) {
      if (typeof entity.position.set === 'function') {
        entity.position.set(newWorldX, newWorldY, newWorldZ);
      } else {
        entity.position.x = newWorldX;
        entity.position.y = newWorldY;
        entity.position.z = newWorldZ;
      }
    }
  }

  return {
    migrated: isCrossChunk,
    oldChunkId,
    newChunkId,
    entity,
    oldLocalCoords: oldLocal,
    newLocalCoords: newLocal,
  };
}

/**
 * ChunkPersistence orchestrator class grouping serialization, coordinate
 * transformation, validation, and migration utilities.
 */
export class ChunkPersistence {
  public static readonly CHUNK_SIZE = CHUNK_SIZE;
  public static readonly WORLD_GRID_SIZE = WORLD_GRID_SIZE;
  public static readonly WORLD_MAX = WORLD_MAX;

  public static getChunkCoords = getChunkCoords;
  public static worldToLocal = worldToLocal;
  public static localToWorld = localToWorld;
  public static createEmptyChunk = createEmptyChunk;
  public static validateChunkData = validateChunkData;
  public static sanitizeChunkData = sanitizeChunkData;
  public static serializeEntitiesToChunks = serializeEntitiesToChunks;
  public static deserializeChunkToEntities = deserializeChunkToEntities;
  public static migrateEntity = migrateEntity;
}
