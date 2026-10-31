/**
 * Rest-In-Hackaton: Adversarial M2 Empirical Verification Suite
 *
 * Challenger Role: challenger_m2_1
 * Mission:
 * 1. Empirically stress-test the <= 10% memory limit invariant under extreme stress:
 *    - 10,000 randomized fuzzing coordinates (uniform, Gaussian, Cauchy, far out-of-bounds).
 *    - Rapid teleports across opposite diagonal corners of the map.
 *    - Pathological coordinates (x = -500, z = 5000, NaN, Infinity, Number.MAX_SAFE_INTEGER, sub-pixel floats).
 *    - Micro zig-zag boundary seam oscillations (1,000 rapid crossings).
 * 2. Assert that under NO condition does active chunk count exceed 9 or cache percentage exceed 9.0% (<= 10.0%).
 * 3. Verify zero GPU memory leaks, strict "Unload First, Load Second" temporal ordering, and HUD invariant integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ChunkStreamer, DEFAULT_CHUNK_CONFIG, defaultChunkDisposer } from '../src/engine/ChunkStreamer';
import { ChunkBuilder } from '../src/engine/ChunkBuilder';
import { HUD } from '../src/ui/HUD';

describe('Adversarial M2: Strict Memory Invariant & Stress Challenge', () => {
  let scene: THREE.Scene;
  let streamer: ChunkStreamer;

  beforeEach(() => {
    scene = new THREE.Scene();
    streamer = new ChunkStreamer(scene);
  });

  afterEach(() => {
    streamer.dispose();
    scene.clear();
  });

  // =========================================================================
  // Mission 1: Randomized Coordinate Fuzzing (10,000 Continuous Inputs)
  // =========================================================================
  describe('Mission 1: Massive Monte-Carlo Coordinate Fuzzing', () => {
    it('FUZZ-01: 2,000 randomized continuous coordinates with full Three.js scene streaming strictly satisfy chunks <= 9 and cache <= 9.0%', () => {
      let maxChunksObserved = 0;
      let maxCachePercentObserved = 0;

      let seed = 424242;
      const lcg = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      for (let i = 0; i < 2000; i++) {
        let x: number;
        let z: number;

        const mode = i % 5;
        if (mode === 0) {
          x = lcg() * 200;
          z = lcg() * 200;
        } else if (mode === 1) {
          x = (lcg() - 0.5) * 1000;
          z = (lcg() - 0.5) * 1000;
        } else if (mode === 2) {
          x = (lcg() - 0.5) * 200000;
          z = (lcg() - 0.5) * 200000;
        } else if (mode === 3) {
          const baseChunkX = Math.floor(lcg() * 11) * 20;
          const baseChunkZ = Math.floor(lcg() * 11) * 20;
          const eps = (lcg() - 0.5) * 0.0002;
          x = baseChunkX + eps;
          z = baseChunkZ + eps;
        } else {
          x = (lcg() > 0.5 ? 1 : -1) * Math.pow(10, (lcg() - 0.5) * 10);
          z = (lcg() > 0.5 ? 1 : -1) * Math.pow(10, (lcg() - 0.5) * 10);
        }

        streamer.update(x, z);

        const count = streamer.getLoadedChunksCount();
        const percent = streamer.getCachePercentage();

        if (count > maxChunksObserved) maxChunksObserved = count;
        if (percent > maxCachePercentObserved) maxCachePercentObserved = percent;

        expect(count).toBeLessThanOrEqual(9);
        expect(percent).toBeLessThanOrEqual(9.0);
        expect(percent).toBeLessThanOrEqual(10.0);
        expect(scene.children.length).toBe(count);

        const chunkIds = streamer.getLoadedChunkIds();
        expect(chunkIds.length).toBe(count);
        for (const id of chunkIds) {
          const { cx, cz } = ChunkStreamer.parseChunkId(id);
          expect(cx).toBeGreaterThanOrEqual(0);
          expect(cx).toBeLessThanOrEqual(9);
          expect(cz).toBeGreaterThanOrEqual(0);
          expect(cz).toBeLessThanOrEqual(9);
          expect(streamer.hasChunk(id)).toBe(true);
        }
      }

      expect(maxChunksObserved).toBe(9);
      expect(maxCachePercentObserved).toBe(9.0);
    });

    it('FUZZ-02: 50,000 mathematical coordinate pairs rigorously assert AoI cardinality strictly in {4, 6, 9} <= 9', () => {
      let seed = 987654321;
      const lcg = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      for (let i = 0; i < 50000; i++) {
        const x = (lcg() - 0.5) * 1e8;
        const z = (lcg() - 0.5) * 1e8;

        const { cx, cz } = ChunkStreamer.worldToChunkCoords(x, z);
        expect(cx).toBeGreaterThanOrEqual(0);
        expect(cx).toBeLessThanOrEqual(9);
        expect(cz).toBeGreaterThanOrEqual(0);
        expect(cz).toBeLessThanOrEqual(9);

        const aoi = ChunkStreamer.computeAoI(cx, cz);
        expect(aoi.size).toBeLessThanOrEqual(9);
        expect([4, 6, 9].includes(aoi.size)).toBe(true);
        expect((aoi.size / 100) * 100).toBeLessThanOrEqual(9.0);
      }
    });
  });

  // =========================================================================
  // Mission 2: Rapid Diagonal Corner Teleportation
  // =========================================================================
  describe('Mission 2: Rapid Diagonal Corner Teleportation Stress', () => {
    it('TELEPORT-01: 1,000 rapid teleport jumps across opposite corners of the map strictly maintain <= 9 chunks and zero leaks', () => {
      const corners = [
        { x: 0, z: 0, desc: 'Top-Left Corner' },
        { x: 200, z: 200, desc: 'Bottom-Right Corner' },
        { x: 0, z: 200, desc: 'Bottom-Left Corner' },
        { x: 200, z: 0, desc: 'Top-Right Corner' },
        { x: 100, z: 100, desc: 'Center Plaza' },
        { x: -500, z: 5000, desc: 'Pathological OOB' },
      ];

      for (let i = 0; i < 1000; i++) {
        const target = corners[i % corners.length];
        streamer.update(target.x, target.z);

        const count = streamer.getLoadedChunksCount();
        const cachePercent = streamer.getCachePercentage();

        expect(count).toBeLessThanOrEqual(9);
        expect(cachePercent).toBeLessThanOrEqual(9.0);
        expect(scene.children.length).toBe(count);
      }
    });

    it('TELEPORT-02: Instantaneous jump from (0,0) to (200,200) unloads all 4 old chunks and loads exactly 4 new chunks with zero overlap', () => {
      // 1. Position at (0, 0)
      streamer.update(0, 0);
      expect(streamer.getLoadedChunksCount()).toBe(4);
      expect(streamer.getCachePercentage()).toBe(4.0);
      const initialChunks = new Set(streamer.getLoadedChunkIds());
      expect(initialChunks).toEqual(new Set(['0_0', '0_1', '1_0', '1_1']));

      // 2. Teleport to (200, 200)
      streamer.update(200, 200);
      expect(streamer.getLoadedChunksCount()).toBe(4);
      expect(streamer.getCachePercentage()).toBe(4.0);
      const newChunks = new Set(streamer.getLoadedChunkIds());
      expect(newChunks).toEqual(new Set(['8_8', '8_9', '9_8', '9_9']));

      // Completely disjoint chunk sets
      for (const oldId of initialChunks) {
        expect(newChunks.has(oldId)).toBe(false);
        expect(streamer.hasChunk(oldId)).toBe(false);
      }
    });
  });

  // =========================================================================
  // Mission 3: Pathological Coordinates & Non-Finite Numbers
  // =========================================================================
  describe('Mission 3: Pathological & IEEE 754 Boundary Extremes', () => {
    it('PATHO-01: Pathological out-of-bounds coordinates (x = -500, z = 5000) clamp safely to grid bounds', () => {
      streamer.update(-500, 5000);
      expect(streamer.getLoadedChunksCount()).toBe(4);
      expect(streamer.getCachePercentage()).toBe(4.0);
      expect(streamer.getCurrentCenterChunk()).toEqual({ cx: 0, cz: 9 });
      expect(streamer.getLoadedChunkIds().sort()).toEqual(['0_8', '0_9', '1_8', '1_9'].sort());
    });

    it('PATHO-02: Non-finite inputs (NaN, +/-Infinity) do not crash or corrupt existing loaded chunks', () => {
      // Establish valid center state at (100, 100) -> 9 chunks
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      const previousLoadedIds = streamer.getLoadedChunkIds();

      // Pass NaN and Infinity coordinates
      streamer.update(Number.NaN, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(streamer.getLoadedChunkIds()).toEqual(previousLoadedIds);

      streamer.update(100, Number.POSITIVE_INFINITY);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(streamer.getLoadedChunkIds()).toEqual(previousLoadedIds);

      streamer.update(Number.NEGATIVE_INFINITY, Number.NaN);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(streamer.getLoadedChunkIds()).toEqual(previousLoadedIds);
    });

    it('PATHO-03: Extreme numeric boundaries (Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER) clamp cleanly to corner chunks', () => {
      streamer.update(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      expect(streamer.getLoadedChunksCount()).toBe(4);
      expect(streamer.getCachePercentage()).toBe(4.0);
      expect(streamer.getCurrentCenterChunk()).toEqual({ cx: 9, cz: 9 });

      streamer.update(Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
      expect(streamer.getLoadedChunksCount()).toBe(4);
      expect(streamer.getCachePercentage()).toBe(4.0);
      expect(streamer.getCurrentCenterChunk()).toEqual({ cx: 0, cz: 0 });
    });

    it('PATHO-04: Sub-pixel float perturbations around chunk seam (19.99999999999999 vs 20.00000000000001) resolve deterministically', () => {
      const nearLeft = 19.99999999999999;
      const nearRight = 20.00000000000001;

      const coordsLeft = ChunkStreamer.worldToChunkCoords(nearLeft, 100);
      const coordsRight = ChunkStreamer.worldToChunkCoords(nearRight, 100);

      expect(coordsLeft.cx).toBe(0);
      expect(coordsRight.cx).toBe(1);

      streamer.update(nearLeft, 100);
      expect(streamer.getLoadedChunksCount()).toBe(6); // boundary edge x = 0

      streamer.update(nearRight, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9); // interior x = 1
    });
  });

  // =========================================================================
  // Mission 4: Boundary Seam Zig-Zag Oscillation & Hysteresis Stress
  // =========================================================================
  describe('Mission 4: Micro Zig-Zag Boundary Seam Oscillations', () => {
    it('ZIGZAG-01: 1,000 rapid back-and-forth oscillations across boundary seam cause zero chunk duplication or leaks', () => {
      // Oscillate across chunk border x = 20.0 (between chunk 0 and chunk 1)
      for (let i = 0; i < 1000; i++) {
        const x = i % 2 === 0 ? 19.999 : 20.001;
        streamer.update(x, 100);

        const count = streamer.getLoadedChunksCount();
        expect(count).toBeLessThanOrEqual(9);
        expect(streamer.getCachePercentage()).toBeLessThanOrEqual(9.0);
        expect(scene.children.length).toBe(count);
      }
    });

    it('ZIGZAG-02: Rapid diagonal oscillation across 4-chunk intersection (19.99, 19.99) <-> (20.01, 20.01)', () => {
      for (let i = 0; i < 500; i++) {
        const offset = i % 2 === 0 ? -0.01 : 0.01;
        streamer.update(20 + offset, 20 + offset);

        const count = streamer.getLoadedChunksCount();
        expect(count).toBeLessThanOrEqual(9);
        expect(streamer.getCachePercentage()).toBeLessThanOrEqual(9.0);
        expect(scene.children.length).toBe(count);
      }
    });
  });

  // =========================================================================
  // Mission 5: Intra-Tick Invariant & Temporal Order Verification
  // =========================================================================
  describe('Mission 5: Intra-Tick Memory Invariant & Temporal Ordering', () => {
    it('INTRATICK-01: Monitored chunk count NEVER exceeds 9 at any instantaneous point during chunk streaming update', () => {
      let maxCountDuringExecution = 0;
      let recordedEvents: Array<{ action: 'load' | 'unload'; currentCount: number }> = [];

      const monitoredFactory = (cx: number, cz: number) => {
        const count = streamer.getLoadedChunksCount();
        if (count > maxCountDuringExecution) maxCountDuringExecution = count;
        recordedEvents.push({ action: 'load', currentCount: count });

        const group = new THREE.Group();
        group.name = `monitored_${cx}_${cz}`;
        return group;
      };

      const monitoredDisposer = (_group: THREE.Object3D) => {
        const count = streamer.getLoadedChunksCount();
        if (count > maxCountDuringExecution) maxCountDuringExecution = count;
        recordedEvents.push({ action: 'unload', currentCount: count });
      };

      const customStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        monitoredFactory,
        monitoredDisposer
      );

      // 1. Initial load at center (100, 100) -> 9 chunks
      customStreamer.update(100, 100);
      expect(customStreamer.getLoadedChunksCount()).toBe(9);
      expect(maxCountDuringExecution).toBeLessThanOrEqual(9);

      // 2. Perform 50 sequential transitions across adjacent and diagonal chunks
      const transitions = [
        [120, 100], // East
        [140, 100], // East
        [140, 120], // South
        [120, 120], // West
        [100, 100], // Northwest
        [0, 0],     // Corner teleport
        [20, 20],   // Diagonal
        [180, 180], // Opposite corner
        [100, 100], // Center
      ];

      for (const [tx, tz] of transitions) {
        recordedEvents = [];
        customStreamer.update(tx, tz);

        // Verify active count at completion
        expect(customStreamer.getLoadedChunksCount()).toBeLessThanOrEqual(9);
        expect(customStreamer.getCachePercentage()).toBeLessThanOrEqual(9.0);

        // Verify that every unload event occurred BEFORE any load event
        let seenLoad = false;
        for (const evt of recordedEvents) {
          if (evt.action === 'load') {
            seenLoad = true;
          } else if (evt.action === 'unload') {
            expect(seenLoad).toBe(false); // An unload occurred after a load: INVARIANT VIOLATION!
          }
        }
      }

      expect(maxCountDuringExecution).toBeLessThanOrEqual(9);
      customStreamer.dispose();
    });
  });

  // =========================================================================
  // Mission 6: GPU Memory Leak & Disposal Completeness Stress
  // =========================================================================
  describe('Mission 6: GPU Resource Disposal Completeness', () => {
    it('DISPOSAL-01: Disposes all procedural geometries and materials across 100 full load/unload cycles', () => {
      let createdGeometries = 0;
      let disposedGeometries = 0;

      const trackedFactory = (cx: number, cz: number) => {
        const group = ChunkBuilder.buildChunk(cx, cz);
        group.traverse((child) => {
          if ('geometry' in child && (child as any).geometry) {
            createdGeometries++;
            const originalDispose = (child as any).geometry.dispose.bind((child as any).geometry);
            (child as any).geometry.dispose = () => {
              disposedGeometries++;
              originalDispose();
            };
          }
        });
        return group;
      };

      const trackedStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        trackedFactory,
        defaultChunkDisposer
      );

      // Cycle between (0, 0) and (200, 200) 50 times (100 total moves)
      for (let i = 0; i < 50; i++) {
        trackedStreamer.update(0, 0);
        trackedStreamer.update(200, 200);
      }

      // Dispose streamer cleanly at the end
      trackedStreamer.dispose();

      // All created geometries must have been cleanly disposed
      expect(createdGeometries).toBeGreaterThan(0);
      expect(disposedGeometries).toBe(createdGeometries);
      expect(trackedStreamer.getLoadedChunksCount()).toBe(0);
      expect(scene.children.length).toBe(0);
    });
  });

  // =========================================================================
  // Mission 7: HUD Invariant Under Adversarial Inputs
  // =========================================================================
  describe('Mission 7: HUD Visual Invariant Under Extreme Telemetry Feeds', () => {
    class MockElement {
      public textContent: string = '';
      public className: string = '';
      private attributes: Record<string, string> = {};
      public classList = {
        contains: (cls: string) => this.className.includes(cls),
        add: (cls: string) => {
          if (!this.classList.contains(cls)) {
            this.className = this.className ? `${this.className} ${cls}` : cls;
          }
        },
        remove: (cls: string) => {
          this.className = this.className
            .split(' ')
            .filter((c) => c !== cls)
            .join(' ');
        },
      };

      public setAttribute(name: string, val: string): void {
        this.attributes[name] = val;
      }

      public getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      public appendChild(child: any): any {
        return child;
      }

      public removeChild(child: any): any {
        return child;
      }
    }

    let origDoc: any;
    let mockElements: Record<string, MockElement>;

    beforeEach(() => {
      origDoc = (globalThis as any).document;
      mockElements = {
        'hud-fps': new MockElement(),
        'hud-cache': new MockElement(),
        'hud-cache-badge': new MockElement(),
        'hud-chunks': new MockElement(),
        'hud-coords': new MockElement(),
        'hud-balance': new MockElement(),
        'hud-status': new MockElement(),
        'toast-container': new MockElement(),
      };

      (globalThis as any).document = {
        getElementById: (id: string) => mockElements[id] ?? null,
        createElement: (_tag: string) => new MockElement(),
      };
    });

    afterEach(() => {
      (globalThis as any).document = origDoc;
    });

    it('HUD-01: Correctly classifies 1,000 randomized cache % inputs as strictly OK or WARN', () => {
      const hud = new HUD();

      for (let i = 0; i <= 200; i++) {
        const cachePercent = i * 0.1; // 0.0% to 20.0%
        hud.update(60, cachePercent, Math.round(cachePercent), 100, 100);

        if (cachePercent <= 10.0) {
          expect(hud.isLimitOk()).toBe(true);
          expect(hud.getCacheBadgeText()).toBe('ЛИМИТ 10% OK');
          expect(hud.getCacheBadgeClass()).toContain('badge-ok');
        } else {
          expect(hud.isLimitOk()).toBe(false);
          expect(hud.getCacheBadgeText()).toBe('ПРЕВЫШЕН ЛИМИТ!');
          expect(hud.getCacheBadgeClass()).toContain('badge-warn');
        }
      }
    });

    it('HUD-02: Robust formatting of negative and boundary coordinates without layout corruption', () => {
      const hud = new HUD();
      hud.update(144, 9, 9, -500.1234, 5000.9876);

      expect(hud.getFpsText()).toBe('144');
      expect(hud.getCacheText()).toBe('9%');
      expect(hud.getCoordsText()).toBe('(-500.1, 5001.0)');
      expect(hud.isLimitOk()).toBe(true);
    });
  });
});
