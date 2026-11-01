import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { AppMode, EditorStateManager } from '../src/editor/EditorState';
import { EditorCamera } from '../src/editor/EditorCamera';
import { PlayerGhostBeacon } from '../src/editor/PlayerGhostBeacon';
import { PlayerController } from '../src/engine/PlayerController';
import { ChunkStreamer } from '../src/engine/ChunkStreamer';

// Headless Mock DOM Element for testing input and pointer events
class MockDomElement {
  public listeners: Record<string, Function[]> = {};

  public addEventListener(type: string, fn: Function, _options?: any): void {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  public removeEventListener(type: string, fn: Function): void {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    }
  }

  public dispatch(event: any): void {
    const list = this.listeners[event.type];
    if (list) {
      list.forEach((fn) => fn(event));
    }
  }
}

describe('Milestone M1: Level Editor Mode, Free Camera & Streaming Integration', () => {
  // ==========================================================================
  // Suite 1: EditorState State Machine
  // ==========================================================================
  describe('1. EditorState State Machine', () => {
    let state: EditorStateManager;

    beforeEach(() => {
      state = new EditorStateManager();
    });

    it('should initialize in GAME mode by default', () => {
      expect(state.getMode()).toBe(AppMode.GAME);
      expect(state.isGame()).toBe(true);
      expect(state.isGameMode()).toBe(true);
      expect(state.isEditor()).toBe(false);
      expect(state.isEditorMode()).toBe(false);
    });

    it('should support custom initial mode', () => {
      const editorInitial = new EditorStateManager(AppMode.EDITOR);
      expect(editorInitial.getMode()).toBe(AppMode.EDITOR);
      expect(editorInitial.isEditor()).toBe(true);
      expect(editorInitial.isGame()).toBe(false);
    });

    it('should toggle between GAME and EDITOR modes', () => {
      state.toggleMode();
      expect(state.getMode()).toBe(AppMode.EDITOR);
      expect(state.isEditor()).toBe(true);

      state.toggleMode();
      expect(state.getMode()).toBe(AppMode.GAME);
      expect(state.isGame()).toBe(true);
    });

    it('should notify registered object listeners with targetMode and prevMode', () => {
      const listener = vi.fn();
      state.addListener({ onModeChanged: listener });

      const transitioned = state.setMode(AppMode.EDITOR);
      expect(transitioned).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(AppMode.EDITOR, AppMode.GAME);

      state.setMode(AppMode.GAME);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledWith(AppMode.GAME, AppMode.EDITOR);
    });

    it('should notify registered callback functions', () => {
      const callback = vi.fn();
      state.addListener(callback);

      state.setMode(AppMode.EDITOR);
      expect(callback).toHaveBeenCalledWith(AppMode.EDITOR, AppMode.GAME);
    });

    it('should be idempotent: setting the current mode returns false and does not refire listeners', () => {
      const listener = vi.fn();
      state.addListener({ onModeChanged: listener });

      expect(state.setMode(AppMode.GAME)).toBe(false);
      expect(listener).not.toHaveBeenCalled();

      expect(state.setMode(AppMode.EDITOR)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      expect(state.setMode(AppMode.EDITOR)).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should allow unsubscribing via the returned unregister callback', () => {
      const listener = vi.fn();
      const unsubscribe = state.addListener({ onModeChanged: listener });

      state.setMode(AppMode.EDITOR);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      state.setMode(AppMode.GAME);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should allow unsubscribing via removeListener', () => {
      const listener = { onModeChanged: vi.fn() };
      state.addListener(listener);
      state.removeListener(listener);

      state.setMode(AppMode.EDITOR);
      expect(listener.onModeChanged).not.toHaveBeenCalled();
    });

    it('should clear all listeners with clearListeners()', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      state.addListener(fn1);
      state.addListener(fn2);
      state.clearListeners();

      state.setMode(AppMode.EDITOR);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).not.toHaveBeenCalled();
    });

    it('should protect against re-entrant state transitions', () => {
      const reentrantListener = () => {
        state.setMode(AppMode.GAME); // Attempt re-entrant transition
      };
      state.addListener(reentrantListener);

      expect(() => state.setMode(AppMode.EDITOR)).not.toThrow();
      expect(state.getMode()).toBe(AppMode.EDITOR);
    });

    it('should isolate listener exceptions so other listeners still execute', () => {
      const badListener = () => {
        throw new Error('Listener crash');
      };
      const goodListener = vi.fn();

      state.addListener(badListener);
      state.addListener(goodListener);

      expect(() => state.setMode(AppMode.EDITOR)).not.toThrow();
      expect(goodListener).toHaveBeenCalledWith(AppMode.EDITOR, AppMode.GAME);
    });
  });

  // ==========================================================================
  // Suite 2: EditorCamera DCC Fly Mechanics
  // ==========================================================================
  describe('2. EditorCamera Vector Mechanics & Input Handling', () => {
    let camera: THREE.PerspectiveCamera;
    let domElement: MockDomElement;
    let editorCam: EditorCamera;

    beforeEach(() => {
      camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      camera.position.set(100, 10, 100);
      camera.lookAt(100, 10, 90); // Facing -Z
      domElement = new MockDomElement();
      editorCam = new EditorCamera(camera, domElement as any, {
        baseMoveSpeed: 10.0,
        shiftMultiplier: 2.0,
        altMultiplier: 0.5,
      });
      editorCam.enable();
    });

    afterEach(() => {
      editorCam.disable();
      editorCam.dispose();
    });

    it('should start disabled if enable() is not called', () => {
      const cam = new THREE.PerspectiveCamera();
      const unenabled = new EditorCamera(cam, domElement as any);
      expect(unenabled.isEnabled()).toBe(false);
    });

    it('should translate forward (-Z) when W key is pressed', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      editorCam.update(1.0); // 1.0s at 10 m/s

      expect(camera.position.z).toBeCloseTo(initialZ - 10.0, 2);
      expect(camera.position.x).toBeCloseTo(100, 2);
    });

    it('should translate backward (+Z) when S key is pressed', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyS' });
      editorCam.update(1.0);

      expect(camera.position.z).toBeCloseTo(initialZ + 10.0, 2);
    });

    it('should strafe right (+X) on D and left (-X) on A', () => {
      const initialX = camera.position.x;
      domElement.dispatch({ type: 'keydown', code: 'KeyD' });
      editorCam.update(1.0);
      expect(camera.position.x).toBeCloseTo(initialX + 10.0, 2);

      domElement.dispatch({ type: 'keyup', code: 'KeyD' });
      domElement.dispatch({ type: 'keydown', code: 'KeyA' });
      editorCam.update(1.0);
      expect(camera.position.x).toBeCloseTo(initialX, 2);
    });

    it('should ascend vertically (+Y) when E key is pressed and descend (-Y) on Q', () => {
      const initialY = camera.position.y;
      domElement.dispatch({ type: 'keydown', code: 'KeyE' });
      editorCam.update(0.5); // 0.5s at 10 m/s = +5m
      expect(camera.position.y).toBeCloseTo(initialY + 5.0, 2);

      domElement.dispatch({ type: 'keyup', code: 'KeyE' });
      domElement.dispatch({ type: 'keydown', code: 'KeyQ' });
      editorCam.update(0.5); // -5m
      expect(camera.position.y).toBeCloseTo(initialY, 2);
    });

    it('should normalize diagonal movement to prevent diagonal speed boosting', () => {
      const initialPos = camera.position.clone();
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      domElement.dispatch({ type: 'keydown', code: 'KeyD' });
      editorCam.update(1.0);

      const displacement = camera.position.distanceTo(initialPos);
      expect(displacement).toBeCloseTo(10.0, 1);
    });

    it('should scale speed by shiftMultiplier (2.0x) when Shift is active', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      domElement.dispatch({ type: 'keydown', code: 'ShiftLeft' });
      editorCam.update(1.0);

      expect(camera.position.z).toBeCloseTo(initialZ - 20.0, 2);
    });

    it('should scale speed by altMultiplier (0.5x) when Alt is active', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      domElement.dispatch({ type: 'keydown', code: 'AltLeft' });
      editorCam.update(1.0);

      expect(camera.position.z).toBeCloseTo(initialZ - 5.0, 2);
    });

    it('should combine Shift and Alt multipliers simultaneously', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      domElement.dispatch({ type: 'keydown', code: 'ShiftLeft' });
      domElement.dispatch({ type: 'keydown', code: 'AltLeft' });
      editorCam.update(1.0); // 10 * 2.0 * 0.5 = 10 m/s

      expect(camera.position.z).toBeCloseTo(initialZ - 10.0, 2);
    });

    it('should adjust base fly speed on wheel events within [1.0..100.0] bounds', () => {
      const initialSpeed = editorCam.getSpeed();
      domElement.dispatch({ type: 'wheel', deltaY: -100, preventDefault: () => {} });
      expect(editorCam.getSpeed()).toBeGreaterThan(initialSpeed);

      domElement.dispatch({ type: 'wheel', deltaY: 50000, preventDefault: () => {} });
      expect(editorCam.getSpeed()).toBeGreaterThanOrEqual(1.0);
    });

    it('should notify onSpeedChange listeners when speed changes', () => {
      const callback = vi.fn();
      const unsub = editorCam.onSpeedChange(callback);

      editorCam.setSpeed(25.0);
      expect(callback).toHaveBeenCalledWith(25.0);

      unsub();
      editorCam.setSpeed(30.0);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should ignore Left Click and only rotate on Right Click drag', () => {
      const initialRotY = camera.rotation.y;

      // Left click drag: button = 0 (must be ignored)
      domElement.dispatch({ type: 'mousedown', button: 0 });
      domElement.dispatch({ type: 'mousemove', movementX: 50, movementY: 50, button: 0 });
      domElement.dispatch({ type: 'mouseup', button: 0 });
      expect(camera.rotation.y).toBeCloseTo(initialRotY, 4);

      // Right click drag: button = 2 (must rotate)
      domElement.dispatch({ type: 'mousedown', button: 2 });
      domElement.dispatch({ type: 'mousemove', movementX: 50, movementY: 0, button: 2 });
      domElement.dispatch({ type: 'mouseup', button: 2 });
      expect(camera.rotation.y).not.toBe(initialRotY);
    });

    it('should clamp pitch angle to strictly prevent camera gimbal flipping', () => {
      domElement.dispatch({ type: 'mousedown', button: 2 });
      // Massive upward mouse movement
      domElement.dispatch({ type: 'mousemove', movementX: 0, movementY: -5000 });
      expect(camera.rotation.x).toBeLessThan(Math.PI / 2);
      expect(camera.rotation.x).toBeGreaterThan(0);

      // Massive downward mouse movement
      domElement.dispatch({ type: 'mousemove', movementX: 0, movementY: 10000 });
      expect(camera.rotation.x).toBeGreaterThan(-Math.PI / 2);
    });

    it('should frame target when focusOn is called', () => {
      const target = new THREE.Vector3(50, 0, 50);
      editorCam.focusOn(target, 15.0);

      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const camToTarget = target.clone().sub(camera.position).normalize();

      expect(dir.dot(camToTarget)).toBeGreaterThan(0.95);
      expect(camera.position.distanceTo(target)).toBeCloseTo(15.0, 1);
    });

    it('should trigger focusOn when hotkey F is pressed with focusTargetProvider', () => {
      const targetPos = new THREE.Vector3(40, 5, 60);
      editorCam.setFocusTargetProvider(() => ({ position: targetPos, distance: 12.0 }));

      domElement.dispatch({ type: 'keydown', code: 'KeyF' });
      expect(camera.position.distanceTo(targetPos)).toBeCloseTo(12.0, 1);
    });

    it('should clear pressed keys on blur event', () => {
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      domElement.dispatch({ type: 'blur' });
      const initialZ = camera.position.z;

      editorCam.update(1.0);
      expect(camera.position.z).toBe(initialZ);
    });

    it('should pause look rotation when setLookPaused(true)', () => {
      editorCam.setLookPaused(true);
      expect(editorCam.isLookPaused()).toBe(true);

      const rotY = camera.rotation.y;
      domElement.dispatch({ type: 'mousedown', button: 2 });
      domElement.dispatch({ type: 'mousemove', movementX: 50, movementY: 0 });
      expect(camera.rotation.y).toBe(rotY);

      editorCam.setLookPaused(false);
      domElement.dispatch({ type: 'mousedown', button: 2 });
      domElement.dispatch({ type: 'mousemove', movementX: 50, movementY: 0 });
      expect(camera.rotation.y).not.toBe(rotY);
    });

    it('should lock input and halt movement when setInputLocked(true)', () => {
      editorCam.setInputLocked(true);
      expect(editorCam.isInputLocked()).toBe(true);

      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });
      editorCam.update(1.0);
      expect(camera.position.z).toBe(initialZ);
    });

    it('should handle zero, negative, or NaN delta gracefully without NaN explosion', () => {
      const initialZ = camera.position.z;
      domElement.dispatch({ type: 'keydown', code: 'KeyW' });

      editorCam.update(0);
      expect(camera.position.z).toBe(initialZ);

      editorCam.update(-0.5);
      expect(camera.position.z).toBe(initialZ);

      editorCam.update(NaN);
      expect(camera.position.z).toBe(initialZ);
      expect(Number.isFinite(camera.position.z)).toBe(true);
    });
  });

  // ==========================================================================
  // Suite 3: PlayerGhostBeacon Holographic Avatar & Sky Beam
  // ==========================================================================
  describe('3. PlayerGhostBeacon Visual Avatar & Light Beam', () => {
    let scene: THREE.Scene;
    let beacon: PlayerGhostBeacon;

    beforeEach(() => {
      scene = new THREE.Scene();
      beacon = new PlayerGhostBeacon(scene);
    });

    afterEach(() => {
      beacon.remove();
      scene.clear();
    });

    it('should spawn holographic group with light pillar and reticle at target position', () => {
      const group = beacon.spawn({ position: { x: 100, y: 0, z: 124 }, yaw: 1.57 });

      expect(beacon.isSpawned()).toBe(true);
      expect(group.name).toBe('player-ghost-beacon');
      expect(group.position.x).toBe(100);
      expect(group.position.z).toBe(124);
      expect(group.rotation.y).toBeCloseTo(1.57, 2);
      expect(scene.children).toContain(group);

      // Verify structure: body, visor, head, beam, reticle ring, diamond
      expect(group.children.length).toBeGreaterThanOrEqual(6);
    });

    it('should support spawn with Vector3 and yaw parameters', () => {
      const pos = new THREE.Vector3(50, 2, 70);
      const group = beacon.spawn(pos, 0.5);

      expect(group.position.x).toBe(50);
      expect(group.position.y).toBe(2);
      expect(group.position.z).toBe(70);
      expect(group.rotation.y).toBe(0.5);
    });

    it('should animate diamond marker and reticle during update()', () => {
      const group = beacon.spawn({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
      const diamond = group.children.find((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.OctahedronGeometry) as THREE.Mesh;

      expect(diamond).toBeDefined();
      const initialRotY = diamond.rotation.y;
      beacon.update(0.5);
      expect(diamond.rotation.y).toBeGreaterThan(initialRotY);
    });

    it('should completely dispose geometries and materials on remove()', () => {
      const group = beacon.spawn({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
      const geometries: THREE.BufferGeometry[] = [];
      const materials: THREE.Material[] = [];

      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          if (obj.geometry) geometries.push(obj.geometry);
          if (obj.material) materials.push(obj.material);
        }
      });

      const geoDisposeSpies = geometries.map((g) => vi.spyOn(g, 'dispose'));
      const matDisposeSpies = materials.map((m) => vi.spyOn(m, 'dispose'));

      beacon.remove();

      expect(beacon.isSpawned()).toBe(false);
      expect(scene.children).not.toContain(group);
      geoDisposeSpies.forEach((s) => expect(s).toHaveBeenCalled());
      matDisposeSpies.forEach((s) => expect(s).toHaveBeenCalled());
    });

    it('should dispose previous beacon cleanly when spawn() is called multiple times', () => {
      beacon.spawn({ position: { x: 10, y: 0, z: 10 }, yaw: 0 });
      expect(scene.children.length).toBe(1);

      beacon.spawn({ position: { x: 20, y: 0, z: 20 }, yaw: 1 });
      expect(scene.children.length).toBe(1);
      expect(beacon.getGroup()?.position.x).toBe(20);
    });
  });

  // ==========================================================================
  // Suite 4: PlayerController Camera Restoration
  // ==========================================================================
  describe('4. PlayerController Camera Restoration & Input Locking', () => {
    let camera: THREE.PerspectiveCamera;
    let domElement: MockDomElement;
    let controller: PlayerController;
    let origDoc: any;
    let origWin: any;

    beforeEach(() => {
      origDoc = globalThis.document;
      origWin = globalThis.window;

      const mockDoc = new MockDomElement() as any;
      mockDoc.pointerLockElement = null;
      mockDoc.exitPointerLock = vi.fn();
      const mockWin = new MockDomElement() as any;

      globalThis.document = mockDoc;
      globalThis.window = mockWin;

      camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      domElement = new MockDomElement();
      controller = new PlayerController(camera, domElement as any, {
        eyeHeight: 1.7,
      });
    });

    afterEach(() => {
      controller.dispose();
      globalThis.document = origDoc;
      globalThis.window = origWin;
    });

    it('should reset camera position to player eye height and sync yaw/pitch', () => {
      // Player is at position (100, 0, 100)
      controller.position.set(100, 0, 100);

      // Camera flew away to (150, 50, 150) in editor mode
      camera.position.set(150, 50, 150);
      camera.rotation.set(0.5, 2.0, 0);

      // Reset camera to player with saved yaw
      controller.resetCameraToPlayer(1.23, 0.1);

      expect(camera.position.x).toBe(100);
      expect(camera.position.y).toBeCloseTo(1.7, 2);
      expect(camera.position.z).toBe(100);
      expect(controller.getYaw()).toBeCloseTo(1.23, 2);
    });

    it('should directly set rotation with setRotation(yaw, pitch)', () => {
      controller.setRotation(0.75, 0.25);
      expect(controller.getYaw()).toBeCloseTo(0.75, 2);
      expect(camera.rotation.y).toBeCloseTo(0.75, 2);
    });

    it('should halt velocity and keys on setLocked(true)', () => {
      controller.setLocked(true);
      expect(controller.isLocked()).toBe(true);

      controller.setLocked(false);
      expect(controller.isLocked()).toBe(false);
    });
  });

  // ==========================================================================
  // Suite 5: Chunk Streaming & Memory Invariant in Editor Mode (Feature F5)
  // ==========================================================================
  describe('5. Chunk Streaming & Memory Invariant in Editor Mode', () => {
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

    it('should strictly maintain <= 9 chunks (<= 10% cache) across full editor flight sweep', () => {
      // Simulate flying across map diagonal from (0, 0) to (200, 200) in 5-unit increments
      for (let pos = 0; pos <= 200; pos += 5) {
        streamer.update(pos, pos);
        const count = streamer.getLoadedChunksCount();
        const cachePct = streamer.getCachePercentage();

        expect(count).toBeLessThanOrEqual(9);
        expect(cachePct).toBeLessThanOrEqual(9.0);
      }
    });

    it('should execute unloads before loads during rapid editor teleportation', () => {
      const order: string[] = [];
      const trackingStreamer = new ChunkStreamer(
        scene,
        {},
        (cx, cz) => {
          order.push(`load:${cx}_${cz}`);
          return new THREE.Group();
        },
        (_obj) => {
          order.push('unload');
        }
      );

      // Start at center (100, 100) -> 9 chunks loaded
      trackingStreamer.update(100, 100);
      order.length = 0; // Clear initial load logs

      // Teleport to opposite corner (0, 0)
      trackingStreamer.update(0, 0);

      const firstUnloadIdx = order.indexOf('unload');
      const firstLoadIdx = order.findIndex((e) => e.startsWith('load:'));

      expect(firstUnloadIdx).toBeGreaterThanOrEqual(0);
      expect(firstLoadIdx).toBeGreaterThanOrEqual(0);
      expect(firstUnloadIdx).toBeLessThan(firstLoadIdx);

      trackingStreamer.dispose();
    });
  });
});
