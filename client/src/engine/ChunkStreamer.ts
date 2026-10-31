/**
 * Rest-In-Hackaton: ChunkStreamer Engine Component
 * Manages Area of Interest (AoI) calculation, 10x10 world grid streaming,
 * set differential loading/unloading, and strict <= 10% memory limit enforcement.
 */

import * as THREE from 'three';
import { ChunkBuilder, disposeHierarchy } from './ChunkBuilder';

/**
 * Configuration options for ChunkStreamer.
 */
export interface ChunkStreamerConfig {
  chunkSize: number;       // Size of each chunk in world units (default: 20)
  gridWidth: number;       // Number of chunk columns along X (default: 10)
  gridHeight: number;      // Number of chunk rows along Z (default: 10)
  maxAoIChunks: number;    // Theoretical maximum chunks in AoI (default: 9)
  totalChunks: number;     // Total chunks in world grid (default: 100)
}

/**
 * Default configuration conforming to Rest-In-Hackaton 200x200 world specification.
 */
export const DEFAULT_CHUNK_CONFIG: ChunkStreamerConfig = {
  chunkSize: 20,
  gridWidth: 10,
  gridHeight: 10,
  maxAoIChunks: 9,
  totalChunks: 100,
};

/**
 * Representation of an active chunk loaded into memory and scene graph.
 */
export interface LoadedChunk {
  id: string;              // Chunk identifier formatted as `${cx}_${cz}` (e.g. "5_5")
  cx: number;              // Discrete grid column index in [0..gridWidth - 1]
  cz: number;              // Discrete grid row index in [0..gridHeight - 1]
  worldX: number;          // Min world X coordinate (cx * chunkSize)
  worldZ: number;          // Min world Z coordinate (cz * chunkSize)
  group: THREE.Object3D;   // Mesh or Group root attached to Three.js scene
}

/**
 * Chunk procedural factory callback signature.
 */
export type ChunkFactory = (cx: number, cz: number, config: ChunkStreamerConfig) => THREE.Object3D;

/**
 * Chunk GPU memory disposal callback signature.
 */
export type ChunkDisposer = (object: THREE.Object3D) => void;

/**
 * Default chunk disposer delegates to deep GPU hierarchy disposal.
 */
export const defaultChunkDisposer: ChunkDisposer = (object: THREE.Object3D): void => {
  disposeHierarchy(object);
};

/**
 * Default chunk factory builds procedural chunk using ChunkBuilder.
 */
export const defaultChunkFactory: ChunkFactory = (
  cx: number,
  cz: number,
  _config: ChunkStreamerConfig
): THREE.Object3D => {
  return ChunkBuilder.buildChunk(cx, cz);
};

/**
 * Public interface contract as specified in PROJECT.md.
 */
export interface IChunkStreamer {
  update(playerX: number, playerZ: number): void;
  getLoadedChunksCount(): number;
  getCachePercentage(): number;
  dispose(): void;
}

/**
 * ChunkStreamer: Responsible for dynamic chunk streaming around player position.
 */
export class ChunkStreamer implements IChunkStreamer {
  private readonly scene: THREE.Scene;
  private readonly config: ChunkStreamerConfig;
  private readonly chunkFactory: ChunkFactory;
  private readonly chunkDisposer: ChunkDisposer;

  private readonly loadedChunks: Map<string, LoadedChunk> = new Map();
  private lastChunkX: number | null = null;
  private lastChunkZ: number | null = null;

  constructor(
    scene: THREE.Scene,
    config?: Partial<ChunkStreamerConfig>,
    chunkFactory?: ChunkFactory,
    chunkDisposer?: ChunkDisposer
  ) {
    this.scene = scene;
    this.config = { ...DEFAULT_CHUNK_CONFIG, ...config };
    this.chunkFactory = chunkFactory ?? defaultChunkFactory;
    this.chunkDisposer = chunkDisposer ?? defaultChunkDisposer;
  }

  /**
   * Generates a chunk ID string from grid coordinates.
   */
  public static getChunkId(cx: number, cz: number): string {
    return `${cx}_${cz}`;
  }

  /**
   * Parses a chunk ID string into discrete grid coordinates.
   */
  public static parseChunkId(id: string): { cx: number; cz: number } {
    const parts = id.split('_');
    const cx = Number.parseInt(parts[0] ?? '0', 10);
    const cz = Number.parseInt(parts[1] ?? '0', 10);
    return { cx, cz };
  }

  /**
   * Converts continuous world coordinates (x, z) to clamped discrete chunk grid coordinates.
   * Clamped to [0, gridWidth - 1] and [0, gridHeight - 1].
   */
  public static worldToChunkCoords(
    x: number,
    z: number,
    chunkSize = DEFAULT_CHUNK_CONFIG.chunkSize,
    gridWidth = DEFAULT_CHUNK_CONFIG.gridWidth,
    gridHeight = DEFAULT_CHUNK_CONFIG.gridHeight
  ): { cx: number; cz: number } {
    const rawCx = Math.floor(x / chunkSize);
    const rawCz = Math.floor(z / chunkSize);
    const cx = Math.max(0, Math.min(gridWidth - 1, rawCx));
    const cz = Math.max(0, Math.min(gridHeight - 1, rawCz));
    return { cx, cz };
  }

