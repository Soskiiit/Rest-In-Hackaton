import * as THREE from 'three';
import {
  getTouristTemplate,
  setTouristTemplate,
  loadTouristTemplate,
  createTouristAvatarInstance,
  type TouristAvatarInstance,
} from './TouristModel';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
export interface RemotePlayerState {
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

  // Fallback stick placeholder meshes (used before comical tourist GLTF is loaded)
  stickMesh?: THREE.Mesh;
  noseMesh?: THREE.Mesh;

  // Animated comical tourist instance
  tourist?: TouristAvatarInstance;
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
const NAME_HEIGHT = 2.25; // 2.25m ensures clear float above comical tourist's panama hat (~2.03m)
const NAME_PENDING = '…';

/**
 * OtherPlayerManager: Manages 3D avatars (comical tourist model with animations)
 * and nickname badges for remote players in multiplayer, handles PLAYER_JOIN / PLAYER_MOVE updates,
 * applies smooth position/rotation lerping, and guarantees thorough GPU resource disposal.
 */
export class OtherPlayerManager {
  private readonly scene: THREE.Scene;
  private readonly config: OtherPlayerManagerConfig;
  private readonly players: Map<number, RemotePlayerState> = new Map();
  private modelLoadPromise: Promise<GLTF | null> | null = null;

  constructor(scene: THREE.Scene, config?: Partial<OtherPlayerManagerConfig>) {
    this.scene = scene;
    this.config = { ...DEFAULT_OTHER_PLAYER_CONFIG, ...config };

    // Trigger async load of the comical tourist model template
    void this.loadModel();
  }

  /**
   * Loads or gets cached comical tourist model template and applies it to all existing players.
   */
  public async loadModel(): Promise<GLTF | null> {
    if (this.modelLoadPromise) {
      return this.modelLoadPromise;
    }
    this.modelLoadPromise = (async () => {
      try {
        const gltf = await loadTouristTemplate();
        if (gltf) {
          this.applyTouristModelToAllPlayers();
        }
        return gltf;
      } catch (err) {
        console.warn('[OtherPlayerManager] Failed to load comical tourist model:', err);
        return null;
      }
    })();
    return this.modelLoadPromise;
  }

  /**
   * Allows supplying a parsed GLTF template directly (e.g. in unit tests or preloaded cache).
   */
  public setTouristTemplate(gltf: GLTF | null): void {
    setTouristTemplate(gltf);
    if (gltf) {
      this.applyTouristModelToAllPlayers();
    }
  }

  /**
   * Replaces fallback stick meshes with the animated comical tourist model on all active players.
   */
  private applyTouristModelToAllPlayers(): void {
    const template = getTouristTemplate();
    if (!template) return;

    for (const [, player] of this.players) {
      this.attachTouristToPlayer(player, template);
    }
  }

