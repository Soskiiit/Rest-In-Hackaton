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

describe('OtherPlayerManager comical tourist avatar and animations', () => {
  let scene: THREE.Scene;
  let manager: OtherPlayerManager;
  let touristGltf: any;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const glbPath = path.resolve(__dirname, '../public/models/comical_tourist.glb');
    const bytes = fs.readFileSync(glbPath);
    const loader = new GLTFLoader();
    touristGltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

    scene = new THREE.Scene();
    manager = new OtherPlayerManager(scene);
  });

  it('should attach comical tourist model and preserve all 7 animations', () => {
    manager.setTouristTemplate(touristGltf);
    manager.updatePlayer({ player_id: 10, x: 50, z: 50, rotation: 0, login: 'TouristBob' });

    const clips = manager.getPlayerClips(10);
    expect(clips).toContain('Idle');
    expect(clips).toContain('Walk');
    expect(clips).toContain('Run');
    expect(clips).toContain('Wave');
    expect(clips).toContain('Angry');
    expect(clips).toContain('Jump');
    expect(clips).toContain('FallBack');
    expect(clips).toHaveLength(7);

    // Initial state should be Idle
    expect(manager.getCurrentClip(10)).toBe('Idle');
  });

  it('should upgrade existing placeholder avatar when tourist template is applied', () => {
    // Spawn player before template is loaded
    manager.setTouristTemplate(null);
    manager.updatePlayer({ player_id: 11, x: 20, z: 20, rotation: 0 });

    // Should initially have placeholder meshes
    let meshCountBefore = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshCountBefore++;
    });
    expect(meshCountBefore).toBe(2);

    // Apply comical tourist template
    manager.setTouristTemplate(touristGltf);

    // Should now have the full comical tourist hierarchy (> 30 meshes)
    let meshCountAfter = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshCountAfter++;
    });
    expect(meshCountAfter).toBeGreaterThan(30);
    expect(manager.getCurrentClip(11)).toBe('Idle');
  });

  it('should switch between Idle, Walk, and Run based on movement speed', () => {
    manager.setTouristTemplate(touristGltf);
    manager.updatePlayer({ player_id: 12, x: 0, z: 0, rotation: 0 });
    expect(manager.getCurrentClip(12)).toBe('Idle');

    // 1. Move at normal walking speed (0.6 units over 0.1s = 6.0 m/s)
    manager.updatePlayer({ player_id: 12, x: 0.6, z: 0, rotation: 0 });
    manager.update(0.1);
    expect(manager.getCurrentClip(12)).toBe('Walk');

    // 2. Sprinting movement (1.1 units over 0.1s = 11.0 m/s)
    manager.updatePlayer({ player_id: 12, x: 1.7, z: 0, rotation: 0 });
    manager.update(0.1);
    expect(manager.getCurrentClip(12)).toBe('Run');

    // 3. Arrived at target position: speed drops to 0, returns to Idle
    for (let i = 0; i < 20; i++) {
      manager.update(0.1);
    }
    expect(manager.getCurrentClip(12)).toBe('Idle');
  });

  it('should trigger and play one-shot emote actions like Wave, Angry, Jump, and FallBack', () => {
    manager.setTouristTemplate(touristGltf);
    manager.updatePlayer({ player_id: 13, x: 10, z: 10, rotation: 0 });

    expect(manager.getCurrentClip(13)).toBe('Idle');

    const playedWave = manager.playAnimation(13, 'Wave');
    expect(playedWave).toBe(true);
    expect(manager.getCurrentClip(13)).toBe('Wave');

    const playedAngry = manager.playAnimation(13, 'Angry');
    expect(playedAngry).toBe(true);
    expect(manager.getCurrentClip(13)).toBe('Angry');

    const playedJump = manager.playAnimation(13, 'Jump');
    expect(playedJump).toBe(true);
    expect(manager.getCurrentClip(13)).toBe('Jump');
  });

  it('should dispose tourist model, mixer, and resources on removePlayer', () => {
    manager.setTouristTemplate(touristGltf);
    manager.updatePlayer({ player_id: 14, x: 15, z: 15, rotation: 0 });
    expect(manager.hasPlayer(14)).toBe(true);

    manager.removePlayer(14);
    expect(manager.hasPlayer(14)).toBe(false);
    expect(scene.children).toHaveLength(0);
  });
});
