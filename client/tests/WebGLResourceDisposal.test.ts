import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { OtherPlayerManager } from '../src/engine/OtherPlayerManager';

describe('Adversarial Test Suite 3: WebGL Resource Allocation, Churn & Disposal', () => {
  let scene: THREE.Scene;
  let manager: OtherPlayerManager;

  beforeEach(() => {
    scene = new THREE.Scene();
    manager = new OtherPlayerManager(scene, {
      lerpSpeed: 12.0,
      teleportDistanceThreshold: 8.0,
      staleTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('1. High-Density Player Churn & Memory Allocation', () => {
    it('should spawn 100 remote players, allocating 400 meshes and 100 name sprites cleanly', () => {
      for (let i = 1; i <= 100; i++) {
        manager.updatePlayer({
          player_id: i,
          x: 50 + (i % 10) * 5,
          z: 50 + Math.floor(i / 10) * 5,
          rotation: (i * Math.PI) / 50,
        });
      }

      expect(manager.getPlayerCount()).toBe(100);
      expect(scene.children.length).toBe(100);

      let totalMeshes = 0;
      let totalSprites = 0;

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) totalMeshes++;
        if (obj instanceof THREE.Sprite) totalSprites++;
      });

      // Each avatar has: torso (cylinder), trim (torus), head (sphere), visor (box) = 4 meshes
      expect(totalMeshes).toBe(400);
      // Each avatar has 1 overhead name sprite
      expect(totalSprites).toBe(100);
    });

    it('should completely dispose all 400 geometries and 500 materials upon removing all players', () => {
      // 1. Spawn 100 players
      for (let i = 1; i <= 100; i++) {
        manager.updatePlayer({
          player_id: i,
          x: 100,
          z: 100,
          rotation: 0,
        });
      }

      // Collect all geometries and materials across all avatar groups
      const geometriesToDispose: THREE.BufferGeometry[] = [];
      const materialsToDispose: THREE.Material[] = [];

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          if (obj.geometry) geometriesToDispose.push(obj.geometry);
          if (obj.material) materialsToDispose.push(obj.material as THREE.Material);
        } else if (obj instanceof THREE.Sprite) {
          if (obj.material) materialsToDispose.push(obj.material);
        }
      });

      expect(geometriesToDispose.length).toBe(400);
      expect(materialsToDispose.length).toBe(500); // 400 mesh materials + 100 sprite materials

      // Spy on dispose methods
      const geoSpies = geometriesToDispose.map((g) => vi.spyOn(g, 'dispose'));
      const matSpies = materialsToDispose.map((m) => vi.spyOn(m, 'dispose'));

      // 2. Clear all players
      manager.clear();

      expect(manager.getPlayerCount()).toBe(0);
      expect(scene.children.length).toBe(0);

      // Verify every geometry and material had dispose() called exactly once
      for (const spy of geoSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
      for (const spy of matSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
    });

    it('should safely handle removePlayer() for non-existent IDs without error', () => {
      expect(() => {
        manager.removePlayer(999999);
      }).not.toThrow();
    });
  });

  describe('2. In-Browser Canvas Texture Disposal for Name Badges', () => {
    let origDoc: any;

    beforeEach(() => {
      origDoc = globalThis.document;
      // Mock document and canvas to test the browser canvas nameplate rendering path
      globalThis.document = {
        createElement: (tag: string) => {
          if (tag === 'canvas') {
            return {
              width: 256,
              height: 64,
              getContext: () => ({
                fillStyle: '',
                lineWidth: 1,
                strokeStyle: '',
                font: '',
                textAlign: '',
                textBaseline: '',
                fill: vi.fn(),
                stroke: vi.fn(),
                fillText: vi.fn(),
                roundRect: vi.fn(),
                rect: vi.fn(),
              }),
            };
          }
          return {};
        },
      } as any;
    });

    afterEach(() => {
      globalThis.document = origDoc;
    });

    it('should instantiate CanvasTexture and dispose texture map upon avatar removal', () => {
      manager.updatePlayer({
        player_id: 777,
        x: 100,
        z: 100,
        rotation: 0,
      });

      expect(manager.hasPlayer(777)).toBe(true);

      let spriteObj: THREE.Sprite | null = null;
      scene.traverse((obj) => {
        if (obj instanceof THREE.Sprite) {
          spriteObj = obj;
        }
      });

      expect(spriteObj).not.toBeNull();
      expect(spriteObj!.material.map).toBeInstanceOf(THREE.CanvasTexture);

      const textureDisposeSpy = vi.spyOn(spriteObj!.material.map!, 'dispose');
      const materialDisposeSpy = vi.spyOn(spriteObj!.material, 'dispose');

      // Remove player
      manager.removePlayer(777);

      expect(textureDisposeSpy).toHaveBeenCalledTimes(1);
      expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
      expect(scene.children.length).toBe(0);
    });
  });

  describe('3. Stale Remote Player Auto-Pruning', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('should automatically prune and dispose inactive players after staleTimeoutMs', () => {
      let mockTime = 1000;
      const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      // Spawn two players: #1 and #2 at t = 1000
      manager.updatePlayer({ player_id: 1, x: 10, z: 10, rotation: 0 });
      manager.updatePlayer({ player_id: 2, x: 20, z: 20, rotation: 0 });
      expect(manager.getPlayerCount()).toBe(2);

      // Keep Player #1 alive at t = 1600ms
      mockTime = 1600;
      manager.updatePlayer({ player_id: 1, x: 11, z: 10, rotation: 0 });

      // Advance time to t = 2200ms (> 1000ms staleTimeoutMs for Player #2, but not for #1)
      mockTime = 2200;

      // Run update tick
      manager.update(0.05);

      // Player #2 should be automatically pruned and removed from scene
      expect(manager.hasPlayer(2)).toBe(false);
      expect(manager.hasPlayer(1)).toBe(true);
      expect(manager.getPlayerCount()).toBe(1);
      expect(scene.children.length).toBe(1);

      perfSpy.mockRestore();
    });
  });

  describe('4. Teleportation Snapping & Rotation Seam Interpolation', () => {
    it('should snap instantly when displacement exceeds teleportDistanceThreshold (8m)', () => {
      manager.updatePlayer({ player_id: 5, x: 10, z: 10, rotation: 0 });

      const avatarGroup = scene.children[0] as THREE.Group;
      expect(avatarGroup.position.x).toBe(10);
      expect(avatarGroup.position.z).toBe(10);

      // Displacement = 50m (teleport)
      manager.updatePlayer({ player_id: 5, x: 60, z: 10, rotation: Math.PI });

      // Must snap immediately without waiting for update() lerp
      expect(avatarGroup.position.x).toBe(60);
      expect(avatarGroup.position.z).toBe(10);
      expect(avatarGroup.rotation.y).toBe(Math.PI);
    });

    it('should smoothly interpolate rotation across -PI / +PI seam along the shortest angular arc', () => {
      // Current rotation: +3.10 radians (~177.6 deg)
      manager.updatePlayer({ player_id: 8, x: 50, z: 50, rotation: 3.10 });

      // Target rotation: -3.10 radians (~-177.6 deg).
      // Direct diff: -3.10 - 3.10 = -6.20 radians (~-355 deg).
      // Shortest wrapped path is: +0.083 radians (~+4.7 deg) through +PI / -PI boundary!
      manager.updatePlayer({ player_id: 8, x: 50, z: 50, rotation: -3.10 });

      // Advance simulation step (lerpFactor = 0.05 * 12 = 0.6)
      manager.update(0.05);

      const avatarGroup = scene.children[0] as THREE.Group;

      // Because shortest path goes positive through +PI:
      // The interpolated rotation should increase above 3.10 towards PI (3.14159...)
      expect(avatarGroup.rotation.y).toBeGreaterThan(3.10);
    });
  });

  describe('5. Scene Disposal Audit: GridHelper LineSegments Finding', () => {
    it('empirically reveals that standard scene.traverse with obj instanceof THREE.Mesh misses LineSegments (GridHelper)', () => {
      const testScene = new THREE.Scene();

      // 1. Mesh (representing floor)
      const meshGeo = new THREE.PlaneGeometry(10, 10);
      const meshMat = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(meshGeo, meshMat);
      testScene.add(mesh);

      // 2. GridHelper (LineSegments)
      const gridHelper = new THREE.GridHelper(100, 10);
      testScene.add(gridHelper);

      const meshGeoDisposeSpy = vi.spyOn(meshGeo, 'dispose');
      const meshMatDisposeSpy = vi.spyOn(meshMat, 'dispose');
      const gridGeoDisposeSpy = vi.spyOn(gridHelper.geometry, 'dispose');
      const gridMatDisposeSpy = vi.spyOn(gridHelper.material as THREE.Material, 'dispose');

      // Execute exact World.ts disposal logic:
      testScene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else if (obj.material) {
            obj.material.dispose();
          }
        }
      });

      // Verification:
      // The Mesh was disposed:
      expect(meshGeoDisposeSpy).toHaveBeenCalledTimes(1);
      expect(meshMatDisposeSpy).toHaveBeenCalledTimes(1);

      // BUT GridHelper (LineSegments) was MISSED by World.ts disposal logic!
      expect(gridGeoDisposeSpy).not.toHaveBeenCalled();
      expect(gridMatDisposeSpy).not.toHaveBeenCalled();
    });
  });
});
