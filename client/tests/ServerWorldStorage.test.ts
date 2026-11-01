import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerWorldStorage } from '../src/editor/ChunkStorage';
import { createEmptyChunk } from '../src/editor/ChunkPersistence';

afterEach(() => vi.unstubAllGlobals());

describe('server world storage', () => {
  it('uses authenticated versioned atomic saves and accepts only confirmed updates', async () => {
    const chunk = createEmptyChunk('5_6');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ok: true, json: async () => ({chunks: {'5_6': {data: chunk, revision: 1}}})})
      .mockResolvedValueOnce({ok: true, json: async () => ({chunks: {'5_6': {data: chunk, revision: 2}}})});
    vi.stubGlobal('fetch', fetcher);
    const storage = new ServerWorldStorage('http://game', 'token');
    expect(await storage.listChunks()).toEqual(['5_6']);
    expect(await storage.saveAllDirtyChunks(new Map([['5_6', chunk]]))).toBe(1);
    const request = fetcher.mock.calls[1][1];
    expect(request.headers.Authorization).toBe('Bearer token');
    expect(JSON.parse(request.body).chunks['5_6'].revision).toBe(1);
    expect(storage.lastSharedChunkIds).toEqual(['5_6']);
  });
  it('leaves a conflicting save unconfirmed and never falls back to local storage', async () => {
    const chunk = createEmptyChunk('5_6');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ok: true, json: async () => ({chunks: {'5_6': {data: chunk, revision: 1}}})})
      .mockResolvedValueOnce({ok: false, status: 409});
    vi.stubGlobal('fetch', fetcher);
    const storage = new ServerWorldStorage('', 'token');
    await storage.listChunks();
    await expect(storage.saveAllDirtyChunks(new Map([['5_6', chunk]]))).rejects.toThrow('WORLD_CONFLICT');
    expect(storage.lastSharedChunkIds).toEqual([]);
  });
});
