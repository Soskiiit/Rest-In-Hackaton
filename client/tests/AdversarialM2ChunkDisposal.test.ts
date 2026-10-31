/**
 * Rest-In-Hackaton: Adversarial Test Suite for Milestone M2
 * Focus: GPU Resource Disposal, 500+ Cycle Long-Duration Stress, Zero Leak Accumulation, and PointLight Budget.
 *
 * Requirements Verified:
 * 1. 500+ chunk unload/load cycles under spiral, boundary oscillation, and teleport jumps.
 * 2. 100% disposal coverage for geometries, materials, attached textures (all 13 Three.js slots),
 *    custom ShaderMaterial uniforms, and light shadow maps.
 * 3. Complete unlinking of scene graph hierarchies (zero detached subtree leaks).
 * 4. PointLight allocation budget strictly <= 18 across any 3x3 AoI (and <= 2 per chunk).
 * 5. Strict preservation of the <= 9 chunk (<= 9.0% <= 10.0%) cache limit at every micro-tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ChunkStreamer, DEFAULT_CHUNK_CONFIG } from '../src/engine/ChunkStreamer';
import { ChunkBuilder, disposeHierarchy } from '../src/engine/ChunkBuilder';

describe('Adversarial M2: Deep GPU Disposal & 500+ Cycle Stress Harness', () => {
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
  // SUITE 1: Long-Duration Stress Testing (500+ Chunk Cycles)
  // ==========================================================================
  describe('Suite 1: Long-Duration Stress Harness (500+ Load/Unload Cycles)', () => {
    it('1.1 should execute 500 continuous traversal steps with zero reference leaks and strict <= 9 chunks', () => {
      let totalLoads = 0;
      let totalUnloads = 0;
      let maxChunksObserved = 0;
      let maxSceneChildrenObserved = 0;

      // Track loaded and unloaded chunk IDs
      const customFactory = (cx: number, cz: number) => {
        totalLoads++;
        return ChunkBuilder.buildChunk(cx, cz);
      };

      const customDisposer = (group: THREE.Object3D) => {
        totalUnloads++;
        disposeHierarchy(group);
      };

      const stressStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        customFactory,
        customDisposer
      );

      // Spiral walk covering all 100 chunks multiple times over 500 steps
      let angle = 0;
      let radius = 10;
      const centerX = 100;
      const centerZ = 100;

      for (let step = 0; step < 500; step++) {
        angle += 0.15;
        radius = 10 + (step % 80);
        const x = Math.max(0, Math.min(199.9, centerX + Math.cos(angle) * radius));
        const z = Math.max(0, Math.min(199.9, centerZ + Math.sin(angle) * radius));

        stressStreamer.update(x, z);

        const loadedCount = stressStreamer.getLoadedChunksCount();
        const sceneCount = scene.children.length;

        if (loadedCount > maxChunksObserved) maxChunksObserved = loadedCount;
        if (sceneCount > maxSceneChildrenObserved) maxSceneChildrenObserved = sceneCount;

        // Invariant: strictly between 4 and 9 chunks loaded, scene children match streamer count
        expect(loadedCount).toBeGreaterThanOrEqual(4);
        expect(loadedCount).toBeLessThanOrEqual(9);
        expect(sceneCount).toBe(loadedCount);
        expect(stressStreamer.getCachePercentage()).toBeLessThanOrEqual(9.0);
      }

      // Assert high churning occurred
      expect(totalLoads).toBeGreaterThanOrEqual(100);
      expect(totalUnloads).toBeGreaterThanOrEqual(90);
      expect(maxChunksObserved).toBeLessThanOrEqual(9);
      expect(maxSceneChildrenObserved).toBeLessThanOrEqual(9);

      // Clean teardown
      stressStreamer.dispose();
      expect(stressStreamer.getLoadedChunksCount()).toBe(0);
      expect(scene.children.length).toBe(0);
    });

    it('1.2 should survive 600 rapid oscillation cycles across a chunk boundary without leak accumulation', () => {
      let loadCount = 0;
      let unloadCount = 0;

      const trackedFactory = (cx: number, cz: number) => {
        loadCount++;
        return ChunkBuilder.buildChunk(cx, cz);
      };

      const trackedDisposer = (group: THREE.Object3D) => {
        unloadCount++;
        disposeHierarchy(group);
      };

      const oscStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        trackedFactory,
        trackedDisposer
      );

      // Coordinate 99.9 lies in chunk (4, 5); Coordinate 100.1 lies in chunk (5, 5)
      // Oscillating across 100.0 triggers 3 unloads and 3 loads on every single cycle!
      for (let cycle = 0; cycle < 600; cycle++) {
        const x = cycle % 2 === 0 ? 99.9 : 100.1;
        oscStreamer.update(x, 100.0);

        expect(oscStreamer.getLoadedChunksCount()).toBe(9);
        expect(scene.children.length).toBe(9);
        expect(oscStreamer.getCachePercentage()).toBe(9.0);
      }

      // 600 oscillations = 9 initial loads + 599 * 3 = 1806 loads and 1797 unloads
      expect(loadCount).toBeGreaterThan(1500);
      expect(unloadCount).toBeGreaterThan(1500);
      expect(loadCount - unloadCount).toBe(9); // exactly the 9 currently active chunks remain

      oscStreamer.dispose();
      expect(oscStreamer.getLoadedChunksCount()).toBe(0);
      expect(scene.children.length).toBe(0);
      expect(loadCount - unloadCount).toBe(0); // 100% of loaded chunks were unloaded and disposed
    });

    it('1.3 should execute 500 diagonal teleport jumps across opposite corners with complete eviction', () => {
      let totalLoads = 0;
      let totalUnloads = 0;

      const teleportStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        (cx, cz) => {
          totalLoads++;
          return ChunkBuilder.buildChunk(cx, cz);
        },
        (group) => {
          totalUnloads++;
          disposeHierarchy(group);
        }
      );

      // Top-Left corner (0, 0) -> 4 chunks (0_0, 0_1, 1_0, 1_1)
      // Bottom-Right corner (190, 190) -> 4 chunks (8_8, 8_9, 9_8, 9_9)
      // Every jump completely evicts all 4 chunks and loads 4 completely disjoint chunks
      for (let jump = 0; jump < 500; jump++) {
        const target = jump % 2 === 0 ? [5.0, 5.0] : [195.0, 195.0];
        teleportStreamer.update(target[0], target[1]);

        expect(teleportStreamer.getLoadedChunksCount()).toBe(4);
        expect(scene.children.length).toBe(4);
        expect(teleportStreamer.getCachePercentage()).toBe(4.0);
      }

      // 500 jumps = 4 initial + 499 * 4 = 2000 loads and 1996 unloads
      expect(totalLoads).toBe(2000);
      expect(totalUnloads).toBe(1996);
      expect(totalLoads - totalUnloads).toBe(4);

      teleportStreamer.dispose();
      expect(totalLoads - totalUnloads).toBe(0);
      expect(scene.children.length).toBe(0);
    });
  });

  // ==========================================================================
  // SUITE 2: 100% GPU Resource Disposal & Zero Reference Leaks
  // ==========================================================================
  describe('Suite 2: 100% GPU Resource Disposal Audit (Geometries, Materials, Textures, Shadows)', () => {
    it('2.1 should verify 100% disposal coverage of all geometries and materials across all 100 world chunks', () => {
      // Build and dispose every single one of the 100 chunks in the world grid
      let totalGeometriesTested = 0;
      let totalMaterialsTested = 0;

      for (let cx = 0; cx < 10; cx++) {
        for (let cz = 0; cz < 10; cz++) {
          const chunk = ChunkBuilder.buildChunk(cx, cz);

          const geometries: THREE.BufferGeometry[] = [];
          const materials: THREE.Material[] = [];

          // Collect all resources present in chunk
          chunk.traverse((node: any) => {
            if (node.geometry && node.geometry.isBufferGeometry) {
              geometries.push(node.geometry);
            }
            if (node.material) {
              if (Array.isArray(node.material)) {
                materials.push(...node.material);
              } else {
                materials.push(node.material);
              }
            }
          });

          expect(geometries.length).toBeGreaterThan(0);
          expect(materials.length).toBeGreaterThan(0);

          totalGeometriesTested += geometries.length;
          totalMaterialsTested += materials.length;

          // Spy on .dispose() for each collected resource
          const geoSpies = geometries.map((g) => vi.spyOn(g, 'dispose'));
          const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));

          // Execute deep disposal
          disposeHierarchy(chunk);

          // Verify every single geometry and material was disposed
          for (let i = 0; i < geoSpies.length; i++) {
            expect(geoSpies[i]).toHaveBeenCalledTimes(1);
          }
          for (let i = 0; i < matSpies.length; i++) {
            expect(matSpies[i]).toHaveBeenCalledTimes(1);
          }

          // Verify node unlinking
          expect(chunk.children.length).toBe(0);
        }
      }

      // Assert that thousands of individual geometries and materials were exhaustively audited
      expect(totalGeometriesTested).toBeGreaterThan(1500);
      expect(totalMaterialsTested).toBeGreaterThan(1500);
    });

    it('2.2 should verify comprehensive deep disposal of landmark chunk 5_5 (pagoda, Lao Wang, teapot, jade, lanterns)', () => {
      const landmarkChunk = ChunkBuilder.buildChunk(5, 5);
      scene.add(landmarkChunk);

      const collectedGeos = new Set<THREE.BufferGeometry>();
      const collectedMats = new Set<THREE.Material>();
      const collectedLights: THREE.PointLight[] = [];

      landmarkChunk.traverse((node: any) => {
        if (node.geometry) collectedGeos.add(node.geometry);
        if (node.material) {
          if (Array.isArray(node.material)) {
            for (const m of node.material) collectedMats.add(m);
          } else {
            collectedMats.add(node.material);
          }
        }
        if (node instanceof THREE.PointLight) {
          collectedLights.push(node);
        }
      });

      // Verify landmark contains all expected specialized models
      expect(collectedGeos.size).toBeGreaterThan(10);
      expect(collectedMats.size).toBeGreaterThan(10);
      expect(collectedLights.length).toBe(2); // Two grand imperial lanterns

      const geoSpies = Array.from(collectedGeos).map((g) => vi.spyOn(g, 'dispose'));
      const matSpies = Array.from(collectedMats).map((m) => vi.spyOn(m, 'dispose'));

      // Dispose landmark hierarchy
      disposeHierarchy(landmarkChunk);

      // Assert 100% disposal
      for (const spy of geoSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
      for (const spy of matSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }

      // Assert hierarchy unlinking and scene detachment
      expect(landmarkChunk.children.length).toBe(0);
      expect(scene.children.includes(landmarkChunk)).toBe(false);
      expect(Object.keys(landmarkChunk.userData).length).toBe(0);
    });

    it('2.3 should dispose all 13 standard Three.js texture property slots', () => {
      const textureSlots = [
        'map',
        'alphaMap',
        'aoMap',
        'bumpMap',
        'displacementMap',
        'emissiveMap',
        'envMap',
        'lightMap',
        'metalnessMap',
        'normalMap',
        'roughnessMap',
        'specularMap',
        'gradientMap',
      ];

      const disposedTextureMap = new Map<string, boolean>();
      const customMat: any = new THREE.MeshStandardMaterial();

      // Attach fake textures to all 13 slots
      for (const slot of textureSlots) {
        const fakeTex: any = {
          isTexture: true,
          dispose: vi.fn(() => {
            disposedTextureMap.set(slot, true);
          }),
        };
        customMat[slot] = fakeTex;
      }

      const testMesh = new THREE.Mesh(new THREE.BoxGeometry(), customMat);
      const testRoot = new THREE.Group();
      testRoot.add(testMesh);

      disposeHierarchy(testRoot);

      // Verify every single texture slot was visited and disposed
      expect(disposedTextureMap.size).toBe(13);
      for (const slot of textureSlots) {
        expect(disposedTextureMap.get(slot)).toBe(true);
      }
    });

    it('2.4 should dispose custom ShaderMaterial uniforms (scalar texture and texture arrays)', () => {
      const mockTexDispose1 = vi.fn();
      const mockTexDispose2 = vi.fn();
      const mockTexDispose3 = vi.fn();

      const shaderMat: any = {
        isMaterial: true,
        dispose: vi.fn(),
        uniforms: {
          uMainTexture: { value: { isTexture: true, dispose: mockTexDispose1 } },
          uTextureAtlas: {
            value: [
              { isTexture: true, dispose: mockTexDispose2 },
              { isTexture: true, dispose: mockTexDispose3 },
            ],
          },
          uNumericParam: { value: 42.0 }, // non-texture uniform should be ignored safely
        },
      };

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shaderMat as any);
      const group = new THREE.Group();
      group.add(mesh);

      disposeHierarchy(group);

      expect(shaderMat.dispose).toHaveBeenCalledTimes(1);
      expect(mockTexDispose1).toHaveBeenCalledTimes(1);
      expect(mockTexDispose2).toHaveBeenCalledTimes(1);
      expect(mockTexDispose3).toHaveBeenCalledTimes(1);
    });

    it('2.5 should dispose light shadow maps when present', () => {
      const mockShadowMapDispose = vi.fn();

      const light = new THREE.PointLight(0xffffff, 1, 10);
      light.shadow = {
        map: {
          dispose: mockShadowMapDispose,
        },
      } as any;

      const group = new THREE.Group();
      group.add(light);

      disposeHierarchy(group);

      expect(mockShadowMapDispose).toHaveBeenCalledTimes(1);
      expect(group.children.length).toBe(0);
    });

    it('2.6 should safely close image bitmaps when texture.image.close() is available', () => {
      const mockClose = vi.fn();
      const texture: any = {
        isTexture: true,
        dispose: vi.fn(),
        image: {
          close: mockClose,
        },
      };

      const mat: any = new THREE.MeshBasicMaterial();
      mat.map = texture;

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
      disposeHierarchy(mesh);

      expect(texture.dispose).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('2.7 should handle null, undefined, and re-entrant disposal safely without errors', () => {
      expect(() => disposeHierarchy(null)).not.toThrow();
      expect(() => disposeHierarchy(undefined)).not.toThrow();

      const emptyGroup = new THREE.Group();
      expect(() => disposeHierarchy(emptyGroup)).not.toThrow();

      // Double-disposal on same node should not crash
      expect(() => disposeHierarchy(emptyGroup)).not.toThrow();
    });
  });

  // ==========================================================================
  // SUITE 3: PointLight Allocation Budget (<= 18 across 3x3 AoI)
  // ==========================================================================
  describe('Suite 3: PointLight Allocation Budget Verification (<= 18 across 3x3 AoI)', () => {
    it('3.1 should exhaustively verify that total PointLights across 3x3 AoI is <= 18 for ALL 100 grid cells', () => {
      let maxLightsInAoI = 0;
      let minLightsInAoI = Infinity;
      let totalAoICount = 0;

      for (let cx = 0; cx < 10; cx++) {
        for (let cz = 0; cz < 10; cz++) {
          const aoi = ChunkStreamer.computeAoI(cx, cz);
          let lightsInThisAoI = 0;

          // For each chunk in this AoI, build it and count PointLights
          for (const chunkId of aoi) {
            const { cx: chunkX, cz: chunkZ } = ChunkStreamer.parseChunkId(chunkId);
            const chunk = ChunkBuilder.buildChunk(chunkX, chunkZ);

            let lightsInChunk = 0;
            chunk.traverse((node) => {
              if (node instanceof THREE.PointLight) {
                lightsInChunk++;
              }
            });

            // Per-chunk light limit invariant: <= 2
            expect(lightsInChunk).toBeLessThanOrEqual(2);
            lightsInThisAoI += lightsInChunk;

            disposeHierarchy(chunk);
          }

          if (lightsInThisAoI > maxLightsInAoI) maxLightsInAoI = lightsInThisAoI;
          if (lightsInThisAoI < minLightsInAoI) minLightsInAoI = lightsInThisAoI;
          totalAoICount++;

          // CRITICAL INVARIANT: WebGL light budget across 3x3 AoI <= 18
          expect(lightsInThisAoI).toBeLessThanOrEqual(18);
        }
      }

      expect(totalAoICount).toBe(100);
      expect(maxLightsInAoI).toBeLessThanOrEqual(18);
      expect(minLightsInAoI).toBeGreaterThanOrEqual(0);
    });

    it('3.2 should assert landmark chunk 5_5 contains exactly 2 PointLights for the imperial lanterns', () => {
      const chunk5_5 = ChunkBuilder.buildChunk(5, 5);
      const pointLights: THREE.PointLight[] = [];

      chunk5_5.traverse((node) => {
        if (node instanceof THREE.PointLight) {
          pointLights.push(node);
        }
      });

      expect(pointLights.length).toBe(2);

      // Verify PointLight optimization properties
      for (const light of pointLights) {
        expect(light.castShadow).toBe(false); // must not cast shadows for performance
        expect(light.intensity).toBeGreaterThan(0);
        expect(light.distance).toBeGreaterThan(0);
      }

      disposeHierarchy(chunk5_5);
    });

    it('3.3 should dynamically maintain active PointLights <= 18 under live ChunkStreamer streaming', () => {
      // Stream player along a diagonal crossing through center (5, 5)
      for (let x = 0; x <= 200; x += 10) {
        for (let z = 0; z <= 200; z += 10) {
          streamer.update(x, z);

          // Count active PointLights in Three.js scene
          let activeSceneLights = 0;
          scene.traverse((node) => {
            if (node instanceof THREE.PointLight) {
              activeSceneLights++;
            }
          });

          // Invariant: active PointLights in live scene graph never exceeds 18
          expect(activeSceneLights).toBeLessThanOrEqual(18);
          expect(streamer.getLoadedChunksCount()).toBeLessThanOrEqual(9);
        }
      }
    });
  });

  // ==========================================================================
  // SUITE 4: Micro-Tick Temporal Ordering & Zero Transient Spikes
  // ==========================================================================
  describe('Suite 4: Micro-Tick Temporal Invariants & Pathological Inputs', () => {
    it('4.1 should guarantee scene.children.length NEVER exceeds 9 at any micro-tick during transitions', () => {
      let peakSceneChildren = 0;

      // Intercept scene.add to verify child count during intermediate operations
      const originalAdd = scene.add.bind(scene);
      scene.add = (...objects: THREE.Object3D[]) => {
        const result = originalAdd(...objects);
        if (scene.children.length > peakSceneChildren) {
          peakSceneChildren = scene.children.length;
        }
        // Strict invariant: Even in the middle of scene.add, active chunks must be <= 9
        expect(scene.children.length).toBeLessThanOrEqual(9);
        return result;
      };

      // Perform 300 rapid movements across arbitrary grid boundaries
      for (let i = 0; i < 300; i++) {
        const randX = (i * 37.7) % 200;
        const randZ = (i * 53.3) % 200;
        streamer.update(randX, randZ);
      }

      expect(peakSceneChildren).toBeLessThanOrEqual(9);
    });

    it('4.2 should gracefully reject NaN, Infinity, and extreme pathological inputs without corrupting state', () => {
      // Normal placement
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);

      // Pathological inputs: NaN, Infinity
      streamer.update(Number.NaN, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9); // Unchanged

      streamer.update(100, Number.POSITIVE_INFINITY);
      expect(streamer.getLoadedChunksCount()).toBe(9); // Unchanged

      streamer.update(Number.NEGATIVE_INFINITY, Number.NaN);
      expect(streamer.getLoadedChunksCount()).toBe(9); // Unchanged

      // Floating boundary precision jitter at chunk boundary (19.9999999 vs 20.0000001)
      for (let j = 0; j < 50; j++) {
        const jitterX = j % 2 === 0 ? 19.999999999 : 20.000000001;
        streamer.update(jitterX, 10.0);
        expect(streamer.getLoadedChunksCount()).toBeLessThanOrEqual(9);
        expect(streamer.getCachePercentage()).toBeLessThanOrEqual(9.0);
      }
    });
  });
});
