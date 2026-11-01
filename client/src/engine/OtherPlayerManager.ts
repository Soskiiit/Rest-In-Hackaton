import * as THREE from 'three';

/**
 * Payload interface for remote player movement updates.
 */
export interface PlayerMovePayload {
  player_id: number;
  x: number;
  z: number;
  rotation: number; // yaw angle in radians
}

/**
 * Internal state for a single remote player avatar.
 */
interface RemotePlayerState {
  id: number;
  group: THREE.Group;
  currentPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  currentRotation: number;
  targetRotation: number;
  nameSprite: THREE.Sprite;
  lastUpdated: number;
}

/**
 * Configuration options for OtherPlayerManager.
 */
export interface OtherPlayerManagerConfig {
  lerpSpeed: number; // interpolation speed factor
  teleportDistanceThreshold: number; // distance after which avatar snaps instead of lerping
  staleTimeoutMs: number; // prune remote players after inactivity (ms)
}

export const DEFAULT_OTHER_PLAYER_CONFIG: OtherPlayerManagerConfig = {
  lerpSpeed: 12.0,
  teleportDistanceThreshold: 8.0,
  staleTimeoutMs: 60000,
};

// Cyberpunk neon accent palette for distinct remote players
const ACCENT_PALETTE: number[] = [
  0x00ffcc, // Cyan
  0xff0055, // Hot Pink
  0xffaa00, // Amber / Neon Orange
  0x00aaff, // Electric Blue
  0xaa00ff, // Purple
  0x00ff66, // Acid Green
];

/**
 * OtherPlayerManager: Manages 3D avatars for remote players,
 * handles PLAYER_MOVE packet updates, applies smooth position/rotation lerping,
 * and guarantees thorough GPU resource disposal.
 */
export class OtherPlayerManager {
  private readonly scene: THREE.Scene;
  private readonly config: OtherPlayerManagerConfig;
  private readonly players: Map<number, RemotePlayerState> = new Map();

  constructor(scene: THREE.Scene, config?: Partial<OtherPlayerManagerConfig>) {
    this.scene = scene;
    this.config = { ...DEFAULT_OTHER_PLAYER_CONFIG, ...config };
  }

  /**
   * Handles incoming PLAYER_MOVE packet from server or mock engine.
   * Spawns new avatar if player_id is unknown, otherwise updates target position & rotation.
   */
  public updatePlayer(payload: PlayerMovePayload): void {
    const { player_id, x, z, rotation } = payload;
    let player = this.players.get(player_id);

    if (!player) {
      // Spawn new remote player avatar
      player = this.createPlayerAvatar(player_id, x, z, rotation);
      this.players.set(player_id, player);
      this.scene.add(player.group);
    } else {
      // Update target transform
      player.targetPosition.set(x, 0, z);
      player.targetRotation = rotation;
      player.lastUpdated = performance.now();

      // If distant jump (e.g. teleport/respawn), snap immediately without lerping
      if (player.currentPosition.distanceTo(player.targetPosition) > this.config.teleportDistanceThreshold) {
        player.currentPosition.copy(player.targetPosition);
        player.currentRotation = player.targetRotation;
        player.group.position.copy(player.currentPosition);
        player.group.rotation.y = player.currentRotation;
      }
    }
  }