  /**
   * Calculates the Area of Interest (AoI) chunk ID set for a given center chunk coordinate.
   * Spans [cx - 1, cx + 1] x [cz - 1, cz + 1] clamped strictly to [0..gridWidth-1, 0..gridHeight-1].
   * Resulting set cardinality is strictly in {4, 6, 9} <= 9.
   */
  public static computeAoI(
    cx: number,
    cz: number,
    gridWidth = DEFAULT_CHUNK_CONFIG.gridWidth,
    gridHeight = DEFAULT_CHUNK_CONFIG.gridHeight
  ): Set<string> {
    const clampedCx = Math.max(0, Math.min(gridWidth - 1, cx));
    const clampedCz = Math.max(0, Math.min(gridHeight - 1, cz));
    // Strict 3x3 AoI grid guaranteeing maximum 9 chunks active out of 100 (strictly <= 9.0% <= 10.0% limit)
    const minX = Math.max(0, clampedCx - 1);
    const maxX = Math.min(gridWidth - 1, clampedCx + 1);
    const minZ = Math.max(0, clampedCz - 1);
    const maxZ = Math.min(gridHeight - 1, clampedCz + 1);

    const aoi = new Set<string>();
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        aoi.add(ChunkStreamer.getChunkId(x, z));
      }
    }
    return aoi;
  }

  /**
   * Updates streaming state based on player world coordinates.
   * Computes set differences (toUnload vs toLoad) and executes unloads BEFORE loads
   * to guarantee that active chunks in memory never exceed 9 at any instant.
   */
  public update(playerX: number, playerZ: number): void {
    if (!Number.isFinite(playerX) || !Number.isFinite(playerZ)) {
      return;
    }

    const { cx, cz } = ChunkStreamer.worldToChunkCoords(
      playerX,
      playerZ,
      this.config.chunkSize,
      this.config.gridWidth,
      this.config.gridHeight
    );

    // Fast-path: player remained within the same center chunk
    if (this.lastChunkX === cx && this.lastChunkZ === cz) {
      return;
    }

    this.lastChunkX = cx;
    this.lastChunkZ = cz;

    const targetAoI = ChunkStreamer.computeAoI(
      cx,
      cz,
      this.config.gridWidth,
      this.config.gridHeight
    );

    // 1. Calculate toUnload = loadedChunks \ targetAoI
    const toUnload: string[] = [];
    for (const loadedId of this.loadedChunks.keys()) {
      if (!targetAoI.has(loadedId)) {
        toUnload.push(loadedId);
      }
    }

    // 2. Calculate toLoad = targetAoI \ loadedChunks
    const toLoad: string[] = [];
    for (const targetId of targetAoI) {
      if (!this.loadedChunks.has(targetId)) {
        toLoad.push(targetId);
      }
    }

    // 3. CRITICAL INVARIANT: Execute UNLOAD FIRST to prevent memory spikes
    for (const id of toUnload) {
      this.unloadChunk(id);
    }

    // 4. Execute LOAD SECOND
    for (const id of toLoad) {
      this.loadChunk(id);
    }
  }

  /**
   * Loads a single chunk: calls factory, mounts to scene, and registers in active map.
   */
  private loadChunk(id: string): void {
    if (this.loadedChunks.has(id)) {
      return;
    }

    const { cx, cz } = ChunkStreamer.parseChunkId(id);
    const group = this.chunkFactory(cx, cz, this.config);
    this.scene.add(group);

    const chunk: LoadedChunk = {
      id,
      cx,
      cz,
      worldX: cx * this.config.chunkSize,
      worldZ: cz * this.config.chunkSize,
      group,
    };

    this.loadedChunks.set(id, chunk);
  }

  /**
   * Unloads a single chunk: removes from scene, performs recursive GPU disposal, and unregisters.
   */
  private unloadChunk(id: string): void {
    const chunk = this.loadedChunks.get(id);
    if (!chunk) {
      return;
    }

    this.scene.remove(chunk.group);
    this.chunkDisposer(chunk.group);
    this.loadedChunks.delete(id);
  }

  /**
   * Gets the number of currently active chunks in memory.
   * Strictly in range [0..9] <= 9.
   */
  public getLoadedChunksCount(): number {
    return this.loadedChunks.size;
  }

  /**
   * Backward-compatibility alias for getLoadedChunksCount().
   */
  public getLoadedChunkCount(): number {
    return this.getLoadedChunksCount();
  }

  /**
   * Gets the cache percentage of the total world chunks.
   * Formula: (loadedChunksCount / totalChunks) * 100%.
   * Strictly in range [0.0..9.0] <= 10.0%.
   */
  public getCachePercentage(): number {
    return (this.loadedChunks.size / this.config.totalChunks) * 100;
  }

  /**
   * Checks if a chunk is currently loaded.
   */
  public hasChunk(id: string): boolean {
    return this.loadedChunks.has(id);
  }

  /**
   * Retrieves a loaded chunk instance by ID.
   */
  public getChunk(id: string): LoadedChunk | undefined {
    return this.loadedChunks.get(id);
  }

  /**
   * Returns a copy of all currently loaded chunk IDs.
   */
  public getLoadedChunkIds(): string[] {
    return Array.from(this.loadedChunks.keys());
  }

  /**
   * Returns the current center chunk coordinate or null if not yet updated.
   */
  public getCurrentCenterChunk(): { cx: number; cz: number } | null {
    if (this.lastChunkX === null || this.lastChunkZ === null) {
      return null;
    }
    return { cx: this.lastChunkX, cz: this.lastChunkZ };
  }

  /**
   * Returns read-only streamer configuration.
   */
  public getConfig(): Readonly<ChunkStreamerConfig> {
    return this.config;
  }

  /**
   * Completely disposes all active chunks, cleans up all GPU resources, and resets state.
   */
  public dispose(): void {
    for (const id of Array.from(this.loadedChunks.keys())) {
      this.unloadChunk(id);
    }
    this.loadedChunks.clear();
    this.lastChunkX = null;
    this.lastChunkZ = null;
  }
}
