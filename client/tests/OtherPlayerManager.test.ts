import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { OtherPlayerManager } from '../src/engine/OtherPlayerManager';

describe('OtherPlayerManager Unit Test Suite', () => {
  let scene: THREE.Scene;
  let manager: OtherPlayerManager;

  beforeEach(() => {
    scene = new THREE.Scene();
    manager = new OtherPlayerManager(scene, {
      lerpSpeed: 10.0,
      teleportDistanceThreshold: 8.0,
      staleTimeoutMs: 10000,
    });
  });

  it('should spawn a new 3D player avatar on first updatePlayer packet', () => {
    expect(manager.getPlayerCount()).toBe(0);

    manager.updatePlayer({
      player_id: 42,
      x: 100,
      z: 100,
      rotation: Math.PI / 2,
    });

    expect(manager.getPlayerCount()).toBe(1);
    expect(manager.hasPlayer(42)).toBe(true);

    // Verify avatar group was added to the Three.js scene
    expect(scene.children.length).toBe(1);
    const avatarGroup = scene.children[0] as THREE.Group;
    expect(avatarGroup.position.x).toBe(100);
    expect(avatarGroup.position.z).toBe(100);
    expect(avatarGroup.rotation.y).toBeCloseTo(Math.PI / 2, 4);
  });

  it('should smoothly interpolate (lerp) position towards new target', () => {
    manager.updatePlayer({
      player_id: 1,
      x: 50,
      z: 50,
      rotation: 0,
    });

    // Update target position
    manager.updatePlayer({
      player_id: 1,
      x: 54,
      z: 50,
      rotation: 0,
    });

    // Advance simulation by 0.05 seconds (delta = 0.05, lerpFactor = 0.5)
    manager.update(0.05);

    const avatarGroup = scene.children[0] as THREE.Group;
    expect(avatarGroup.position.x).toBeGreaterThan(50);
    expect(avatarGroup.position.x).toBeLessThan(54);
    expect(avatarGroup.position.x).toBeCloseTo(52, 1);
  });

  it('should smoothly interpolate rotation using shortest angular path across seam', () => {
    // Start at -3.0 radians (approx -172 deg)
    manager.updatePlayer({
      player_id: 2,
      x: 10,
      z: 10,
      rotation: -3.0,
    });

    // Target turns to +3.0 radians (approx +172 deg) - shortest delta is ~0.28 rad across seam, not 6.0 rad
    manager.updatePlayer({
      player_id: 2,
      x: 10,
      z: 10,
      rotation: 3.0,
    });

    manager.update(0.05);

    const avatarGroup = scene.children[0] as THREE.Group;
    // Rotation should move in the negative direction towards -Math.PI / +Math.PI seam
    expect(avatarGroup.rotation.y).toBeLessThan(-3.0);
  });

  it('should snap immediately when distance exceeds teleportDistanceThreshold', () => {
    manager.updatePlayer({
      player_id: 3,
      x: 10,
      z: 10,
      rotation: 0,
    });

    // Teleport jump of 100 meters (> 8m threshold)
    manager.updatePlayer({
      player_id: 3,
      x: 110,
      z: 110,
      rotation: 1.5,
    });

    const avatarGroup = scene.children[0] as THREE.Group;
    expect(avatarGroup.position.x).toBe(110);
    expect(avatarGroup.position.z).toBe(110);
    expect(avatarGroup.rotation.y).toBe(1.5);
  });

  it('should remove player and dispose resources cleanly', () => {
    manager.updatePlayer({
      player_id: 99,
      x: 20,
      z: 20,
      rotation: 0,
    });

    expect(scene.children.length).toBe(1);
    expect(manager.hasPlayer(99)).toBe(true);

    manager.removePlayer(99);

    expect(manager.hasPlayer(99)).toBe(false);
    expect(manager.getPlayerCount()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('should clear all players on dispose()', () => {
    manager.updatePlayer({ player_id: 1, x: 0, z: 0, rotation: 0 });
    manager.updatePlayer({ player_id: 2, x: 10, z: 10, rotation: 0 });
    expect(manager.getPlayerCount()).toBe(2);

    manager.dispose();

    expect(manager.getPlayerCount()).toBe(0);
    expect(scene.children.length).toBe(0);
  });
});

describe('OtherPlayerManager placeholder avatars and nicknames', () => {
  let scene: THREE.Scene;
  let manager: OtherPlayerManager;

  beforeEach(() => {
    scene = new THREE.Scene();
    manager = new OtherPlayerManager(scene);
  });

  it('should build a stick placeholder with a nose instead of a character model', () => {
    manager.updatePlayer({ player_id: 7, x: 10, z: 10, rotation: 0 });
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes).toHaveLength(2);
    expect(meshes.every((m) => m.geometry instanceof THREE.BoxGeometry)).toBe(true);
    const stick = meshes.find((m) => (m.geometry as THREE.BoxGeometry).parameters.height > 1)!;
    expect((stick.geometry as THREE.BoxGeometry).parameters.height).toBeCloseTo(1.7);
  });

  it('should show the login from PLAYER_JOIN above the head', () => {
    manager.updatePlayer({ player_id: 7, x: 10, z: 10, rotation: 0, login: 'boris' });
    expect(manager.getPlayerName(7)).toBe('boris');
    const sprite = scene.getObjectByProperty('type', 'Sprite') as THREE.Sprite;
    expect(sprite.position.y).toBeGreaterThan(1.7);
    expect(sprite.material.depthTest).toBe(false);
  });

  it('should fill in the nickname when PLAYER_JOIN arrives after the first PLAYER_MOVE', () => {
    manager.updatePlayer({ player_id: 7, x: 10, z: 10, rotation: 0 });
    expect(manager.getPlayerName(7)).toBe('…');
    manager.updatePlayer({ player_id: 7, x: 10, z: 10, rotation: 0, login: 'alice' });
    expect(manager.getPlayerName(7)).toBe('alice');
    manager.setPlayerName(7, 'alice2');
    expect(manager.getPlayerName(7)).toBe('alice2');
  });

  it('should keep a player who stands still; only removePlayer (PLAYER_LEAVE) removes them', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    manager.updatePlayer({ player_id: 7, x: 10, z: 10, rotation: 0, login: 'boris' });
    now.mockReturnValue(10 * 60 * 1000);
    manager.update(0.016);
    expect(manager.hasPlayer(7)).toBe(true);
    now.mockRestore();
    manager.removePlayer(7);
    expect(manager.hasPlayer(7)).toBe(false);
    expect(scene.children).toHaveLength(0);
  });
});
