import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WSClient } from '../src/net/WSClient';
import { PlayerMovePayload } from '../src/net/types';

describe('Adversarial Test Suite 1: Offline Standalone & Zero External Leaks', () => {
  const rootClientDir = path.resolve(__dirname, '..');

  describe('1. Static Source & Asset Leak Audit', () => {
    it('should have zero external CDN, font, or analytics URLs in index.html', () => {
      const indexPath = path.join(rootClientDir, 'index.html');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');

      // Check for remote script tags
      const scriptSrcMatches = content.match(/<script[^>]+src=["'](https?:)?\/\/[^"']+["']/gi);
      expect(scriptSrcMatches).toBeNull();

      // Check for remote stylesheets (e.g. Google Fonts, unpkg, cdnjs, fontawesome)
      const linkHrefMatches = content.match(/<link[^>]+href=["'](https?:)?\/\/[^"']+["']/gi);
      expect(linkHrefMatches).toBeNull();

      // Check for external CDN mentions in index.html
      const cdnMatches = content.match(/(cdnjs\.cloudflare\.com|unpkg\.com|jsdelivr\.net|googleapis\.com|google-analytics\.com)/gi);
      expect(cdnMatches).toBeNull();
    });

    it('should have zero remote @import or external url() in style.css', () => {
      const cssPath = path.join(rootClientDir, 'src', 'style.css');
      expect(fs.existsSync(cssPath)).toBe(true);
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // Check for @import url('http...')
      const remoteImportMatches = cssContent.match(/@import\s+(url\()?["'](https?:)?\/\/[^"'\)]+["']\)?/gi);
      expect(remoteImportMatches).toBeNull();

      // Check for any remote url(...) references
      const remoteUrlMatches = cssContent.match(/url\(\s*["']?(https?:)?\/\/[^"'\)]+["']?\s*\)/gi);
      expect(remoteUrlMatches).toBeNull();
    });

    it('should have zero external host URLs in src TypeScript files (ignoring XML namespaces)', () => {
      const srcDir = path.join(rootClientDir, 'src');
      const getFiles = (dir: string): string[] => {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat && stat.isDirectory()) {
            results = results.concat(getFiles(filePath));
          } else if (file.endsWith('.ts')) {
            results.push(filePath);
          }
        });
        return results;
      };

      const tsFiles = getFiles(srcDir);
      expect(tsFiles.length).toBeGreaterThan(0);

      const externalUrlRegex = /(https?:\/\/(?!www\.w3\.org)[a-zA-Z0-9.-]+(\/[^\s"']*)?)/gi;
      const leaks: Array<{ file: string; match: string }> = [];

      for (const file of tsFiles) {
        const text = fs.readFileSync(file, 'utf-8');
        const matches = text.match(externalUrlRegex);
        if (matches) {
          for (const m of matches) {
            leaks.push({ file: path.relative(rootClientDir, file), match: m });
          }
        }
      }

      expect(leaks).toEqual([]);
    });

    it('should have zero external URLs in production build bundle (dist/)', () => {
      const distDir = path.join(rootClientDir, 'dist');
      if (!fs.existsSync(distDir)) {
        console.warn('dist directory does not exist, skipping bundle check');
        return;
      }

      const distIndex = path.join(distDir, 'index.html');
      const indexHtml = fs.readFileSync(distIndex, 'utf-8');

      // Strip allowed SVG namespace
      const sanitizedIndex = indexHtml.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');

      expect(sanitizedIndex.includes('http://')).toBe(false);
      expect(sanitizedIndex.includes('https://')).toBe(false);
      expect(sanitizedIndex.includes('fonts.googleapis.com')).toBe(false);
      expect(sanitizedIndex.includes('unpkg.com')).toBe(false);
      expect(sanitizedIndex.includes('cdnjs')).toBe(false);
    });
  });

  describe('2. Standalone MockServer & WSClient Offline Behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('should operate 100% locally when mock mode is enabled without creating WebSocket', async () => {
      // Mock global WebSocket to detect if any native socket is attempted
      const originalWebSocket = globalThis.WebSocket;
      const webSocketConstructorSpy = vi.fn();
      globalThis.WebSocket = webSocketConstructorSpy as any;

      try {
        const client = new WSClient({ mock: true });
        expect(client.isMockMode).toBe(true);

        const moveEvents: PlayerMovePayload[] = [];
        let balanceReceived = 0;

        client.on('PLAYER_MOVE', (p) => moveEvents.push(p));
        client.on('BALANCE', (b) => {
          balanceReceived = b.balance;
        });

        await client.connect();

        // Must NOT have instantiated native WebSocket
        expect(webSocketConstructorSpy).not.toHaveBeenCalled();

        // Must be in open state
        expect(client.isConnected).toBe(true);
        expect(client.state).toBe('open');

        // Initial balance received
        expect(balanceReceived).toBe(500);

        // Initial bot spawns received
        expect(moveEvents.length).toBeGreaterThanOrEqual(2);
        expect(moveEvents.some((m) => m.player_id === 101)).toBe(true);
        expect(moveEvents.some((m) => m.player_id === 102)).toBe(true);

        // Advance simulation loop by 500ms (10 bot ticks)
        const countBefore = moveEvents.length;
        vi.advanceTimersByTime(500);
        expect(moveEvents.length).toBeGreaterThan(countBefore);

        // Clean disconnect stops all internal timers
        client.disconnect();
        expect(client.isConnected).toBe(false);
        expect(client.state).toBe('closed');
      } finally {
        globalThis.WebSocket = originalWebSocket;
      }
    });

    it('keeps an authenticated connection offline after retries instead of creating a fake session', async () => {
      // Create a mock failing WebSocket
      class FailingWebSocket {
        public readyState = 3; // CLOSED
        public onopen: any = null;
        public onerror: any = null;
        public onclose: any = null;
        constructor() {
          setTimeout(() => {
            if (this.onerror) this.onerror(new Event('error'));
            if (this.onclose) this.onclose({ code: 1006, reason: '' });
          }, 10);
        }
      }

      const originalWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = FailingWebSocket as any;

      try {
        const client = new WSClient({
          url: 'ws://nonexistent-server:8080/ws',
          mock: false,
          autoReconnect: true,
          reconnectInterval: 50,
          maxReconnectAttempts: 2,
        });

        // Connection should reject
        const rejected = expect(client.connect()).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(20);
        await rejected;

        // Fast-forward through reconnect attempts until maxReconnectAttempts is hit
        await vi.advanceTimersByTimeAsync(500);
        expect(client.isMockMode).toBe(false);
        expect(client.isConnected).toBe(false);
        expect(client.getMockServer()).toBeNull();

        client.disconnect();
      } finally {
        globalThis.WebSocket = originalWebSocket;
      }
    });

    it('should correctly process standalone DIALOGUE & INSPECT game loops offline', async () => {
      const client = new WSClient({ mock: true });
      await client.connect();

      let lastDialogueState: any = null;
      let lastWordLearned: any = null;
      let currentBalance = 500;

      client.on('NPC_SPEECH', (s) => {
        lastDialogueState = s;
      });
      client.on('WORD_LEARNED', (w) => {
        lastWordLearned = w;
      });
      client.on('BALANCE', (b) => {
        currentBalance = b.balance;
      });

      // 1. Dialogue Choice 1: Haggling
      client.send('DIALOGUE', { npc_id: 'lao_wang', choice_id: 1 });
      expect(lastDialogueState).not.toBeNull();
      expect(lastDialogueState.emotion).toBe('HAPPY');
      expect(lastDialogueState.mianzi).toBe(50); // 40 + 10
      expect(lastDialogueState.aggro).toBe(10);  // 20 - 10

      // 2. Dialogue Choice 2: Provocation
      client.send('DIALOGUE', { npc_id: 'lao_wang', choice_id: 3 });
      expect(lastDialogueState.emotion).toBe('FURIOUS');
      expect(lastDialogueState.mianzi).toBe(25); // 50 - 25
      expect(lastDialogueState.aggro).toBe(50);  // 10 + 40

      // 3. Inspect teapot with correct answer (answer_id: 1)
      client.send('INSPECT', { item_id: 'item_teapot', answer_id: 1 });
      expect(lastWordLearned).not.toBeNull();
      expect(lastWordLearned.word_id).toBe('word_teapot');
      expect(lastWordLearned.zh).toBe('茶壶');
      expect(lastWordLearned.ru).toBe('чайник');

      // Balance was rewarded +50
      expect(currentBalance).toBe(550);

      client.disconnect();
    });
  });
});
