/**
 * ChunkStorage.ts
 *
 * Implements Milestone M4: Chunk Storage Abstractions & Implementations.
 * Provides IChunkStorage interface with:
 * - HttpChunkStorage (Vite dev server /api/editor/chunks REST endpoints)
 * - LocalStorageChunkStorage (Browser localStorage under 'rih_level_editor_chunks')
 * - MockChunkStorage (In-memory storage for headless Vitest tests)
 * - CompositeChunkStorage (Dual-durability: HTTP + LocalStorage)
 */

import { RawChunkData, sanitizeChunkData } from './ChunkPersistence';

export interface IChunkStorage {
  loadChunk(chunkId: string): Promise<RawChunkData | null>;
  saveChunk(chunkId: string, data: RawChunkData): Promise<boolean>;
  saveAllDirtyChunks(chunks: Map<string, RawChunkData>): Promise<number>;
  listChunks(): Promise<string[]>;
  /**
   * Chunks from the last saveAllDirtyChunks() that other players can read.
   * Absent: the storage itself is shared, so every saved chunk counts.
   */
  readonly lastSharedChunkIds?: string[];
}

/**
 * HttpChunkStorage: Communicates with Vite dev server middleware endpoints.
 * - GET /api/editor/chunks
 * - GET /api/editor/chunks/:id
 * - POST /api/editor/chunks/:id
 */
