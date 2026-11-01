import * as THREE from 'three';

export interface GhostBeaconTransform {
  position: { x: number; y: number; z: number } | THREE.Vector3;
  yaw?: number;
}

/**
 * PlayerGhostBeacon: Visual holographic avatar and vertical light column
 * placed at the player's saved position while in EDITOR mode.
 */
export class PlayerGhostBeacon {
  private readonly scene: THREE.Scene;
  private group: THREE.Group | null = null;
  private diamondMesh: THREE.Mesh | null = null;
  private outerRingMesh: THREE.Mesh | null = null;
  private animTime: number = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Spawns the holographic beacon at the player's coordinates and orientation.
   * Supports both object signature ({ position, yaw }) and parameter list (position, yaw).
   */
  public spawn(
    transformOrPos: GhostBeaconTransform | THREE.Vector3 | { x: number; y: number; z: number },
    yawParam: number = 0
  ): THREE.Group {
    this.remove(); // Clean up any existing beacon

    let posX = 0;
    let posY = 0;
    let posZ = 0;
    let yaw = yawParam;

    if ('position' in transformOrPos) {
      const p = transformOrPos.position;
      posX = p.x;
      posY = p.y;
      posZ = p.z;
      if (transformOrPos.yaw !== undefined) {
        yaw = transformOrPos.yaw;
      }
    } else {
      posX = transformOrPos.x;
      posY = transformOrPos.y;
      posZ = transformOrPos.z;
    }

    const group = new THREE.Group();
    group.name = 'player-ghost-beacon';
    group.position.set(posX, posY, posZ);
    group.rotation.y = yaw;

    // 1. Holographic stylized avatar body
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.9, 16);
    const bodyMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.45,
      wireframe: false,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0.85;
    group.add(bodyMesh);

    // 2. Visor indicating facing direction (pointing along -Z)
    const visorGeo = new THREE.BoxGeometry(0.3, 0.1, 0.18);
    const visorMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.9,
    });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 1.45, -0.18);
    group.add(visorMesh);

    // 3. Head
    const headGeo = new THREE.SphereGeometry(0.24, 16, 16);
    const headMat = new THREE.MeshBasicMaterial({
      color: 0x00c8e6,
      transparent: true,
      opacity: 0.5,
    });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = 1.45;
    group.add(headMesh);

    // 4. Vertical Light Pillar / Sky Beam (height: 24m, visible across entire 200x200 world)
    const beamGeo = new THREE.CylinderGeometry(0.12, 0.12, 24.0, 16, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.position.y = 12.0; // From ground y=0 to y=24
    group.add(beamMesh);

    // 5. Ground Reticle Rings
    const ringGeo = new THREE.RingGeometry(0.7, 0.8, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.03;
    group.add(ringMesh);
    this.outerRingMesh = ringMesh;

    // 6. Floating Diamond Beacon Marker (hovering at y=2.4)
    const diamondGeo = new THREE.OctahedronGeometry(0.2, 0);
    const diamondMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      wireframe: true,
    });
    const diamondMesh = new THREE.Mesh(diamondGeo, diamondMat);
    diamondMesh.position.y = 2.4;
    group.add(diamondMesh);
    this.diamondMesh = diamondMesh;

    this.scene.add(group);
    this.group = group;
    return group;
  }

  /**
   * Per-frame animation for subtle pulsing and rotation.
   */
  public update(delta: number): void {
    if (!this.group) return;
    this.animTime += delta;

    if (this.diamondMesh) {
      this.diamondMesh.rotation.y += delta * 2.0;
      this.diamondMesh.position.y = 2.4 + Math.sin(this.animTime * 3.0) * 0.08;
    }

    if (this.outerRingMesh) {
      this.outerRingMesh.rotation.z += delta * 0.4;
    }
  }

  /**
   * Disposes all geometries and materials and removes from scene.
   */
  public remove(): void {
    if (!this.group) return;

    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      }
    });

    this.scene.remove(this.group);
    this.group = null;
    this.diamondMesh = null;
    this.outerRingMesh = null;
  }

  /**
   * Alias for remove() to support standard disposal lifecycle.
   */
  public dispose(): void {
    this.remove();
  }

  public getGroup(): THREE.Group | null {
    return this.group;
  }

  public isSpawned(): boolean {
    return this.group !== null;
  }
}