  /**
   * Builds stylized 3D avatar mesh group for a remote player.
   */
  private createPlayerAvatar(id: number, x: number, z: number, rotation: number): RemotePlayerState {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;

    // Pick unique accent color from palette based on player ID
    const accentColor = ACCENT_PALETTE[Math.abs(id) % ACCENT_PALETTE.length];
    const accentHex = '#' + accentColor.toString(16).padStart(6, '0');

    // 1. Torso / Body (Dark cyberpunk jacket / robe)
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.9, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1f2233,
      roughness: 0.45,
      metalness: 0.6,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0.85;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    // 2. Neon trim ring around torso
    const trimGeo = new THREE.TorusGeometry(0.36, 0.03, 8, 24);
    const trimMat = new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 0.9,
    });
    const trimMesh = new THREE.Mesh(trimGeo, trimMat);
    trimMesh.rotation.x = Math.PI / 2;
    trimMesh.position.y = 0.8;
    group.add(trimMesh);

    // 3. Head
    const headGeo = new THREE.SphereGeometry(0.24, 16, 16);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x303445,
      roughness: 0.5,
      metalness: 0.2,
    });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = 1.45;
    headMesh.castShadow = true;
    group.add(headMesh);

    // 4. Glowing Cyberpunk Visor (placed on -Z facing Three.js forward direction)
    const visorGeo = new THREE.BoxGeometry(0.3, 0.1, 0.16);
    const visorMat = new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 1.6,
      roughness: 0.2,
    });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 1.46, -0.16);
    group.add(visorMesh);

    // 5. Overhead floating Name Badge / Tag
    const nameSprite = this.createNameBadge(`Player #${id}`, accentHex);
    nameSprite.position.set(0, 1.95, 0);
    group.add(nameSprite);

    return {
      id,
      group,
      currentPosition: new THREE.Vector3(x, 0, z),
      targetPosition: new THREE.Vector3(x, 0, z),
      currentRotation: rotation,
      targetRotation: rotation,
      nameSprite,
      lastUpdated: performance.now(),
    };
  }

  /**
   * Creates a billboarded Sprite rendering a cyberpunk nameplate.
   */
  private createNameBadge(text: string, accentHex: string): THREE.Sprite {
    if (typeof document === 'undefined') {
      const material = new THREE.SpriteMaterial({ transparent: true });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(1.8, 0.45, 1.0);
      return sprite;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // Background translucent box
      ctx.fillStyle = 'rgba(15, 18, 28, 0.85)';
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(4, 4, 248, 56, 10);
      } else {
        ctx.rect(4, 4, 248, 56);
      }
      ctx.fill();

      // Neon outline
      ctx.lineWidth = 3;
      ctx.strokeStyle = accentHex;
      ctx.stroke();

      // Text label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px monospace, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 33);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.8, 0.45, 1.0);
    return sprite;
  }

  /**
   * Per-frame update hook: interpolates avatar position and rotation towards targets.
   */
  public update(delta: number): void {
    const lerpFactor = Math.min(1.0, delta * this.config.lerpSpeed);
    const now = performance.now();
    const staleIds: number[] = [];

    for (const [id, player] of this.players) {
      // 1. Position interpolation
      player.currentPosition.lerp(player.targetPosition, lerpFactor);
      player.group.position.copy(player.currentPosition);

      // 2. Shortest angular distance rotation interpolation around Y
      let diff = player.targetRotation - player.currentRotation;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      player.currentRotation += diff * lerpFactor;
      player.group.rotation.y = player.currentRotation;

      // 3. Stale player check
      if (now - player.lastUpdated > this.config.staleTimeoutMs) {
        staleIds.push(id);
      }
    }

    // Prune stale players if any
    for (const id of staleIds) {
      this.removePlayer(id);
    }
  }

  /**
   * Removes a player avatar and thoroughly cleans up GPU geometries, materials, and textures.
   */
  public removePlayer(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.scene.remove(player.group);

    // Deep disposal
    player.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      } else if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    });

    this.players.delete(playerId);
  }

  /**
   * Checks whether a player avatar exists.
   */
  public hasPlayer(playerId: number): boolean {
    return this.players.has(playerId);
  }

  /**
   * Returns current count of active remote players.
   */
  public getPlayerCount(): number {
    return this.players.size;
  }

  /**
   * Clears and disposes all remote player avatars.
   */
  public clear(): void {
    const ids = Array.from(this.players.keys());
    for (const id of ids) {
      this.removePlayer(id);
    }
  }

  /**
   * Full cleanup on manager disposal.
   */
  public dispose(): void {
    this.clear();
  }
}
