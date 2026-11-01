/**
 * Rest-In-Hackaton: Automated Vitest Test Suite for ChunkStreamer & 10% Memory Limit Invariant
 *
 * Requirements Tested:
 * 1. Cache % calculation across corners (4 chunks, 4%), edges (6 chunks, 6%), and center (9 chunks, 9%).
 * 2. Verification that cache % strictly never exceeds 10% under any player movement (100-cell sweep, continuous & boundary).
 * 3. Deep GPU disposal spy verification: geometry.dispose(), material.dispose(), texture.dispose() when chunks leave AoI.
 * 4. Temporal execution order verification: Unload First, Load Second (preventing intermediate memory spikes).
 * 5. ChunkBuilder procedural generation & standalone central pavilion inspection.
 * 6. HUD integration & badge visual states ('ЛИМИТ 10% OK' vs 'ПРЕВЫШЕН ЛИМИТ!').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ChunkStreamer, DEFAULT_CHUNK_CONFIG } from '../src/engine/ChunkStreamer';
import { ChunkBuilder, disposeHierarchy } from '../src/engine/ChunkBuilder';
import { HUD } from '../src/ui/HUD';

describe('Milestone M2: ChunkStreamer & Memory Invariant Test Suite', () => {
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

  // ==========================================================================
  // 1. Spatial Discretization & Area of Interest (AoI) Geometry
  // ==========================================================================
  describe('1. Spatial Coordinate Mapping & Discrete AoI Partitioning', () => {
    it('should accurately map continuous world coordinates to discrete clamped grid indices [0..9]', () => {
      // Origin and low coordinates
      expect(ChunkStreamer.worldToChunkCoords(0, 0)).toEqual({ cx: 0, cz: 0 });
      expect(ChunkStreamer.worldToChunkCoords(19.9, 19.9)).toEqual({ cx: 0, cz: 0 });
      expect(ChunkStreamer.worldToChunkCoords(20.0, 20.0)).toEqual({ cx: 1, cz: 1 });

      // Center of world (100, 100)
      expect(ChunkStreamer.worldToChunkCoords(100.0, 100.0)).toEqual({ cx: 5, cz: 5 });
      expect(ChunkStreamer.worldToChunkCoords(119.99, 119.99)).toEqual({ cx: 5, cz: 5 });

      // World boundary seam (200, 200) clamped to index 9
      expect(ChunkStreamer.worldToChunkCoords(200.0, 200.0)).toEqual({ cx: 9, cz: 9 });

      // Out-of-bounds coordinates clamped safely without NaN or crash
      expect(ChunkStreamer.worldToChunkCoords(-15.0, -100.0)).toEqual({ cx: 0, cz: 0 });
      expect(ChunkStreamer.worldToChunkCoords(250.0, 500.0)).toEqual({ cx: 9, cz: 9 });
    });

    it('should format and parse chunk identifiers consistently as "${cx}_${cz}"', () => {
      expect(ChunkStreamer.getChunkId(5, 5)).toBe('5_5');
      expect(ChunkStreamer.getChunkId(0, 9)).toBe('0_9');
      expect(ChunkStreamer.parseChunkId('5_5')).toEqual({ cx: 5, cz: 5 });
      expect(ChunkStreamer.parseChunkId('0_9')).toEqual({ cx: 0, cz: 9 });
    });

    it('should calculate exactly 4 chunks (4% cache) for all four world corners', () => {
      // 1. Top-Left Corner (0, 0)
      const aoiTopLeft = ChunkStreamer.computeAoI(0, 0);
      expect(aoiTopLeft.size).toBe(4);
      expect(Array.from(aoiTopLeft).sort()).toEqual(['0_0', '0_1', '1_0', '1_1'].sort());

      // 2. Top-Right Corner (9, 0)
      const aoiTopRight = ChunkStreamer.computeAoI(9, 0);
      expect(aoiTopRight.size).toBe(4);
      expect(Array.from(aoiTopRight).sort()).toEqual(['8_0', '8_1', '9_0', '9_1'].sort());

      // 3. Bottom-Left Corner (0, 9)
      const aoiBottomLeft = ChunkStreamer.computeAoI(0, 9);
      expect(aoiBottomLeft.size).toBe(4);
      expect(Array.from(aoiBottomLeft).sort()).toEqual(['0_8', '0_9', '1_8', '1_9'].sort());

      // 4. Bottom-Right Corner (9, 9)
      const aoiBottomRight = ChunkStreamer.computeAoI(9, 9);
      expect(aoiBottomRight.size).toBe(4);
      expect(Array.from(aoiBottomRight).sort()).toEqual(['8_8', '8_9', '9_8', '9_9'].sort());
    });

    it('should calculate exactly 6 chunks (6% cache) for all four perimeter edges', () => {
      // Top Edge (5, 0) -> X in [4..6], Z in [0..1]
      const aoiTopEdge = ChunkStreamer.computeAoI(5, 0);
      expect(aoiTopEdge.size).toBe(6);
      expect(Array.from(aoiTopEdge).sort()).toEqual(
        ['4_0', '5_0', '6_0', '4_1', '5_1', '6_1'].sort()
      );

      // Bottom Edge (5, 9) -> X in [4..6], Z in [8..9]
      const aoiBottomEdge = ChunkStreamer.computeAoI(5, 9);
      expect(aoiBottomEdge.size).toBe(6);
      expect(Array.from(aoiBottomEdge).sort()).toEqual(
        ['4_8', '5_8', '6_8', '4_9', '5_9', '6_9'].sort()
      );

      // Left Edge (0, 5) -> X in [0..1], Z in [4..6]
      const aoiLeftEdge = ChunkStreamer.computeAoI(0, 5);
      expect(aoiLeftEdge.size).toBe(6);
      expect(Array.from(aoiLeftEdge).sort()).toEqual(
        ['0_4', '0_5', '0_6', '1_4', '1_5', '1_6'].sort()
      );

      // Right Edge (9, 5) -> X in [8..9], Z in [4..6]
      const aoiRightEdge = ChunkStreamer.computeAoI(9, 5);
      expect(aoiRightEdge.size).toBe(6);
      expect(Array.from(aoiRightEdge).sort()).toEqual(
        ['8_4', '8_5', '8_6', '9_4', '9_5', '9_6'].sort()
      );
    });

    it('should calculate exactly 9 chunks (9% cache) for center and interior chunks', () => {
      // Plaza Center (5, 5) -> X in [4..6], Z in [4..6]
      const aoiCenter = ChunkStreamer.computeAoI(5, 5);
      expect(aoiCenter.size).toBe(9);
      expect(Array.from(aoiCenter).sort()).toEqual([
        '4_4', '5_4', '6_4',
        '4_5', '5_5', '6_5',
        '4_6', '5_6', '6_6',
      ].sort());

      // Interior point (2, 7)
      const aoiInterior = ChunkStreamer.computeAoI(2, 7);
      expect(aoiInterior.size).toBe(9);
    });
  });

  // ==========================================================================
  // 2. Strict <= 10% Memory Invariant Verification
  // ==========================================================================
  describe('2. Exhaustive Memory Invariant Verification (<= 9% <= 10%)', () => {
    it('should exhaustively verify all 100 cells of the 10x10 world grid strictly satisfy cache% <= 9% <= 10%', () => {
      let cornerCount = 0;
      let edgeCount = 0;
      let centerCount = 0;
      let maxChunksObserved = 0;
      let maxCachePercentObserved = 0;

      for (let cx = 0; cx < 10; cx++) {
        for (let cz = 0; cz < 10; cz++) {
          const aoi = ChunkStreamer.computeAoI(cx, cz);
          const chunkCount = aoi.size;
          const cachePercent = (chunkCount / 100) * 100;

          if (chunkCount > maxChunksObserved) maxChunksObserved = chunkCount;
          if (cachePercent > maxCachePercentObserved) maxCachePercentObserved = cachePercent;

          if (chunkCount === 4) cornerCount++;
          else if (chunkCount === 6) edgeCount++;
          else if (chunkCount === 9) centerCount++;
          else {
            throw new Error(`Unexpected AoI chunk count: ${chunkCount} at (${cx}, ${cz})`);
          }

          // Strict invariant: NEVER exceed 10%
          expect(chunkCount).toBeLessThanOrEqual(9);
          expect(cachePercent).toBeLessThanOrEqual(9.0);
          expect(cachePercent).toBeLessThanOrEqual(10.0);
        }
      }

      // Mathematical partitioning check:
      // 4 corners + 32 edges + 64 centers = 100 grid cells
      expect(cornerCount).toBe(4);
      expect(edgeCount).toBe(32);
      expect(centerCount).toBe(64);
      expect(cornerCount + edgeCount + centerCount).toBe(100);
      expect(maxChunksObserved).toBe(9);
      expect(maxCachePercentObserved).toBe(9.0);
    });

    it('should preserve cache% <= 10% under continuous diagonal player traversal across the entire map', () => {
      // Traverse from (0, 0) to (200, 200) in 400 fine-grained steps (step size 0.5 units)
      for (let step = 0; step <= 400; step++) {
        const x = (step / 400) * 200;
        const z = (step / 400) * 200;

        streamer.update(x, z);

        const loadedCount = streamer.getLoadedChunksCount();
        const cachePercent = streamer.getCachePercentage();

        expect(loadedCount).toBeGreaterThanOrEqual(4);
        expect(loadedCount).toBeLessThanOrEqual(9);
        expect(cachePercent).toBeLessThanOrEqual(9.0);
        expect(cachePercent).toBeLessThanOrEqual(10.0);
      }
    });

    it('should gracefully handle negative, overflow, and extreme teleportation without violating invariant', () => {
      const extremeCoordinates = [
        [-100, -100],
        [300, 450],
        [-9999, 50000],
        [0, 200],
        [200, 0],
        [100, 100],
      ];

      for (const [x, z] of extremeCoordinates) {
        streamer.update(x, z);
        expect(streamer.getLoadedChunksCount()).toBeLessThanOrEqual(9);
        expect(streamer.getCachePercentage()).toBeLessThanOrEqual(10.0);
      }
    });
  });

  // ==========================================================================
  // 3. Set Differential Streaming & Temporal Order
  // ==========================================================================
  describe('3. Set Differential Streaming & "Unload First, Load Second" Temporal Invariant', () => {
    it('should compute exact set differences (toLoad and toUnload) without reloading retained chunks', () => {
      // 1. Initial position at center chunk (5, 5)
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);

      const initialChunkObjects = new Map<string, THREE.Object3D>();
      for (const id of streamer.getLoadedChunkIds()) {
        const chunk = streamer.getChunk(id);
        expect(chunk).toBeDefined();
        initialChunkObjects.set(id, chunk!.group);
      }

      // 2. Step 1 chunk East to (6, 5) (world x: 120, z: 100)
      // Old AoI: X in [4..6], Z in [4..6]
      // New AoI: X in [5..7], Z in [4..6]
      // Unloaded: 4_4, 4_5, 4_6 (3 chunks)
      // Loaded: 7_4, 7_5, 7_6 (3 chunks)
      // Retained: columns 5 and 6 (6 chunks)
      streamer.update(125, 100);

      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(streamer.hasChunk('4_4')).toBe(false);
      expect(streamer.hasChunk('4_5')).toBe(false);
      expect(streamer.hasChunk('4_6')).toBe(false);

      expect(streamer.hasChunk('7_4')).toBe(true);
      expect(streamer.hasChunk('7_5')).toBe(true);
      expect(streamer.hasChunk('7_6')).toBe(true);

      // Verify retained 6 chunks are the exact same Three.js Object3D references (no re-creation)
      for (const id of ['5_4', '5_5', '5_6', '6_4', '6_5', '6_6']) {
        expect(streamer.hasChunk(id)).toBe(true);
        expect(streamer.getChunk(id)!.group).toBe(initialChunkObjects.get(id));
      }
    });

    it('should strictly execute unloads BEFORE loads to eliminate transient intra-tick memory spikes', () => {
      const executionOrder: Array<{ action: 'load' | 'unload'; id: string }> = [];

      const customFactory = (cx: number, cz: number) => {
        const id = ChunkStreamer.getChunkId(cx, cz);
        executionOrder.push({ action: 'load', id });
        const g = new THREE.Group();
        g.name = `custom_${id}`;
        return g;
      };

      const customDisposer = (group: THREE.Object3D) => {
        executionOrder.push({ action: 'unload', id: group.name });
      };

      const customStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        customFactory,
        customDisposer
      );

      // Initial placement at (5, 5) -> 9 loads
      customStreamer.update(100, 100);
      expect(executionOrder.filter((e) => e.action === 'load').length).toBe(9);
      executionOrder.length = 0;

      // Move to (5, 6) -> 3 unloads, 3 loads
      customStreamer.update(100, 125);

      // Find indices of unloads and loads
      const unloads = executionOrder.filter((e) => e.action === 'unload');
      const loads = executionOrder.filter((e) => e.action === 'load');

      expect(unloads.length).toBe(3);
      expect(loads.length).toBe(3);

      // Verify every unload happened before any load
      const lastUnloadIndex = Math.max(...executionOrder.map((e, idx) => (e.action === 'unload' ? idx : -1)));
      const firstLoadIndex = Math.min(...executionOrder.map((e, idx) => (e.action === 'load' ? idx : Infinity)));

      expect(lastUnloadIndex).toBeLessThan(firstLoadIndex);

      customStreamer.dispose();
    });
  });

  // ==========================================================================
  // 4. WebGL Deep GPU Disposal & Zero VRAM Leaks
  // ==========================================================================
  describe('4. Deep GPU Disposal Protocol (Geometries, Materials, Textures)', () => {
    it('should invoke geometry.dispose() and material.dispose() when chunks leave the AoI', () => {
      // 1. Initialize streamer at center (100, 100) -> chunk (5, 5)
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(scene.children.length).toBe(9);

      // 2. Identify chunks in column X = 4 that will be unloaded when moving East
      const chunksToUnloadIds = ['4_4', '4_5', '4_6'];
      const geometriesToDispose: THREE.BufferGeometry[] = [];
      const materialsToDispose: THREE.Material[] = [];

      for (const id of chunksToUnloadIds) {
        const chunk = streamer.getChunk(id);
        expect(chunk).toBeDefined();

        chunk!.group.traverse((child) => {
          if ('geometry' in child && (child as any).geometry) {
            geometriesToDispose.push((child as any).geometry);
          }
          if ('material' in child && (child as any).material) {
            const mats = Array.isArray((child as any).material)
              ? (child as any).material
              : [(child as any).material];
            materialsToDispose.push(...mats);
          }
        });
      }

      expect(geometriesToDispose.length).toBeGreaterThan(0);
      expect(materialsToDispose.length).toBeGreaterThan(0);

      // Attach spies to all geometries and materials of chunks targeted for unloading
      const geoSpies = geometriesToDispose.map((g) => vi.spyOn(g, 'dispose'));
      const matSpies = materialsToDispose.map((m) => vi.spyOn(m, 'dispose'));

      // 3. Move player from (100, 100) to (140, 100) -> chunk (7, 5)
      // AoI shifts from [4..6]x[4..6] to [6..8]x[4..6].
      // Chunks with X = 4 and X = 5 leave AoI.
      streamer.update(140, 100);

      // 4. Verify each targeted geometry and material dispose was executed
      for (const spy of geoSpies) {
        expect(spy).toHaveBeenCalled();
      }
      for (const spy of matSpies) {
        expect(spy).toHaveBeenCalled();
      }

      // 5. Verify unloaded chunks were removed from Three.js scene
      expect(scene.children.length).toBe(9);
      for (const id of chunksToUnloadIds) {
        expect(streamer.hasChunk(id)).toBe(false);
      }
    });

    it('should dispose attached textures and multi-material arrays cleanly via disposeHierarchy', () => {
      const mockTextureDispose = vi.fn();
      const mockMaterialDispose = vi.fn();
      const mockGeometryDispose = vi.fn();

      const complexFactory = (cx: number, cz: number) => {
        const group = new THREE.Group();
        group.name = `chunk_${cx}_${cz}`;

        // Create Mesh with multi-materials and texture map
        const geo = new THREE.BufferGeometry();
        (geo as any).dispose = mockGeometryDispose;

        const fakeTexture = { isTexture: true, dispose: mockTextureDispose };
        const mat1 = { isMaterial: true, map: fakeTexture, dispose: mockMaterialDispose };
        const mat2 = { isMaterial: true, normalMap: fakeTexture, dispose: mockMaterialDispose };

        const mesh = new THREE.Mesh(geo as any, [mat1 as any, mat2 as any]);
        group.add(mesh);
        return group;
      };

      const testStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        complexFactory
      );

      testStreamer.update(100, 100);
      expect(testStreamer.getLoadedChunksCount()).toBe(9);

      // Move to unload previous chunks
      testStreamer.update(160, 100);

      expect(mockGeometryDispose).toHaveBeenCalled();
      expect(mockMaterialDispose).toHaveBeenCalled();
      expect(mockTextureDispose).toHaveBeenCalled();

      testStreamer.dispose();
    });

    it('should safely unlink children and parents in disposeHierarchy', () => {
      const parent = new THREE.Group();
      const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      parent.add(child);
      scene.add(parent);

      expect(scene.children.includes(parent)).toBe(true);
      expect(parent.children.length).toBe(1);

      disposeHierarchy(parent);

      expect(parent.children.length).toBe(0);
      expect(scene.children.includes(parent)).toBe(false);
    });
  });

  // ==========================================================================
  // 5. ChunkBuilder Procedural Generation & Central Pavilion
  // ==========================================================================
  describe('5. ChunkBuilder Procedural Stalls & Lao Wang Landmark Pavilion', () => {
    it('should build procedural stalls and ground plane for generic chunks', () => {
      const chunk = ChunkBuilder.buildChunk(1, 2);
      expect(chunk.name).toBe('chunk_1_2');
      expect(chunk.userData.isLandmark).toBeUndefined();
      expect(chunk.position.x).toBe(20);
      expect(chunk.position.z).toBe(40);

      // Should have ground tile and stalls
      const ground = chunk.getObjectByName('ground_1_2');
      expect(ground).toBeDefined();

      const stallsGroup = chunk.getObjectByName('stalls_group');
      expect(stallsGroup).toBeDefined();
      expect(stallsGroup!.children.length).toBeGreaterThanOrEqual(2);

      disposeHierarchy(chunk);
    });

    it('should keep chunk 5_5 procedural so the central pavilion is not duplicated', () => {
      const chunk = ChunkBuilder.buildChunk(5, 5);
      expect(chunk.name).toBe('chunk_5_5');
      expect(chunk.userData.isLandmark).toBeUndefined();
      expect(chunk.userData.npcId).toBeUndefined();
      expect(chunk.getObjectByName('lao_wang_landmark')).toBeUndefined();
      expect(chunk.getObjectByName('npc_lao_wang')).toBeUndefined();
      expect(chunk.getObjectByName('stalls_group')).toBeDefined();

      disposeHierarchy(chunk);
    });

    it('should build the single Lao Wang landmark pavilion for the central plaza', () => {
      const landmark = ChunkBuilder.buildLaoWangLandmark(undefined, true);
      expect(landmark.name).toBe('lao_wang_landmark');

      // Lao Wang NPC avatar
      const npc = landmark.getObjectByName('npc_lao_wang');
      expect(npc).toBeDefined();
      expect(npc!.userData.npcId).toBe('lao_wang');
      expect(npc!.userData.isNpc).toBe(true);

      // Inspectable antique teapot (Milestone M4)
      const teapot = landmark.getObjectByName('item_teapot');
      expect(teapot).toBeDefined();
      expect(teapot!.userData.itemId).toBe('teapot');
      expect(teapot!.userData.inspectable).toBe(true);

      disposeHierarchy(landmark);
    });
  });

  // ==========================================================================
  // 6. Lifecycle Management & Teardown
  // ==========================================================================
  describe('6. Streamer Lifecycle & Complete Teardown', () => {
    it('should cleanly unload and dispose all active chunks when dispose() is invoked', () => {
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(scene.children.length).toBe(9);

      streamer.dispose();

      expect(streamer.getLoadedChunksCount()).toBe(0);
      expect(streamer.getCachePercentage()).toBe(0);
      expect(streamer.getCurrentCenterChunk()).toBeNull();
      expect(scene.children.length).toBe(0);
    });

    it('should allow clean re-initialization after dispose()', () => {
      streamer.update(100, 100);
      streamer.dispose();
      expect(streamer.getLoadedChunksCount()).toBe(0);

      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);
      expect(streamer.getCachePercentage()).toBe(9.0);
    });
  });

  // ==========================================================================
  // 7. HUD Telemetry Integration & Badge Invariant States
  // ==========================================================================
  describe('7. HUD Telemetry & Visual Badge Invariant Verification', () => {
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

    it('should update HUD every frame and display "ЛИМИТ 10% OK" badge when cache <= 10%', () => {
      const hud = new HUD();

      // Normal compliant frame: 60 FPS, 9% cache, 9 chunks, pos (100.2, 100.4), balance 500
      hud.update(60, 9, 9, 100.2, 100.4, 500);

      expect(hud.getFpsText()).toBe('60');
      expect(hud.getCacheText()).toBe('9%');
      expect(hud.getCacheBadgeText()).toBe('ЛИМИТ 10% OK');
      expect(hud.getCacheBadgeClass()).toContain('badge-ok');
      expect(hud.isLimitOk()).toBe(true);
      expect(hud.getChunksText()).toBe('9 / 100');
      expect(hud.getCoordsText()).toBe('(100.2, 100.4)');
      expect(hud.getBalanceText()).toBe('500 ¥');
    });

    it('should trigger "ПРЕВЫШЕН ЛИМИТ!" red alert badge if cache percentage exceeds 10%', () => {
      const hud = new HUD();

      // Non-compliant adversarial test case: 12% cache
      hud.update(58, 12, 12, 100.0, 100.0);

      expect(hud.getCacheText()).toBe('12%');
      expect(hud.getCacheBadgeText()).toBe('ПРЕВЫШЕН ЛИМИТ!');
      expect(hud.getCacheBadgeClass()).toBe('badge-warn');
      expect(hud.isLimitOk()).toBe(false);
    });

    it('should maintain independent balance state on network BALANCE events', () => {
      const hud = new HUD();

      hud.updateBalance(750);
      expect(hud.getBalanceText()).toBe('750 ¥');

      // Subsequent frame update without balance retains 750 ¥
      hud.update(60, 9, 9, 50, 50);
      expect(hud.getBalanceText()).toBe('750 ¥');
    });
  });
});
