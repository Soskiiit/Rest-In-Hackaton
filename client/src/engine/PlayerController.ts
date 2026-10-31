import * as THREE from 'three';

/**
 * Configuration options for PlayerController.
 */
export interface PlayerControllerConfig {
  walkSpeed: number;
  sprintSpeed: number;
  eyeHeight: number;
  mouseSensitivity: number;
  maxPitch: number; // in radians, e.g. ~1.48 (85 degrees)
  minBoundX: number;
  maxBoundX: number;
  minBoundZ: number;
  maxBoundZ: number;
  playerRadius: number;
  damping: number; // friction/damping factor
  spawnPosition: { x: number; y: number; z: number };
}

export const DEFAULT_PLAYER_CONFIG: PlayerControllerConfig = {
  walkSpeed: 6.0,
  sprintSpeed: 10.5,
  eyeHeight: 1.7,
  mouseSensitivity: 0.002,
  maxPitch: 1.48, // 85 deg
  minBoundX: 1.0,
  maxBoundX: 199.0,
  minBoundZ: 1.0,
  maxBoundZ: 199.0,
  playerRadius: 0.5,
  damping: 12.0,
  spawnPosition: { x: 100, y: 0, z: 100 },
};

/**
 * PlayerController: Controls player movement (WASD), PointerLock mouse look,
 * boundary clamping, wall sliding collision detection, and UI modal input locking.
 */
export class PlayerController {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly domElement: HTMLElement;
  public readonly config: PlayerControllerConfig;

  // Position and velocity
  public readonly position: THREE.Vector3;
  private readonly velocity: THREE.Vector3 = new THREE.Vector3();
  private readonly euler: THREE.Euler = new THREE.Euler(0, 0, 0, 'YXZ');

  // Input states
  private keys: Record<string, boolean> = {};
  private isPointerLocked: boolean = false;
  private isInputLocked: boolean = false;
  private unlockCallbacks: Array<() => void> = [];
  private lockCallbacks: Array<() => void> = [];

  // Perspective mode (First vs Third person)
  private isThirdPerson: boolean = false;
  private thirdPersonDistance: number = 3.5;
  private localAvatarGroup: THREE.Group | null = null;

  // Collision obstacles (Axis-Aligned Bounding Boxes)
  private obstacles: THREE.Box3[] = [];

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    config?: Partial<PlayerControllerConfig>
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.config = { ...DEFAULT_PLAYER_CONFIG, ...config };

    this.position = new THREE.Vector3(
      this.config.spawnPosition.x,
      this.config.spawnPosition.y,
      this.config.spawnPosition.z
    );

    // Initial camera position & orientation
    this.camera.position.set(this.position.x, this.position.y + this.config.eyeHeight, this.position.z);
    this.euler.setFromQuaternion(this.camera.quaternion);

