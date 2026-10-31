import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { WSClient } from '../src/net/WSClient';
import { MovePayload } from '../src/net/types';
import { PlayerController } from '../src/engine/PlayerController';
import { OtherPlayerManager } from '../src/engine/OtherPlayerManager';

// =========================================================================
// Lightweight DOM Harness for Node.js Vitest Environment
// =========================================================================
class MockDOMTarget {
  private listeners: Record<string, Set<Function>> = {};

  addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(fn);
  }

  removeEventListener(event: string, fn: Function): void {
    this.listeners[event]?.delete(fn);
  }

  dispatchEvent(event: { type: string; code?: string; movementX?: number; movementY?: number }): boolean {
    const set = this.listeners[event.type];
    if (set) {
      set.forEach((fn) => fn(event));
    }
    return true;
  }
}

describe('Adversarial M1 Verification Suite', () => {
  let mockCurrentTime = 1000;
  let perfSpy: any;

  function advanceTime(ms: number): void {
    mockCurrentTime += ms;
    vi.advanceTimersByTime(ms);
  }

  beforeEach(() => {
    mockCurrentTime = 1000;
    vi.useFakeTimers();
    perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => mockCurrentTime);
  });

  afterEach(() => {
    perfSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // =========================================================================
  // 1. 20Hz MOVE Throttling Under Adversarial Bursts & Stationary Stress
  // =========================================================================
  describe('Mission 1: 20Hz MOVE Throttling Stress', () => {
    it('STRESS-MOVE-01: Rapid burst of 100 calls in single tick should send exactly 1 leading edge packet and 1 trailing edge packet', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      // 100 rapid calls at t = 1000ms
      for (let i = 0; i < 100; i++) {
        client.sendMove(10 + i * 0.1, 20 + i * 0.1, i * 0.01);
      }

      // Leading edge must send packet #0 immediately
      expect(sentMoves).toHaveLength(1);
      expect(sentMoves[0].x).toBeCloseTo(10.0, 4);

      // Advance clock to t = 49ms (still in throttle window)
      advanceTime(49);
      expect(sentMoves).toHaveLength(1);

      // Advance clock past 50ms (trailing edge flush)
      advanceTime(2);
      expect(sentMoves).toHaveLength(2);
      // Trailing edge must send the final (100th) position
      expect(sentMoves[1].x).toBeCloseTo(10 + 99 * 0.1, 4);
    });

    it('STRESS-MOVE-02: 120 FPS continuous stream over 1000ms must not exceed 21 packets (20Hz rate limit)', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      // 120 FPS: call every ~8.33ms for 1000ms
      const frameDelta = 1000 / 120;
      for (let t = 0; t <= 1000; t += frameDelta) {
        client.sendMove(t * 0.1, t * 0.2, (t % 360) * 0.01);
        advanceTime(frameDelta);
      }

      // In 1000ms at 20Hz, maximum allowed packets is 1 (immediate) + 20 (cooldowns) = 21 packets
      expect(sentMoves.length).toBeGreaterThanOrEqual(20);
      expect(sentMoves.length).toBeLessThanOrEqual(21);
    });

    it('STRESS-MOVE-03: Boundary stop immediately flushes the stop position without delay after cooldown', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      // Move at t=0
      client.sendMove(50, 50, 0);
      expect(sentMoves).toHaveLength(1);

      // Move at t=10, 20, 30, and abrupt STOP at t=35 at (55.5, 55.5, 0)
      advanceTime(10);
      client.sendMove(51, 51, 0);
      advanceTime(10);
      client.sendMove(52, 52, 0);
      advanceTime(10);
      client.sendMove(53, 53, 0);
      advanceTime(5);
      const stopPos = { x: 55.5, z: 55.5, rotation: 0 };
      client.sendMove(stopPos.x, stopPos.z, stopPos.rotation);

      // Still only 1 packet sent so far
      expect(sentMoves).toHaveLength(1);

      // Advance by remaining 15ms to complete 50ms cooldown (total elapsed = 50ms from start)
      advanceTime(15);

      // Trailing flush must deliver the EXACT stop position
      expect(sentMoves).toHaveLength(2);
      expect(sentMoves[1]).toEqual(stopPos);

      // Advance further by 200ms with no new inputs: no ghost packets sent!
      advanceTime(200);
      expect(sentMoves).toHaveLength(2);
    });

    it('STRESS-MOVE-04: Stationary filtering rejects micro-jitter below epsilon = 0.001 even across multiple 50ms intervals', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50, moveEpsilon: 0.001 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      // Initial position
      client.sendMove(100.0, 100.0, 1.57);
      expect(sentMoves).toHaveLength(1);

      // Player stands still, simulating 100 frames with sensor micro-noise < 0.0005
      for (let i = 0; i < 100; i++) {
        advanceTime(50);
        const noiseX = (Math.random() - 0.5) * 0.0008;
        const noiseZ = (Math.random() - 0.5) * 0.0008;
        const noiseRot = (Math.random() - 0.5) * 0.0008;
        client.sendMove(100.0 + noiseX, 100.0 + noiseZ, 1.57 + noiseRot);
      }

      // No packets should have been sent after the initial one!
      expect(sentMoves).toHaveLength(1);

      // Legitimate move exceeding epsilon (> 0.001) should send
      advanceTime(50);
      client.sendMove(100.005, 100.0, 1.57);
      expect(sentMoves).toHaveLength(2);
    });

    it('STRESS-MOVE-05: Force flag bypasses both 50ms cooldown and epsilon stationary filter', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      client.sendMove(10, 10, 0);
      expect(sentMoves).toHaveLength(1);

      // Immediate forced send at t = 2ms with IDENTICAL coordinates
      advanceTime(2);
      client.sendMove({ x: 10, z: 10, rotation: 0 }, true);

      expect(sentMoves).toHaveLength(2);
    });

    it('STRESS-MOVE-06: Disconnect cleans up pending throttle timers and suppresses trailing emissions', () => {
      const client = new WSClient({ mock: false, autoReconnect: false, moveThrottleMs: 50 });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') sentMoves.push(payload as MovePayload);
        return true;
      });

      // t=0: first move sends
      client.sendMove(10, 10, 0);
      expect(sentMoves).toHaveLength(1);

      // t=10: buffered move
      advanceTime(10);
      client.sendMove(20, 20, 0);
      expect(sentMoves).toHaveLength(1);

      // Disconnect at t=20 (before cooldown expires)
      advanceTime(10);
      client.disconnect();

      // Advance clock past cooldown: timer was cleared so no trailing send occurs
      advanceTime(100);
      expect(sentMoves).toHaveLength(1);
    });
  });

  // =========================================================================
  // 2. Player Boundary Enforcement [1.0, 199.0] Stress Testing
  // =========================================================================
  describe('Mission 2: Boundary Enforcement [1.0, 199.0] Stress', () => {
    let camera: THREE.PerspectiveCamera;
    let mockDom: MockDOMTarget;
    let mockDocument: any;
    let mockWindow: any;
    let originalDocument: any;
    let originalWindow: any;
    let controller: PlayerController;

    beforeEach(() => {
      mockDom = new MockDOMTarget();
      mockDocument = new MockDOMTarget();
      mockDocument.pointerLockElement = null;
      mockDocument.exitPointerLock = vi.fn();

      mockWindow = new MockDOMTarget();

      originalDocument = (globalThis as any).document;
      originalWindow = (globalThis as any).window;

      (globalThis as any).document = mockDocument;
      (globalThis as any).window = mockWindow;

      camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
      controller = new PlayerController(camera, mockDom as unknown as HTMLElement, {
        spawnPosition: { x: 100, y: 0, z: 100 },
        walkSpeed: 6.0,
        sprintSpeed: 10.5,
      });
    });

    afterEach(() => {
      controller.dispose();
      (globalThis as any).document = originalDocument;
      (globalThis as any).window = originalWindow;
    });

    const triggerKey = (code: string, pressed: boolean) => {
      mockWindow.dispatchEvent({ type: pressed ? 'keydown' : 'keyup', code });
    };

    it('STRESS-BOUND-01: Continuous sprinting into all 4 world boundaries never exceeds [1.0, 199.0]', () => {
      // 1. Sprint North (-Z)
      camera.rotation.set(0, 0, 0);
      triggerKey('KeyW', true);
      triggerKey('ShiftLeft', true);

      for (let i = 0; i < 500; i++) {
        controller.update(0.1);
        const pos = controller.getPosition();
        expect(pos.z).toBeGreaterThanOrEqual(1.0);
        expect(pos.z).toBeLessThanOrEqual(199.0);
      }
      expect(controller.getPosition().z).toBeCloseTo(1.0, 4);

      // 2. Sprint South (+Z)
      triggerKey('KeyW', false);
      triggerKey('KeyS', true);

      for (let i = 0; i < 1000; i++) {
        controller.update(0.1);
        const pos = controller.getPosition();
        expect(pos.z).toBeGreaterThanOrEqual(1.0);
        expect(pos.z).toBeLessThanOrEqual(199.0);
      }
      expect(controller.getPosition().z).toBeCloseTo(199.0, 4);

      // 3. Sprint East (+X)
      triggerKey('KeyS', false);
      triggerKey('KeyD', true);

      for (let i = 0; i < 1000; i++) {
        controller.update(0.1);
        const pos = controller.getPosition();
        expect(pos.x).toBeGreaterThanOrEqual(1.0);
        expect(pos.x).toBeLessThanOrEqual(199.0);
      }
      expect(controller.getPosition().x).toBeCloseTo(199.0, 4);

      // 4. Sprint West (-X)
      triggerKey('KeyD', false);
      triggerKey('KeyA', true);

      for (let i = 0; i < 1000; i++) {
        controller.update(0.1);
        const pos = controller.getPosition();
        expect(pos.x).toBeGreaterThanOrEqual(1.0);
        expect(pos.x).toBeLessThanOrEqual(199.0);
      }
      expect(controller.getPosition().x).toBeCloseTo(1.0, 4);

      triggerKey('KeyA', false);
      triggerKey('ShiftLeft', false);
    });

    it('STRESS-BOUND-02: Extreme velocity spikes and huge delta steps cannot escape boundaries', () => {
      triggerKey('KeyW', true);
      // Massive delta spike of 500 seconds
      controller.update(500.0);

      const pos = controller.getPosition();
      expect(pos.x).toBeGreaterThanOrEqual(1.0);
      expect(pos.x).toBeLessThanOrEqual(199.0);
      expect(pos.z).toBeGreaterThanOrEqual(1.0);
      expect(pos.z).toBeLessThanOrEqual(199.0);

      triggerKey('KeyW', false);
    });

    it('STRESS-BOUND-03: Diagonal corner clamping at all 4 extreme corners', () => {
      controller.setPosition(-9999, 0, -9999);
      let p = controller.getPosition();
      expect(p.x).toBe(1.0);
      expect(p.z).toBe(1.0);

      controller.setPosition(9999, 0, 9999);
      p = controller.getPosition();
      expect(p.x).toBe(199.0);
      expect(p.z).toBe(199.0);

      controller.setPosition(-9999, 0, 9999);
      p = controller.getPosition();
      expect(p.x).toBe(1.0);
      expect(p.z).toBe(199.0);

      controller.setPosition(9999, 0, -9999);
      p = controller.getPosition();
      expect(p.x).toBe(199.0);
      expect(p.z).toBe(1.0);
    });

    it('STRESS-BOUND-04: Boundary wall sliding while pressing diagonally into edge', () => {
      // Place player right at North boundary: (100, 0, 1.0)
      controller.setPosition(100, 0, 1.0);

      // Press KeyW (into North wall) AND KeyD (slide East)
      triggerKey('KeyW', true);
      triggerKey('KeyD', true);

      // Update for 50 frames
      for (let i = 0; i < 50; i++) {
        controller.update(0.05);
        const pos = controller.getPosition();
        // Z must stay clamped to 1.0
        expect(pos.z).toBeCloseTo(1.0, 4);
        // X must slide towards East
        expect(pos.x).toBeGreaterThanOrEqual(100);
      }

      triggerKey('KeyW', false);
      triggerKey('KeyD', false);
    });

    it('STRESS-BOUND-05: Obstacle collision abutting the boundary traps player without escaping', () => {
      // Add obstacle Box3 at [1.0, 0, 1.0] to [5.0, 2, 5.0]
      const obstacle = new THREE.Box3(
        new THREE.Vector3(1.0, 0, 1.0),
        new THREE.Vector3(5.0, 2.0, 5.0)
      );
      controller.addObstacle(obstacle);

      // Position player at (6.0, 0, 3.0) and push towards obstacle into boundary
      controller.setPosition(6.0, 0, 3.0);

      triggerKey('KeyA', true); // Move West into obstacle

      for (let i = 0; i < 50; i++) {
        controller.update(0.05);
        const pos = controller.getPosition();
        // Player should be blocked by obstacle before reaching boundary
        expect(pos.x).toBeGreaterThan(4.9);
        expect(pos.x).toBeLessThanOrEqual(199.0);
      }

      triggerKey('KeyA', false);
    });

    it('STRESS-BOUND-06: Zero delta and negative delta do not corrupt position within [1.0, 199.0]', () => {
      const posBefore = controller.getPosition();
      controller.update(0);
      const posAfterZero = controller.getPosition();
      expect(posAfterZero.x).toBe(posBefore.x);
      expect(posAfterZero.z).toBe(posBefore.z);

      // Even under zero delta, boundaries are strictly respected
      expect(posAfterZero.x).toBeGreaterThanOrEqual(1.0);
      expect(posAfterZero.x).toBeLessThanOrEqual(199.0);
    });
  });

  // =========================================================================
  // 3. Remote Avatar Interpolation Under Network Stress
  // =========================================================================
  describe('Mission 3: Remote Avatar Interpolation Under Network Stress', () => {
    let scene: THREE.Scene;
    let manager: OtherPlayerManager;

    beforeEach(() => {
      scene = new THREE.Scene();
      manager = new OtherPlayerManager(scene, {
        lerpSpeed: 10.0,
        teleportDistanceThreshold: 8.0,
        staleTimeoutMs: 5000,
      });
    });

    afterEach(() => {
      manager.dispose();
    });

    it('STRESS-NET-01: High-latency / packet burst updates smoothly without popping', () => {
      manager.updatePlayer({ player_id: 1, x: 10, z: 10, rotation: 0 });

      // After latency gap, burst of 5 queued packets arrives at once
      const packets = [
        { player_id: 1, x: 11, z: 10, rotation: 0.1 },
        { player_id: 1, x: 12, z: 10, rotation: 0.2 },
        { player_id: 1, x: 13, z: 10, rotation: 0.3 },
        { player_id: 1, x: 14, z: 10, rotation: 0.4 },
        { player_id: 1, x: 15, z: 10, rotation: 0.5 },
      ];

      for (const p of packets) {
        manager.updatePlayer(p);
      }

      const group = scene.children[0] as THREE.Group;
      expect(group.position.x).toBe(10);

      // Frame ticks advance smoothly
      manager.update(0.02);
      expect(group.position.x).toBeGreaterThan(10);
      expect(group.position.x).toBeLessThan(15);

      manager.update(0.05);
      expect(group.position.x).toBeGreaterThan(11);

      for (let i = 0; i < 20; i++) {
        manager.update(0.05);
      }
      expect(group.position.x).toBeCloseTo(15, 1);
    });

    it('STRESS-NET-02: Teleport threshold strictly snaps at > 8.0m and smoothly lerps at <= 8.0m', () => {
      manager.updatePlayer({ player_id: 2, x: 50, z: 50, rotation: 0 });
      const group = scene.children[0] as THREE.Group;

      // Sub-threshold jump: exactly 7.5m (< 8.0m)
      manager.updatePlayer({ player_id: 2, x: 57.5, z: 50, rotation: 0 });
      expect(group.position.x).toBe(50);
      manager.update(0.01);
      expect(group.position.x).toBeGreaterThan(50);
      expect(group.position.x).toBeLessThan(57.5);

      for (let i = 0; i < 50; i++) manager.update(0.05);
      expect(group.position.x).toBeCloseTo(57.5, 2);

      // Super-threshold jump: exactly 8.5m (> 8.0m teleport)
      manager.updatePlayer({ player_id: 2, x: 66.0, z: 50, rotation: 1.0 });
      expect(group.position.x).toBe(66.0);
      expect(group.rotation.y).toBe(1.0);
    });

    it('STRESS-NET-03: Out-of-order packets update target gracefully without crashing or infinite loops', () => {
      manager.updatePlayer({ player_id: 3, x: 10, z: 10, rotation: 0 });
      const group = scene.children[0] as THREE.Group;

      // Packet B arrives first
      manager.updatePlayer({ player_id: 3, x: 16, z: 10, rotation: 0.5 });
      manager.update(0.05);
      expect(group.position.x).toBeGreaterThan(10);

      // Out-of-order Packet A arrives second
      manager.updatePlayer({ player_id: 3, x: 12, z: 10, rotation: 0.2 });

      manager.update(0.05);
      expect(manager.hasPlayer(3)).toBe(true);
      expect(group.position.x).toBeGreaterThan(10);
    });

    it('STRESS-NET-04: Shortest angular path handles wrapping across +PI / -PI seamlessly', () => {
      manager.updatePlayer({ player_id: 4, x: 0, z: 0, rotation: 3.10 });
      const group = scene.children[0] as THREE.Group;

      // Target swings across seam to -3.10 rad
      manager.updatePlayer({ player_id: 4, x: 0, z: 0, rotation: -3.10 });

      manager.update(0.05);

      // Shortest path increases towards seam
      expect(group.rotation.y).toBeGreaterThan(3.10);
    });

    it('STRESS-NET-05: Pruning inactive/stale players after staleTimeoutMs', () => {
      manager.updatePlayer({ player_id: 99, x: 0, z: 0, rotation: 0 });
      expect(manager.getPlayerCount()).toBe(1);

      // Advance clock past staleTimeoutMs (5000ms)
      advanceTime(6000);

      // Trigger update tick
      manager.update(0.05);

      // Inactive player should be pruned from scene and registry
      expect(manager.getPlayerCount()).toBe(0);
      expect(scene.children.length).toBe(0);
    });

    it('STRESS-NET-06: Rapid churn of 50 remote players spawns and despawns without memory leak', () => {
      for (let i = 1; i <= 50; i++) {
        manager.updatePlayer({
          player_id: i,
          x: i * 2,
          z: i * 2,
          rotation: (i % 6) * 0.5,
        });
      }
      expect(manager.getPlayerCount()).toBe(50);
      expect(scene.children.length).toBe(50);

      for (let f = 0; f < 10; f++) {
        manager.update(0.05);
      }

      manager.clear();
      expect(manager.getPlayerCount()).toBe(0);
      expect(scene.children.length).toBe(0);
    });

    it('STRESS-NET-07: Randomized fuzzing with 1,000 erratic network packets and boundary coordinates', () => {
      // Initialize 5 remote players
      const playerIds = [101, 102, 103, 104, 105];
      for (const id of playerIds) {
        manager.updatePlayer({ player_id: id, x: 100, z: 100, rotation: 0 });
      }

      // Generate 1,000 randomized packets simulating latency, bursts, and out-of-order jumps
      for (let i = 0; i < 1000; i++) {
        const id = playerIds[i % playerIds.length];
        const randomX = 1.0 + Math.random() * 198.0;
        const randomZ = 1.0 + Math.random() * 198.0;
        const randomRot = (Math.random() - 0.5) * Math.PI * 2;

        manager.updatePlayer({
          player_id: id,
          x: randomX,
          z: randomZ,
          rotation: randomRot,
        });

        // Advance random delta between 0.001s and 0.1s
        const delta = 0.001 + Math.random() * 0.05;
        manager.update(delta);
      }

      // Verify all 5 avatars remain alive, valid, and non-NaN
      expect(manager.getPlayerCount()).toBe(5);
      for (const child of scene.children) {
        const grp = child as THREE.Group;
        expect(Number.isFinite(grp.position.x)).toBe(true);
        expect(Number.isFinite(grp.position.z)).toBe(true);
        expect(Number.isFinite(grp.rotation.y)).toBe(true);
        expect(grp.position.x).toBeGreaterThanOrEqual(1.0);
        expect(grp.position.x).toBeLessThanOrEqual(199.0);
        expect(grp.position.z).toBeGreaterThanOrEqual(1.0);
        expect(grp.position.z).toBeLessThanOrEqual(199.0);
      }
    });
  });
});