export class HttpChunkStorage implements IChunkStorage {
  private readonly baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public async listChunks(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/api/editor/chunks`;
      const res = await fetch(url);
      if (!res.ok) {
        return [];
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('[HttpChunkStorage] listChunks failed:', err);
      return [];
    }
  }

  public async loadChunk(chunkId: string): Promise<RawChunkData | null> {
    try {
      const url = `${this.baseUrl}/api/editor/chunks/${chunkId}`;
      const res = await fetch(url);
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      return sanitizeChunkData(data);
    } catch (err) {
      console.warn(`[HttpChunkStorage] loadChunk(${chunkId}) failed:`, err);
      return null;
    }
  }

  public async saveChunk(chunkId: string, data: RawChunkData): Promise<boolean> {
    try {
      const sanitized = sanitizeChunkData(data);
      const url = `${this.baseUrl}/api/editor/chunks/${chunkId}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sanitized),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[HttpChunkStorage] saveChunk(${chunkId}) failed:`, err);
      return false;
    }
  }

  public async saveAllDirtyChunks(chunks: Map<string, RawChunkData>): Promise<number> {
    let savedCount = 0;
    for (const [chunkId, data] of Array.from(chunks.entries())) {
      const success = await this.saveChunk(chunkId, data);
      if (success) {
        savedCount++;
      }
    }
    return savedCount;
  }
}

export const LOCAL_STORAGE_KEY = 'rih_level_editor_chunks';

/**
 * LocalStorageChunkStorage: Saves chunk configurations to browser localStorage.
 * Ensures page reloads immediately retain user edits even without server restart.
 * Gracefully falls back to an in-memory Map in non-browser/headless environments.
 */
export class LocalStorageChunkStorage implements IChunkStorage {
  private readonly key: string;
  private readonly memoryFallback = new Map<string, RawChunkData>();

  constructor(key: string = LOCAL_STORAGE_KEY) {
    this.key = key;
  }

  private hasLocalStorage(): boolean {
    try {
      return (
        typeof window !== 'undefined' &&
        typeof window.localStorage !== 'undefined' &&
        window.localStorage !== null
      );
    } catch {
      return false;
    }
  }

  private readAll(): Record<string, RawChunkData> {
    if (this.hasLocalStorage()) {
      try {
        const raw = window.localStorage.getItem(this.key);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch (err) {
        console.warn('[LocalStorageChunkStorage] Failed to read from localStorage:', err);
        return {};
      }
    }

    const obj: Record<string, RawChunkData> = {};
    for (const [k, v] of Array.from(this.memoryFallback.entries())) {
      obj[k] = v;
    }
    return obj;
  }

  private writeAll(record: Record<string, RawChunkData>): void {
    if (this.hasLocalStorage()) {
      try {
        window.localStorage.setItem(this.key, JSON.stringify(record));
        return;
      } catch (err) {
        console.warn('[LocalStorageChunkStorage] Failed to write to localStorage:', err);
      }
    }

    this.memoryFallback.clear();
    for (const [k, v] of Object.entries(record)) {
      this.memoryFallback.set(k, v);
    }
  }

  public async listChunks(): Promise<string[]> {
    const all = this.readAll();
    return Object.keys(all).sort();
  }

  public async loadChunk(chunkId: string): Promise<RawChunkData | null> {
    const all = this.readAll();
    const data = all[chunkId];
    return data ? sanitizeChunkData(data) : null;
  }

  public async saveChunk(chunkId: string, data: RawChunkData): Promise<boolean> {
    const all = this.readAll();
    all[chunkId] = sanitizeChunkData(data);
    this.writeAll(all);
    return true;
  }

  public async saveAllDirtyChunks(chunks: Map<string, RawChunkData>): Promise<number> {
    const all = this.readAll();
    let count = 0;
    for (const [chunkId, data] of Array.from(chunks.entries())) {
      all[chunkId] = sanitizeChunkData(data);
      count++;
    }
    this.writeAll(all);
    return count;
  }

  public clear(): void {
    if (this.hasLocalStorage()) {
      try {
        window.localStorage.removeItem(this.key);
      } catch {
        // ignore
      }
    }
    this.memoryFallback.clear();
  }
}

/**
 * MockChunkStorage: In-memory chunk storage designed for automated Vitest suites.
 * Supports dirty tracking, deterministic clearing, and chunk counting.
 */
export class MockChunkStorage implements IChunkStorage {
  private readonly chunks = new Map<string, RawChunkData>();
  private readonly dirtyChunks = new Set<string>();

  public async listChunks(): Promise<string[]> {
    return Array.from(this.chunks.keys()).sort();
  }

  public async loadChunk(chunkId: string): Promise<RawChunkData | null> {
    const data = this.chunks.get(chunkId);
    if (!data) return null;
    return JSON.parse(JSON.stringify(data));
  }

  public async saveChunk(chunkId: string, data: RawChunkData): Promise<boolean> {
    const sanitized = sanitizeChunkData(data);
    this.chunks.set(chunkId, JSON.parse(JSON.stringify(sanitized)));
    this.dirtyChunks.delete(chunkId);
    return true;
  }

  public async saveAllDirtyChunks(chunks: Map<string, RawChunkData>): Promise<number> {
    let saved = 0;
    for (const [chunkId, data] of Array.from(chunks.entries())) {
      await this.saveChunk(chunkId, data);
      saved++;
    }
    return saved;
  }

  public markDirty(chunkId: string): void {
    this.dirtyChunks.add(chunkId);
  }

  public isDirty(chunkId: string): boolean {
    return this.dirtyChunks.has(chunkId);
  }

  public getDirtyCount(): number {
    return this.dirtyChunks.size;
  }

  public getDirtyChunkIds(): string[] {
    return Array.from(this.dirtyChunks);
  }

  public seedChunk(data: RawChunkData): void {
    this.chunks.set(data.chunk_id, sanitizeChunkData(data));
  }

  public clear(): void {
    this.chunks.clear();
    this.dirtyChunks.clear();
  }

  public getChunkCount(): number {
    return this.chunks.size;
  }
}

/**
 * CompositeChunkStorage: Writes to both HTTP and LocalStorage for dual durability.
 * Reading checks HttpChunkStorage first — the server disk files are the map shared by
 * every player — and falls back to LocalStorage only when the server is unreachable.
 */
export class CompositeChunkStorage implements IChunkStorage {
  private readonly httpStorage: IChunkStorage;
  private readonly localStorage: IChunkStorage;
  /** Chunks from the last saveAllDirtyChunks() that reached the shared HTTP storage. */
  public lastSharedChunkIds: string[] = [];

  constructor(
    httpStorage: IChunkStorage = new HttpChunkStorage(),
    localStorage: IChunkStorage = new LocalStorageChunkStorage()
  ) {
    this.httpStorage = httpStorage;
    this.localStorage = localStorage;
  }

  public async listChunks(): Promise<string[]> {
    const [localList, httpList] = await Promise.all([
      this.localStorage.listChunks().catch(() => []),
      this.httpStorage.listChunks().catch(() => []),
    ]);

    const set = new Set<string>([...localList, ...httpList]);
    return Array.from(set).sort();
  }

  public async loadChunk(chunkId: string): Promise<RawChunkData | null> {
    // 1. Shared server copy first, so every player sees the latest edits by anyone
    try {
      const httpData = await this.httpStorage.loadChunk(chunkId);
      if (httpData) {
        // Cache to local for fast future offline access
        await this.localStorage.saveChunk(chunkId, httpData).catch(() => {});
        return httpData;
      }
    } catch (err) {
      console.warn(`[CompositeChunkStorage] Http read error for ${chunkId}:`, err);
    }

    // 2. Offline fallback: this browser's last known copy
    try {
      const localData = await this.localStorage.loadChunk(chunkId);
      if (localData) {
        return localData;
      }
    } catch (err) {
      console.warn(`[CompositeChunkStorage] Local read error for ${chunkId}:`, err);
    }

    return null;
  }

  public async saveChunk(chunkId: string, data: RawChunkData): Promise<boolean> {
    const { localOk, httpOk } = await this.saveToBoth(chunkId, data);
    // Return true if at least one storage medium succeeded
    return localOk || httpOk;
  }

  private async saveToBoth(chunkId: string, data: RawChunkData): Promise<{ localOk: boolean; httpOk: boolean }> {
    const sanitized = sanitizeChunkData(data);

    // Save to local storage first
    let localOk = false;
    try {
      localOk = await this.localStorage.saveChunk(chunkId, sanitized);
    } catch (err) {
      console.warn(`[CompositeChunkStorage] Local save failed for ${chunkId}:`, err);
    }

    // Save to HTTP server
    let httpOk = false;
    try {
      httpOk = await this.httpStorage.saveChunk(chunkId, sanitized);
    } catch (err) {
      console.warn(`[CompositeChunkStorage] Http save failed for ${chunkId}:`, err);
    }

    return { localOk, httpOk };
  }

  public async saveAllDirtyChunks(chunks: Map<string, RawChunkData>): Promise<number> {
    let saved = 0;
    const shared: string[] = [];
    for (const [chunkId, data] of Array.from(chunks.entries())) {
      const { localOk, httpOk } = await this.saveToBoth(chunkId, data);
      if (localOk || httpOk) saved++;
      if (httpOk) shared.push(chunkId);
    }
    this.lastSharedChunkIds = shared;
    return saved;
  }
}
