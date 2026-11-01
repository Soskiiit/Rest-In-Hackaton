import * as THREE from 'three';

/**
 * Payload interface for remote player movement updates.
 * `login` comes with PLAYER_JOIN; PLAYER_MOVE carries only the transform.
 */
export interface PlayerMovePayload {
  player_id: number;
  x: number;
  z: number;
  rotation: number; // yaw angle in radians
  login?: string;
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
  name: string;
  accentHex: string;
  lastUpdated: number;
}

/**
 * Configuration options for OtherPlayerManager.
 */
export interface OtherPlayerManagerConfig {
  lerpSpeed: number; // interpolation speed factor
  teleportDistanceThreshold: number; // distance after which avatar snaps instead of lerping
  staleTimeoutMs: number; // prune remote players after inactivity (ms); Infinity = only PLAYER_LEAVE removes
}

export const DEFAULT_OTHER_PLAYER_CONFIG: OtherPlayerManagerConfig = {
  lerpSpeed: 12.0,
  teleportDistanceThreshold: 8.0,
  // The server sends PLAYER_MOVE only while a player moves and PLAYER_LEAVE when they go away,
  // so a player standing still must not be pruned.
  staleTimeoutMs: Infinity,
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

/** Placeholder avatar: a coloured stick with a small "nose" showing where the player looks. */
const STICK_SIZE = { width: 0.35, height: 1.7 };
const NAME_HEIGHT = 2.05;
const NAME_PENDING = '…';

/**
 * OtherPlayerManager: Manages placeholder avatars and nickname badges for remote players,
 * handles PLAYER_JOIN / PLAYER_MOVE updates, applies smooth position/rotation lerping,
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
   * Handles incoming PLAYER_JOIN / PLAYER_MOVE packet from server or mock engine.
   * Spawns new avatar if player_id is unknown, otherwise updates target position & rotation.
   */
  public updatePlayer(payload: PlayerMovePayload): void {
    const { player_id, x, z, rotation, login } = payload;
    let player = this.players.get(player_id);

    if (!player) {
      // Spawn new remote player avatar
      player = this.createPlayerAvatar(player_id, x, z, rotation, login);
      this.players.set(player_id, player);
      this.scene.add(player.group);
    } else {
      // Update target transform
      player.targetPosition.set(x, 0, z);
      player.targetRotation = rotation;
      player.lastUpdated = performance.now();
      if (login) {
        this.setPlayerName(player_id, login);
      }

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
   * Sets the nickname shown above a remote player's head.
   */
  public setPlayerName(playerId: number, login: string): void {
    const player = this.players.get(playerId);
    if (!player || player.name === login) return;
    player.name = login;
    this.drawNameBadge(player.nameSprite, login, player.accentHex);
  }

  /**
   * Returns the nickname currently shown above a remote player's head.
   */
  public getPlayerName(playerId: number): string | undefined {
    return this.players.get(playerId)?.name;
  }

  /**
   * Builds the placeholder avatar for a remote player: a stick plus a nose, and a nickname badge.
   */
  private createPlayerAvatar(id: number, x: number, z: number, rotation: number, login?: string): RemotePlayerState {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    group.name = `RemotePlayer_${id}`;

    // Pick unique accent color from palette based on player ID
    const accentColor = ACCENT_PALETTE[Math.abs(id) % ACCENT_PALETTE.length];
    const accentHex = '#' + accentColor.toString(16).padStart(6, '0');

    // 1. Stick body
    const stick = new THREE.Mesh(
      new THREE.BoxGeometry(STICK_SIZE.width, STICK_SIZE.height, STICK_SIZE.width),
      new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 0.25, roughness: 0.6 })
    );
    stick.position.y = STICK_SIZE.height / 2;
    stick.castShadow = true;
    stick.receiveShadow = true;
    group.add(stick);

    // 2. Nose on the -Z side (Three.js forward), so the facing direction is visible
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.5 })
    );
    nose.position.set(0, 1.45, -(STICK_SIZE.width / 2 + 0.08));
    group.add(nose);

    // 3. Overhead nickname badge
    const name = login || NAME_PENDING;
    const nameSprite = this.createNameBadge(name, accentHex);
    nameSprite.position.set(0, NAME_HEIGHT, 0);
    group.add(nameSprite);

    return {
      id,
      group,
      currentPosition: new THREE.Vector3(x, 0, z),
      targetPosition: new THREE.Vector3(x, 0, z),
      currentRotation: rotation,
      targetRotation: rotation,
      nameSprite,
      name,
      accentHex,
      lastUpdated: performance.now(),
    };
  }

  /**
   * Creates a billboarded Sprite for the nickname; drawn on top of the scene so stalls never hide it.
   */
  private createNameBadge(text: string, accentHex: string): THREE.Sprite {
    const material = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999;
    sprite.scale.set(1.8, 0.45, 1.0);
    this.drawNameBadge(sprite, text, accentHex);
    return sprite;
  }

  /**
   * (Re)draws a highlighted nickname: dark plate, glowing outline and glowing text in the player's colour.
   */
  private drawNameBadge(sprite: THREE.Sprite, text: string, accentHex: string): void {
    if (typeof document === 'undefined') return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The canvas is sized to the name, so the texture is never squeezed onto the sprite.
    const font = 'bold 48px system-ui, sans-serif';
    ctx.font = font;
    const textWidth = Math.min(ctx.measureText(text).width, 460);
    const margin = 14;
    const plateWidth = textWidth + 48;
    canvas.width = Math.ceil(plateWidth + margin * 2);
    canvas.height = 112;
    ctx.font = font; // resizing the canvas resets the context state

    ctx.fillStyle = 'rgba(12, 14, 22, 0.82)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(margin, 14, plateWidth, 84, 22);
    } else {
      ctx.rect(margin, 14, plateWidth, 84);
    }
    ctx.fill();

    ctx.shadowColor = accentHex;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 5;
    ctx.strokeStyle = accentHex;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, 58, plateWidth - 24);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    sprite.material.map?.dispose();
    sprite.material.map = texture;
    sprite.material.needsUpdate = true;
    // 0.5 m tall badge; wider names get a proportionally wider badge.
    const badgeHeight = 0.5;
    sprite.scale.set((canvas.width / canvas.height) * badgeHeight, badgeHeight, 1);
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
