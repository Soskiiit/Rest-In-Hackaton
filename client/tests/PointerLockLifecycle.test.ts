import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { PlayerController } from '../src/engine/PlayerController';

// Lightweight Mock DOM for headless PointerLock and Window Event Testing
class MockDomElement {
  public listeners: Record<string, Function[]> = {};
  public requestPointerLockCalled = 0;

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): void {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
  }

  public requestPointerLock(): void {
    this.requestPointerLockCalled++;
  }
}

class MockDocument {
  public pointerLockElement: any = null;
  public exitPointerLockCalled = 0;
  public listeners: Record<string, Function[]> = {};

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): void {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
  }

  public exitPointerLock(): void {
    this.exitPointerLockCalled++;
    this.pointerLockElement = null;
    this.dispatchEvent({ type: 'pointerlockchange' });
  }
}

class MockWindow {
  public listeners: Record<string, Function[]> = {};

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): void {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
  }
}

describe('Adversarial Test Suite 2: PointerLock Lifecycle & Movement Integrity', () => {
  let mockDomElement: MockDomElement;
  let mockDoc: MockDocument;
  let mockWin: MockWindow;
  let camera: THREE.PerspectiveCamera;
  let controller: PlayerController;

  let origDoc: any;
  let origWin: any;

  beforeEach(() => {
    origDoc = globalThis.document;
    origWin = globalThis.window;

    mockDomElement = new MockDomElement();
    mockDoc = new MockDocument();
    mockWin = new MockWindow();

    globalThis.document = mockDoc as any;
    globalThis.window = mockWin as any;

    camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 500);
    controller = new PlayerController(camera, mockDomElement as any, {
      walkSpeed: 6.0,
      sprintSpeed: 10.0,
      spawnPosition: { x: 100, y: 0, z: 100 },
      minBoundX: 1.0,
      maxBoundX: 199.0,
      minBoundZ: 1.0,
      maxBoundZ: 199.0,
    });
  });

  afterEach(() => {
    controller.dispose();
    globalThis.document = origDoc;
    globalThis.window = origWin;
  });

  describe('1. PointerLock Acquisition & Rapid Clicking Stress', () => {
    it('should request pointer lock on click when unlocked and input is active', () => {
      expect(mockDomElement.requestPointerLockCalled).toBe(0);

      // Trigger user click
      mockDomElement.dispatchEvent({ type: 'click' });
      expect(mockDomElement.requestPointerLockCalled).toBe(1);
    });

    it('should survive 100 rapid click events without throwing or entering corrupted state', () => {
      for (let i = 0; i < 100; i++) {
        mockDomElement.dispatchEvent({ type: 'click' });
      }
      expect(mockDomElement.requestPointerLockCalled).toBe(100);
      expect(controller.isLocked()).toBe(false);
    });

    it('should fire onLock and onUnlock callbacks synchronously on pointerlockchange', () => {
      let lockFired = 0;
      let unlockFired = 0;

      controller.onLock(() => lockFired++);
      controller.onUnlock(() => unlockFired++);

      // 1. Browser grants pointer lock
      mockDoc.pointerLockElement = mockDomElement;
      mockDoc.dispatchEvent({ type: 'pointerlockchange' });

      expect(controller.getIsPointerLocked()).toBe(true);
      expect(lockFired).toBe(1);
      expect(unlockFired).toBe(0);

      // 2. User presses Escape -> browser releases pointer lock
      mockDoc.pointerLockElement = null;
      mockDoc.dispatchEvent({ type: 'pointerlockchange' });

      expect(controller.getIsPointerLocked()).toBe(false);
      expect(lockFired).toBe(1);
      expect(unlockFired).toBe(1);
    });
  });

  describe('2. Modal Active State & Input Lock Coordination', () => {
    it('should immediately suspend input and exit pointer lock when modal opens', () => {
      // Engage pointer lock first
      mockDoc.pointerLockElement = mockDomElement;
      mockDoc.dispatchEvent({ type: 'pointerlockchange' });
      expect(controller.getIsPointerLocked()).toBe(true);

      // Press movement keys
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyW' });
      mockWin.dispatchEvent({ type: 'keydown', code: 'ShiftLeft' });

      // Open dialogue or quiz modal
      controller.setModalActive(true);

      expect(controller.isLocked()).toBe(true);
      expect(mockDoc.exitPointerLockCalled).toBe(1);

      // Clicks during active modal must NOT trigger requestPointerLock
      const callsBefore = mockDomElement.requestPointerLockCalled;
      mockDomElement.dispatchEvent({ type: 'click' });
      expect(mockDomElement.requestPointerLockCalled).toBe(callsBefore);

      // Direct call to requestPointerLock() must also be rejected
      controller.requestPointerLock();
      expect(mockDomElement.requestPointerLockCalled).toBe(callsBefore);

      // Keypresses during active modal must NOT move the player
      const initialPos = controller.getPosition();
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyW' });
      controller.update(0.1);

      const afterPos = controller.getPosition();
      expect(afterPos.x).toBeCloseTo(initialPos.x, 4);
      expect(afterPos.z).toBeCloseTo(initialPos.z, 4);
    });

    it('should restore input capability when modal closes', () => {
      controller.setModalActive(true);
      expect(controller.isLocked()).toBe(true);

      controller.setModalActive(false);
      expect(controller.isLocked()).toBe(false);

      // Now clicks should request pointer lock again
      mockDomElement.dispatchEvent({ type: 'click' });
      expect(mockDomElement.requestPointerLockCalled).toBeGreaterThan(0);
    });
  });

  describe('3. Hostile Mouse Input & Pitch Clamping', () => {
    it('should strictly clamp pitch within [-85deg, +85deg] ([-1.48, +1.48] rad) under extreme mouse motion', () => {
      // Lock pointer to enable mouse look
      mockDoc.pointerLockElement = mockDomElement;
      mockDoc.dispatchEvent({ type: 'pointerlockchange' });

      const euler = new THREE.Euler(0, 0, 0, 'YXZ');

      // 1. Extreme upward mouse swipe (movementY = -50000)
      mockDoc.dispatchEvent({ type: 'mousemove', movementX: 0, movementY: -50000 });
      euler.setFromQuaternion(camera.quaternion);
      expect(euler.x).toBeLessThanOrEqual(1.48);
      expect(euler.x).toBeCloseTo(1.48, 2);

      // 2. Extreme downward mouse swipe (movementY = +50000)
      mockDoc.dispatchEvent({ type: 'mousemove', movementX: 0, movementY: 50000 });
      euler.setFromQuaternion(camera.quaternion);
      expect(euler.x).toBeGreaterThanOrEqual(-1.48);
      expect(euler.x).toBeCloseTo(-1.48, 2);

      // 3. Verify no NaN in quaternion components
      expect(Number.isNaN(camera.quaternion.x)).toBe(false);
      expect(Number.isNaN(camera.quaternion.y)).toBe(false);
      expect(Number.isNaN(camera.quaternion.z)).toBe(false);
      expect(Number.isNaN(camera.quaternion.w)).toBe(false);
    });

    it('should ignore mousemove when pointer is not locked', () => {
      mockDoc.pointerLockElement = null;
      mockDoc.dispatchEvent({ type: 'pointerlockchange' });

      const rotBefore = camera.quaternion.clone();
      mockDoc.dispatchEvent({ type: 'mousemove', movementX: 100, movementY: 100 });

      expect(camera.quaternion.x).toBe(rotBefore.x);
      expect(camera.quaternion.y).toBe(rotBefore.y);
      expect(camera.quaternion.z).toBe(rotBefore.z);
      expect(camera.quaternion.w).toBe(rotBefore.w);
    });
  });

  describe('4. World Boundary Clamping & Wall Sliding', () => {
    it('should strictly clamp player position to world boundaries [1.0, 199.0] under extreme delta', () => {
      controller.setPosition(195, 0, 195);

      // Press forward and right
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyW' });
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyD' });
      mockWin.dispatchEvent({ type: 'keydown', code: 'ShiftLeft' });

      // Run multiple large physics steps
      for (let i = 0; i < 20; i++) {
        controller.update(0.5);
      }

      const pos = controller.getPosition();
      expect(pos.x).toBeLessThanOrEqual(199.0);
      expect(pos.x).toBeGreaterThanOrEqual(1.0);
      expect(pos.z).toBeLessThanOrEqual(199.0);
      expect(pos.z).toBeGreaterThanOrEqual(1.0);
    });

    it('should slide smoothly along obstacles during collision', () => {
      // Place obstacle box in front of player
      // Player is at (100, 0, 100). Obstacle at x: [95, 105], z: [102, 106]
      const obstacle = new THREE.Box3(
        new THREE.Vector3(95, 0, 102),
        new THREE.Vector3(105, 3, 106)
      );
      controller.addObstacle(obstacle);

      // Face camera towards +Z (forward = 0, 0, 1)
      camera.rotation.set(0, 0, 0);

      // Move forward and right diagonally (KeyW + KeyD)
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyW' });
      mockWin.dispatchEvent({ type: 'keydown', code: 'KeyD' });

      // Update simulation
      for (let i = 0; i < 15; i++) {
        controller.update(0.1);
      }

      const finalPos = controller.getPosition();

      // Z should be blocked before entering the box (radius 0.5 -> z <= 101.5)
      expect(finalPos.z).toBeLessThan(102.0);

      // X should have slid to the right
      expect(finalPos.x).toBeGreaterThan(100.0);

      controller.clearObstacles();
    });
  });

  describe('5. Clean Event Listener Disposal', () => {
    it('should unbind all DOM listeners on dispose()', () => {
      expect(mockDomElement.listeners['click']?.length).toBeGreaterThan(0);
      expect(mockDoc.listeners['pointerlockchange']?.length).toBeGreaterThan(0);
      expect(mockDoc.listeners['mousemove']?.length).toBeGreaterThan(0);
      expect(mockWin.listeners['keydown']?.length).toBeGreaterThan(0);
      expect(mockWin.listeners['keyup']?.length).toBeGreaterThan(0);

      controller.dispose();

      expect(mockDomElement.listeners['click']?.length).toBe(0);
      expect(mockDoc.listeners['pointerlockchange']?.length).toBe(0);
      expect(mockDoc.listeners['mousemove']?.length).toBe(0);
      expect(mockWin.listeners['keydown']?.length).toBe(0);
      expect(mockWin.listeners['keyup']?.length).toBe(0);
    });
  });
});