    // Bind event listeners
    this.bindEvents();
  }

  /**
   * Optional helper to attach a local avatar mesh for third-person rendering.
   */
  public attachLocalAvatar(scene: THREE.Scene): THREE.Group {
    const group = new THREE.Group();

    // Stylized capsule body
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.9, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1f2233,
      roughness: 0.4,
      metalness: 0.7,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0.85;
    bodyMesh.castShadow = true;
    group.add(bodyMesh);

    // Neon accent belt
    const beltGeo = new THREE.TorusGeometry(0.36, 0.03, 8, 24);
    const beltMat = new THREE.MeshStandardMaterial({
      color: 0x00ffcc,
      emissive: 0x00ffcc,
      emissiveIntensity: 0.8,
    });
    const belt = new THREE.Mesh(beltGeo, beltMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.8;
    group.add(belt);

    // Head
    const headGeo = new THREE.SphereGeometry(0.24, 16, 16);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x3a3f55, roughness: 0.5 });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = 1.45;
    headMesh.castShadow = true;
    group.add(headMesh);

    // Cyan visor (facing -Z to match Three.js forward)
    const visorGeo = new THREE.BoxGeometry(0.3, 0.1, 0.16);
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 1.5,
    });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 1.46, -0.16);
    group.add(visorMesh);

    group.visible = this.isThirdPerson;
    scene.add(group);
    this.localAvatarGroup = group;
    return group;
  }

  /**
   * Binds pointer lock, mouse move, and keyboard listeners.
   */
  private bindEvents(): void {
    this.domElement.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onClick = (): void => {
    if (!this.isInputLocked && !this.isPointerLocked) {
      this.domElement.requestPointerLock();
    }
  };

  private onPointerLockChange = (): void => {
    const wasLocked = this.isPointerLocked;
    this.isPointerLocked = document.pointerLockElement === this.domElement;
    if (wasLocked && !this.isPointerLocked) {
      this.unlockCallbacks.forEach((fn) => fn());
    } else if (!wasLocked && this.isPointerLocked) {
      this.lockCallbacks.forEach((fn) => fn());
    }
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.isPointerLocked || this.isInputLocked) return;

    const movementX = event.movementX || 0;
    const movementY = event.movementY || 0;

    // Pitch & Yaw updates
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.y -= movementX * this.config.mouseSensitivity;
    this.euler.x -= movementY * this.config.mouseSensitivity;

    // Clamp pitch to prevent camera flips
    this.euler.x = Math.max(-this.config.maxPitch, Math.min(this.config.maxPitch, this.euler.x));

    this.camera.quaternion.setFromEuler(this.euler);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.isInputLocked) return;
    this.keys[event.code] = true;

    // Toggle perspective with 'KeyV'
    if (event.code === 'KeyV') {
      this.setThirdPerson(!this.isThirdPerson);
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys[event.code] = false;
  };

  /**
   * Registers a callback fired when the pointer is unlocked (e.g. user presses Esc).
   */
  public onUnlock(fn: () => void): () => void {
    this.unlockCallbacks.push(fn);
    return () => {
      const idx = this.unlockCallbacks.indexOf(fn);
      if (idx !== -1) this.unlockCallbacks.splice(idx, 1);
    };
  }

  /**
   * Registers a callback fired when pointer lock is engaged.
   */
  public onLock(fn: () => void): () => void {
    this.lockCallbacks.push(fn);
    return () => {
      const idx = this.lockCallbacks.indexOf(fn);
      if (idx !== -1) this.lockCallbacks.splice(idx, 1);
    };
  }

  /**
   * Locks or unlocks all player input (WASD + mouse look).
   * Used when modal dialogues (DialogueUI) or quizzes (QuizPanel) open.
   */
  public setLocked(locked: boolean): void {
    this.isInputLocked = locked;
    if (locked) {
      // Clear movement keys and velocity immediately
      this.keys = {};
      this.velocity.set(0, 0, 0);

      // Release PointerLock if held
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    }
  }

  /**
   * Alias for setLocked (matching main.ts modal coordination).
   */
  public setModalActive(active: boolean): void {
    this.setLocked(active);
  }

  /**
   * Unlocks player input.
   */
  public unlock(): void {
    this.setLocked(false);
  }

  /**
   * Requests browser pointer lock on the controller's DOM element.
   */
  public requestPointerLock(): void {
    if (!this.isInputLocked) {
      this.domElement.requestPointerLock();
    }
  }

  /**
   * Releases browser pointer lock.
   */
  public exitPointerLock(): void {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  /**
   * Gets the camera associated with this controller.
   */
  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Returns whether player input is currently locked.
   */
  public isLocked(): boolean {
    return this.isInputLocked;
  }

  /**
   * Returns whether pointer lock is currently active.
   */
  public getIsPointerLocked(): boolean {
    return this.isPointerLocked;
  }

  /**
   * Toggles third-person vs first-person perspective.
   */
  public setThirdPerson(enabled: boolean): void {
    this.isThirdPerson = enabled;
    if (this.localAvatarGroup) {
      this.localAvatarGroup.visible = enabled;
    }
  }

  /**
   * Sets the active obstacles list.
   */
  public setObstacles(boxes: THREE.Box3[]): void {
    this.obstacles = boxes;
  }

  /**
   * Adds an obstacle bounding box for collision testing.
   */
  public addObstacle(box: THREE.Box3): void {
    this.obstacles.push(box);
  }

  /**
   * Clears all collision obstacles.
   */
  public clearObstacles(): void {
    this.obstacles = [];
  }

  /**
   * Checks whether a point (x, z) collides with registered obstacles or street walls.
   */
  private checkCollision(x: number, z: number): boolean {
    const r = this.config.playerRadius;

    // Obstacles collision (including dynamically synced wall bounding boxes)
    const playerBox = new THREE.Box3(
      new THREE.Vector3(x - r, 0, z - r),
      new THREE.Vector3(x + r, this.config.eyeHeight, z + r)
    );

    for (const obstacle of this.obstacles) {
      if (playerBox.intersectsBox(obstacle)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Main per-frame update routine: handles WASD input, acceleration, damping,
   * wall collision sliding, boundary clamping, and camera positioning.
   */
  public update(delta: number): void {
    // 1. Calculate horizontal camera forward and right vectors
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    // 2. Compute input direction vector
    const inputDir = new THREE.Vector3();
    if (!this.isInputLocked) {
      if (this.keys['KeyW'] || this.keys['ArrowUp']) inputDir.add(forward);
      if (this.keys['KeyS'] || this.keys['ArrowDown']) inputDir.sub(forward);
      if (this.keys['KeyD'] || this.keys['ArrowRight']) inputDir.add(right);
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) inputDir.sub(right);
    }

    if (inputDir.lengthSq() > 0) {
      inputDir.normalize();
    }

    // 3. Determine target speed (sprint vs walk)
    const isSprinting = Boolean(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const targetSpeed = isSprinting ? this.config.sprintSpeed : this.config.walkSpeed;
    const targetVelocity = inputDir.multiplyScalar(targetSpeed);

    // 4. Smooth velocity lerp with damping
    const lerpFactor = Math.min(1.0, delta * this.config.damping);
    this.velocity.lerp(targetVelocity, lerpFactor);

    // 5. Test movement with separate X and Z collision tests (allows wall sliding)
    const nextX = Math.max(
      this.config.minBoundX,
      Math.min(this.config.maxBoundX, this.position.x + this.velocity.x * delta)
    );
    const nextZ = Math.max(
      this.config.minBoundZ,
      Math.min(this.config.maxBoundZ, this.position.z + this.velocity.z * delta)
    );

    // Test X collision
    if (!this.checkCollision(nextX, this.position.z)) {
      this.position.x = nextX;
    } else {
      this.velocity.x = 0;
    }

    // Test Z collision
    if (!this.checkCollision(this.position.x, nextZ)) {
      this.position.z = nextZ;
    } else {
      this.velocity.z = 0;
    }

    // 6. Update camera & avatar positions
    if (this.isThirdPerson) {
      // Third person: position camera behind player
      const camOffset = forward.clone().multiplyScalar(-this.thirdPersonDistance);
      this.camera.position.set(
        this.position.x + camOffset.x,
        this.position.y + this.config.eyeHeight + 0.6,
        this.position.z + camOffset.z
      );

      if (this.localAvatarGroup) {
        this.localAvatarGroup.position.set(this.position.x, this.position.y, this.position.z);
        this.localAvatarGroup.rotation.y = this.euler.y;
      }
    } else {
      // First person: position camera at eye height
      this.camera.position.set(this.position.x, this.position.y + this.config.eyeHeight, this.position.z);
    }
  }

  /**
   * Gets current player position in world coordinates [0, 200].
   */
  public getPosition(): { x: number; y: number; z: number } {
    return { x: this.position.x, y: this.position.y, z: this.position.z };
  }

  /**
   * Sets player position directly.
   */
  public setPosition(x: number, y: number, z: number): void {
    this.position.set(
      Math.max(this.config.minBoundX, Math.min(this.config.maxBoundX, x)),
      y,
      Math.max(this.config.minBoundZ, Math.min(this.config.maxBoundZ, z))
    );
    this.camera.position.set(this.position.x, this.position.y + this.config.eyeHeight, this.position.z);
  }

  /**
   * Gets current horizontal look yaw in radians (matching MovePayload.rotation).
   */
  public getYaw(): number {
    return this.euler.y;
  }

  /**
   * Alias for getYaw (matching main.ts position transmission).
   */
  public getRotationY(): number {
    return this.euler.y;
  }

  /**
   * Checks whether the player has moved or turned significantly since last check.
   */
  public hasMovedSince(lastX: number, lastZ: number, lastYaw: number, threshold: number = 0.05): boolean {
    const dx = this.position.x - lastX;
    const dz = this.position.z - lastZ;
    const dyaw = Math.abs(this.euler.y - lastYaw);
    return dx * dx + dz * dz > threshold * threshold || dyaw > threshold;
  }

  /**
   * Clean up all event listeners and DOM attachments.
   */
  public dispose(): void {
    this.setLocked(true);
    this.domElement.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);

    if (this.localAvatarGroup && this.localAvatarGroup.parent) {
      this.localAvatarGroup.parent.remove(this.localAvatarGroup);
    }
  }
}
