/// <reference types="vitest" />
import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vite Dev Server Plugin: Level Editor Persistence Middleware
 * Exposes /api/editor/chunks REST endpoints for reading and persisting
 * Go-compatible chunk JSON files directly to server/world/chunks/*.json.
 */
export function levelEditorPlugin(): Plugin {
  return {
    name: 'level-editor-plugin',
    configureServer(server) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const chunksDir = path.resolve(currentDir, '../server/world/chunks');

      server.middlewares.use(async (req, res, next) => {
        const fullUrl = req.url?.split('?')[0] || '';

        // Only handle /api/editor/chunks routes
        if (!fullUrl.startsWith('/api/editor/chunks')) {
          return next();
        }

        const subPath = fullUrl.replace(/^\/api\/editor\/chunks\/?/, '');

        // 1. GET /api/editor/chunks - List all chunk IDs
        if (req.method === 'GET' && !subPath) {
          try {
            const files = await fs.readdir(chunksDir);
            const chunkIds = files
              .filter((f) => f.endsWith('.json'))
              .map((f) => f.replace(/\.json$/, ''))
              .sort();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(chunkIds));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Failed to list chunks' }));
          }
          return;
        }

        // 2. GET /api/editor/chunks/:id - Read single chunk JSON
        if (req.method === 'GET' && subPath) {
          const chunkId = subPath.replace(/\.json$/, '');
          if (!/^[a-zA-Z0-9_-]+$/.test(chunkId)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid chunk ID format' }));
            return;
          }

          const filePath = path.join(chunksDir, `${chunkId}.json`);
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(content);
          } catch (err: any) {
            if (err.code === 'ENOENT') {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `Chunk ${chunkId} not found` }));
            } else {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message || 'Failed to read chunk' }));
            }
          }
          return;
        }

        // 3. POST /api/editor/chunks/:id - Save single chunk JSON
        if (req.method === 'POST' && subPath) {
          const chunkId = subPath.replace(/\.json$/, '');
          if (!/^[a-zA-Z0-9_-]+$/.test(chunkId)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid chunk ID format' }));
            return;
          }

          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });

          req.on('end', async () => {
            try {
              const parsed = JSON.parse(body);
              if (!parsed.chunk_id) {
                parsed.chunk_id = chunkId;
              }

              // Enforce Go-compatible non-null array invariant
              parsed.buildings = Array.isArray(parsed.buildings) ? parsed.buildings : [];
              parsed.lanterns = Array.isArray(parsed.lanterns) ? parsed.lanterns : [];
              parsed.signs = Array.isArray(parsed.signs) ? parsed.signs : [];
              parsed.npcs = Array.isArray(parsed.npcs) ? parsed.npcs : [];
              parsed.items = Array.isArray(parsed.items) ? parsed.items : [];

              const jsonStr = JSON.stringify(parsed) + '\n';
              const filePath = path.join(chunksDir, `${chunkId}.json`);
              await fs.writeFile(filePath, jsonStr, 'utf-8');
              const bytesWritten = Buffer.byteLength(jsonStr, 'utf-8');

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, chunkId, bytesWritten }));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message || 'Failed to write chunk' }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [levelEditorPlugin()],
  server: {
    host: '0.0.0.0', // Exposes client to LAN for team laptop multiplayer
    port: 5173,
    strictPort: true,
    cors: true
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts']
  }
});