  /**
   * Attaches the comical tourist avatar instance to a player, removing placeholder meshes if present.
   */
  private attachTouristToPlayer(player: RemotePlayerState, template: GLTF): void {
    if (player.tourist) return;

    // Clean up fallback stick & nose if present
    if (player.stickMesh) {
      player.group.remove(player.stickMesh);
      player.stickMesh.geometry?.dispose();
      if (Array.isArray(player.stickMesh.material)) {
        player.stickMesh.material.forEach((m) => m.dispose());
      } else if (player.stickMesh.material) {
        player.stickMesh.material.dispose();
      }
      delete player.stickMesh;
    }

    if (player.noseMesh) {
      player.group.remove(player.noseMesh);
      player.noseMesh.geometry?.dispose();
      if (Array.isArray(player.noseMesh.material)) {
        player.noseMesh.material.forEach((m) => m.dispose());
      } else if (player.noseMesh.material) {
        player.noseMesh.material.dispose();
      }
      delete player.noseMesh;
    }

    // Instantiate comical tourist with full animations
    player.tourist = createTouristAvatarInstance(template);
    player.group.add(player.tourist.root);
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
   * Triggers an animation clip by name (e.g. 'Wave', 'Angry', 'Jump', 'FallBack', 'Run', 'Walk', 'Idle')
   * on a specific player avatar.
   */
  public playAnimation(playerId: number, clipName: string, fadeDuration = 0.2): boolean {
    const player = this.players.get(playerId);
    if (!player?.tourist) return false;

    if (clipName === 'Idle' || clipName === 'Walk' || clipName === 'Run') {
      player.tourist.isActionLocked = false;
      player.tourist.playClip(clipName, fadeDuration);
    } else {
      player.tourist.playAction(clipName, fadeDuration);
    }
    return true;
  }

  /**
   * Gets the name of the currently active animation clip on a player avatar.
   */
  public getCurrentClip(playerId: number): string | undefined {
    return this.players.get(playerId)?.tourist?.currentClip;
  }

  /**
   * Gets available animation clip names for a player avatar.
   */
  public getPlayerClips(playerId: number): string[] {
    const player = this.players.get(playerId);
    if (!player?.tourist) return [];
    return Array.from(player.tourist.actions.keys());
  }

  /**
   * Builds the avatar for a remote player: comical tourist model (or fallback stick if model not loaded yet),
   * and a billboard nickname badge.
   */
  private createPlayerAvatar(id: number, x: number, z: number, rotation: number, login?: string): RemotePlayerState {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    group.name = `RemotePlayer_${id}`;

    // Pick unique accent color from palette based on player ID
    const accentColor = ACCENT_PALETTE[Math.abs(id) % ACCENT_PALETTE.length];
    const accentHex = '#' + accentColor.toString(16).padStart(6, '0');

    const state: RemotePlayerState = {
      id,
      group,
      currentPosition: new THREE.Vector3(x, 0, z),
      targetPosition: new THREE.Vector3(x, 0, z),
      currentRotation: rotation,
      targetRotation: rotation,
      nameSprite: null as any,
      name: login || NAME_PENDING,
      accentHex,
      lastUpdated: performance.now(),
    };

    // If comical tourist template is already ready, instantiate it immediately!
    const template = getTouristTemplate();
    if (template) {
      this.attachTouristToPlayer(state, template);
    } else {
      // 1. Fallback stick body
      const stick = new THREE.Mesh(
        new THREE.BoxGeometry(STICK_SIZE.width, STICK_SIZE.height, STICK_SIZE.width),
        new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 0.25, roughness: 0.6 })
      );
      stick.position.y = STICK_SIZE.height / 2;
      stick.castShadow = true;
      stick.receiveShadow = true;
      group.add(stick);
      state.stickMesh = stick;

      // 2. Nose on the -Z side (Three.js forward), so the facing direction is visible
      const nose = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.14, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.5 })
      );
      nose.position.set(0, 1.45, -(STICK_SIZE.width / 2 + 0.08));
      group.add(nose);
      state.noseMesh = nose;
    }

    // 3. Overhead nickname badge (elevated to float above tourist's panama hat)
    const name = login || NAME_PENDING;
    const nameSprite = this.createNameBadge(name, accentHex);
    nameSprite.position.set(0, NAME_HEIGHT, 0);
    group.add(nameSprite);
    state.nameSprite = nameSprite;

    return state;
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
   * Per-frame update hook: interpolates avatar position and rotation towards targets,
   * updates comical tourist walk/run/idle animation states, and ticks animation mixers.
   */
  public update(delta: number): void {
    const lerpFactor = Math.min(1.0, delta * this.config.lerpSpeed);
    const now = performance.now();
    const staleIds: number[] = [];

    for (const [id, player] of this.players) {
      const prevX = player.currentPosition.x;
      const prevZ = player.currentPosition.z;

      // 1. Position interpolation
      player.currentPosition.lerp(player.targetPosition, lerpFactor);
      player.group.position.copy(player.currentPosition);

      // 2. Shortest angular distance rotation interpolation around Y
      let diff = player.targetRotation - player.currentRotation;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      player.currentRotation += diff * lerpFactor;
      player.group.rotation.y = player.currentRotation;

      // 3. Comical tourist animation updates based on movement speed
      if (player.tourist) {
        const distMoved = Math.hypot(player.currentPosition.x - prevX, player.currentPosition.z - prevZ);
        const distToTarget = Math.hypot(
          player.targetPosition.x - player.currentPosition.x,
          player.targetPosition.z - player.currentPosition.z
        );
        const currentSpeed = delta > 0 ? distMoved / delta : 0;

        if (!player.tourist.isActionLocked) {
          // Sprint threshold: > 7 m/s (or closing a distant teleport/sprint gap)
          if (currentSpeed > 7.0 || (distToTarget > 2.0 && currentSpeed > 4.0)) {
            player.tourist.playClip('Run', 0.2);
          } else if (currentSpeed > 0.12 || distToTarget > 0.05) {
            player.tourist.playClip('Walk', 0.2);
          } else {
            player.tourist.playClip('Idle', 0.25);
          }
        }

        player.tourist.update(delta);
      }

      // 4. Stale player check
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

    if (player.tourist) {
      player.tourist.dispose();
      delete player.tourist;
    }

    // Deep disposal of remaining meshes, sprites and materials
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
