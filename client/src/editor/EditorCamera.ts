import * as THREE from 'three';

export interface EditorCameraConfig {
  baseMoveSpeed: number;        // Default fly speed in m/s (default: 15.0)
  shiftMultiplier: number;      // Sprint boost multiplier (default: 2.5)
  altMultiplier: number;        // Precision creep multiplier (default: 0.3)
  minSpeed: number;             // Minimum speed clamp (default: 1.0 m/s)
  maxSpeed: number;             // Maximum speed clamp (default: 100.0 m/s)
  mouseSensitivity: number;     // Look sensitivity in rad/px (default: 0.003)
  maxPitch: number;             // Max upward pitch in radians (~88.8 deg)
  minPitch: number;             // Max downward pitch in radians (~-88.8 deg)
  damping: number;              // Velocity damping factor (default: 0 for instant responsive delta)
  wheelStep: number;            // Geometric multiplier for wheel zoom (default: 1.15)
  minAltitude: number;          // Floor collision clamp for camera Y (default: 0.2)
  maxAltitude: number;          // Sky ceiling clamp for camera Y (default: 300.0)
}

export const DEFAULT_EDITOR_CAMERA_CONFIG: EditorCameraConfig = {
  baseMoveSpeed: 15.0,
  shiftMultiplier: 2.5,
  altMultiplier: 0.3,
  minSpeed: 1.0,
  maxSpeed: 100.0,
  mouseSensitivity: 0.003,
  maxPitch: Math.PI / 2 - 0.02,
  minPitch: -(Math.PI / 2 - 0.02),
  damping: 0,
  wheelStep: 1.15,
  minAltitude: 0.2,
  maxAltitude: 300.0,
};

export interface FocusTarget {
  position: THREE.Vector3;
  distance?: number;
}

export type FocusTargetProvider = () => FocusTarget | null;

/**
 * EditorCamera: Digital Content Creation (DCC) style free camera navigation.
 * Controls world.getCamera() in Editor mode with:
 * - Planar WASD navigation projected onto the horizontal XZ plane
 * - Vertical altitude flight via Q (down) and E (up)
 * - Right-click mouse drag look (pitch clamped +-88.8 deg, yaw unbounded)
 * - Left-click untouched for object picking and gizmo manipulation
 * - Shift (2.5x) and Alt (0.3x) speed multipliers + mouse wheel speed scaling
 * - Framing helper (focusOn) and 'F' key hotkey
 * - Stuck-key immunity on blur/visibilitychange/mouseleave
 */
export class EditorCamera {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly domElement: HTMLElement;
  public readonly config: EditorCameraConfig;

  private enabled: boolean = false;
  private _isLookPaused: boolean = false;
  private _isInputLocked: boolean = false;

  private baseSpeed: number;
  private readonly velocity: THREE.Vector3 = new THREE.Vector3();
  private readonly euler: THREE.Euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private pitch: number = 0;
  private yaw: number = 0;

  private isRightMouseDown: boolean = false;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;

  private readonly keys: Record<string, boolean> = {};
  private speedChangeCallbacks: Array<(speed: number) => void> = [];
  private focusTargetProvider: FocusTargetProvider | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    config?: Partial<EditorCameraConfig>
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.config = { ...DEFAULT_EDITOR_CAMERA_CONFIG, ...config };
    this.baseSpeed = this.config.baseMoveSpeed;

    this.syncFromCamera();
  }

  public enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.syncFromCamera();
    this.bindEvents();
  }

  public disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this._isLookPaused = false;
    this.resetInputState();
    this.unbindEvents();
  }

  public dispose(): void {
    this.disable();
    this.speedChangeCallbacks = [];
    this.focusTargetProvider = null;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public syncFromCamera(): void {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = this.euler.x;
    this.yaw = this.euler.y;
    this.velocity.set(0, 0, 0);
  }

  public getPosition(): THREE.Vector3 {
    return this.camera.position.clone();
  }

  public setPosition(pos: THREE.Vector3): void {
    this.camera.position.copy(pos);
  }

  public setRotation(yaw: number, pitch: number = 0): void {
    this.yaw = yaw;
    this.pitch = Math.max(this.config.minPitch, Math.min(this.config.maxPitch, pitch));
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.camera.rotation);
  }

  public lookAt(target: THREE.Vector3): void {
    this.camera.lookAt(target);
    this.syncFromCamera();
  }

  public getSpeed(): number {
    return this.baseSpeed;
  }

  public setSpeed(speed: number): void {
    this.baseSpeed = Math.max(this.config.minSpeed, Math.min(this.config.maxSpeed, speed));
    this.notifySpeedChange();
  }

  public onSpeedChange(callback: (speed: number) => void): () => void {
    this.speedChangeCallbacks.push(callback);
    return () => {
      const idx = this.speedChangeCallbacks.indexOf(callback);
      if (idx !== -1) this.speedChangeCallbacks.splice(idx, 1);
    };
  }

  private notifySpeedChange(): void {
    this.speedChangeCallbacks.forEach((cb) => cb(this.baseSpeed));
  }

  public setFocusTargetProvider(provider: FocusTargetProvider | null): void {
    this.focusTargetProvider = provider;
  }

  public focusOn(target: THREE.Vector3, distance?: number): void {
    const dist = distance && distance > 0 ? distance : 6.0;
    const toCam = this.camera.position.clone().sub(target);
    let camOffset: THREE.Vector3;

    if (toCam.lengthSq() > 0.001) {
      camOffset = toCam.normalize().multiplyScalar(dist);
    } else {
      camOffset = new THREE.Vector3(0, dist * 0.5, dist).normalize().multiplyScalar(dist);
    }

    this.camera.position.copy(target.clone().add(camOffset));
    this.camera.lookAt(target);
    this.syncFromCamera();
    this.velocity.set(0, 0, 0);
  }

  public setLookPaused(paused: boolean): void {
    this._isLookPaused = paused;
    if (paused) {
      this.isRightMouseDown = false;
    }
  }

  public isLookPaused(): boolean {
    return this._isLookPaused;
  }

  public setInputLocked(locked: boolean): void {
    this._isInputLocked = locked;
    if (locked) {
      this.resetInputState();
    }
  }

  public isInputLocked(): boolean {
    return this._isInputLocked;
  }

  public resetInputState(): void {
    for (const k in this.keys) {
      delete this.keys[k];
    }
    this.isRightMouseDown = false;
    this._isLookPaused = false;
    this.velocity.set(0, 0, 0);
  }

  public update(delta: number): void {
    if (!this.enabled) return;
    if (!Number.isFinite(delta) || delta <= 0) return;

    // Planar forward & right vectors on XZ plane
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (!this._isInputLocked) {
      if (this.keys['KeyW'] || this.keys['ArrowUp']) moveDir.add(forward);
      if (this.keys['KeyS'] || this.keys['ArrowDown']) moveDir.sub(forward);
      if (this.keys['KeyD'] || this.keys['ArrowRight']) moveDir.add(right);
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) moveDir.sub(right);
      if (this.keys['KeyE']) moveDir.y += 1;
      if (this.keys['KeyQ']) moveDir.y -= 1;
    }

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
    }

    // Speed scaling
    let multiplier = 1.0;
    const isShift = Boolean(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const isAltOrCtrl = Boolean(
      this.keys['AltLeft'] || this.keys['AltRight'] ||
      this.keys['ControlLeft'] || this.keys['ControlRight']
    );

    if (isShift && !isAltOrCtrl) {
      multiplier = this.config.shiftMultiplier;
    } else if (isAltOrCtrl && !isShift) {
      multiplier = this.config.altMultiplier;
    } else if (isShift && isAltOrCtrl) {
      multiplier = this.config.shiftMultiplier * this.config.altMultiplier;
    }

    const targetVelocity = moveDir.multiplyScalar(this.baseSpeed * multiplier);

    if (this.config.damping > 0) {
      const lerpFactor = Math.min(1.0, delta * this.config.damping);
      this.velocity.lerp(targetVelocity, lerpFactor);
    } else {
      this.velocity.copy(targetVelocity);
    }

    this.camera.position.addScaledVector(this.velocity, delta);

    // Altitude clamp
    this.camera.position.y = Math.max(
      this.config.minAltitude,
      Math.min(this.config.maxAltitude, this.camera.position.y)
    );
  }

  private bindEvents(): void {
    this.domElement.addEventListener('mousedown', this.onMouseDown);
    this.domElement.addEventListener('mouseup', this.onMouseUp);
    this.domElement.addEventListener('mousemove', this.onMouseMove);
    this.domElement.addEventListener('wheel', this.onWheel as EventListener, { passive: false });
    this.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.domElement.addEventListener('keydown', this.onKeyDown as EventListener);
    this.domElement.addEventListener('keyup', this.onKeyUp as EventListener);
    this.domElement.addEventListener('blur', this.onWindowBlur);

    if (typeof window !== 'undefined' && (window as any) !== this.domElement) {
      window.addEventListener('mouseup', this.onMouseUp);
      window.addEventListener('mousemove', this.onMouseMove);
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onWindowBlur);
      window.addEventListener('mouseleave', this.onMouseLeave);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private unbindEvents(): void {
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    this.domElement.removeEventListener('mouseup', this.onMouseUp);
    this.domElement.removeEventListener('mousemove', this.onMouseMove);
    this.domElement.removeEventListener('wheel', this.onWheel as EventListener);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.domElement.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.domElement.removeEventListener('keyup', this.onKeyUp as EventListener);
    this.domElement.removeEventListener('blur', this.onWindowBlur);

    if (typeof window !== 'undefined' && (window as any) !== this.domElement) {
      window.removeEventListener('mouseup', this.onMouseUp);
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onWindowBlur);
      window.removeEventListener('mouseleave', this.onMouseLeave);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private isInputElement(target: any): boolean {
    if (!target || !target.tagName) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName);
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.enabled || this._isInputLocked) return;
    if (event.button === 2) {
      if (this._isLookPaused) return;
      this.isRightMouseDown = true;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
    }
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) {
      this.isRightMouseDown = false;
    }
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.isRightMouseDown || this._isLookPaused || this._isInputLocked) {
      return;
    }

    const movementX = event.movementX !== undefined && event.movementX !== 0
      ? event.movementX
      : (event.clientX !== undefined ? event.clientX - this.lastMouseX : 0);
    const movementY = event.movementY !== undefined && event.movementY !== 0
      ? event.movementY
      : (event.clientY !== undefined ? event.clientY - this.lastMouseY : 0);

    if (event.clientX !== undefined) this.lastMouseX = event.clientX;
    if (event.clientY !== undefined) this.lastMouseY = event.clientY;

    this.yaw -= movementX * this.config.mouseSensitivity;
    this.pitch -= movementY * this.config.mouseSensitivity;
    this.pitch = Math.max(this.config.minPitch, Math.min(this.config.maxPitch, this.pitch));

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.camera.rotation);
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled || this._isInputLocked) return;
    if (event.target && (event.target as HTMLElement).closest?.('.scrollable, .inspector-panel, .catalog-panel')) {
      return;
    }
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    if (event.deltaY < 0) {
      this.baseSpeed = Math.min(this.config.maxSpeed, this.baseSpeed * this.config.wheelStep);
    } else if (event.deltaY > 0) {
      this.baseSpeed = Math.max(this.config.minSpeed, this.baseSpeed / this.config.wheelStep);
    }

    this.baseSpeed = Math.round(this.baseSpeed * 10) / 10;
    this.notifySpeedChange();
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (this.enabled) {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this._isInputLocked) return;
    if (this.isInputElement(event.target)) return;

    if (event.code) {
      this.keys[event.code] = true;
    }

    // Hotkey F: focus on target if provider registered
    if ((event.code === 'KeyF' || event.key === 'f' || event.key === 'F') && this.focusTargetProvider) {
      const target = this.focusTargetProvider();
      if (target && target.position) {
        this.focusOn(target.position, target.distance);
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (event.code) {
      delete this.keys[event.code];
    }
  };

  private onWindowBlur = (): void => {
    this.resetInputState();
  };

  private onMouseLeave = (): void => {
    this.isRightMouseDown = false;
  };

  private onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.hidden) {
      this.resetInputState();
    }
  };
}
