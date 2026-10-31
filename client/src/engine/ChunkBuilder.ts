import * as THREE from 'three';
import { SCENE_COLORS } from './colors';

/**
 * ---------------------------------------------------------------------------
 * ChunkBuilder: Procedural Generation and Deep GPU Disposal for 3D Chunks
 * ---------------------------------------------------------------------------
 * Architecture:
 * - 10x10 chunk grid over 200x200 world (chunk size = 20x20 world units).
 * - Chunk (cx, cz) spans [cx * 20, (cx + 1) * 20] along X and [cz * 20, (cz + 1) * 20] along Z.
 * - Procedural generation:
 *    1. Ground tile: PlaneGeometry(20, 20) with dark pavement material.
 *    2. Market stalls: wooden counter, vertical posts, colored cloth canopies.
 *    3. Atmospheric lanterns: glowing spherical bodies with point lights.
 *    4. Props: wooden crates, barrels, ceramic pots, tea sets.
 *    5. Landmark stall in chunk '5_5': Lao Wang's antique stall with pagoda eaves,
 *       signboard, antique teapot (M4 target), and Lao Wang NPC avatar marker (M3 target).
 * - Deep GPU disposal: disposeHierarchy(object) recursively frees geometries,
 *   single/array materials, all attached textures, and unlinks scene graph.
 */

// ---------------------------------------------------------------------------
// Type Definitions & Interfaces
// ---------------------------------------------------------------------------

export type StallType = 'tea' | 'jade' | 'food' | 'general' | 'lao_wang' | 'noodles' | 'scrolls' | 'herbs' | 'weapons';

export interface StallConfig {
  x: number;          // local x within chunk [0..20]
  z: number;          // local z within chunk [0..20]
  rotationY?: number; // yaw rotation in radians
  stallType?: StallType;
  canopyColor?: number;
  hasLantern?: boolean;
}

export interface LanternConfig {
  x: number;          // local x
  y: number;          // height ~2.5 - 3.8
  z: number;          // local z
  color?: number;     // e.g. 0xff3b14, 0xff7700
  intensity?: number; // e.g. 1.2 - 1.8
  distance?: number;  // e.g. 12 - 18
}

export interface PropConfig {
  type: 'crate' | 'barrel' | 'teapot' | 'vase';
  x: number;
  y: number;
  z: number;
  rotationY?: number;
  scale?: number;
}

export interface ChunkData {
  id: string;               // e.g. "5_5"
  cx: number;               // 0..9
  cz: number;               // 0..9
  isLandmark?: boolean;     // true for 5_5
  npcId?: string;           // "lao_wang" for 5_5
  stalls?: StallConfig[];
  lanterns?: LanternConfig[];
  props?: PropConfig[];
}

export interface ChunkBuilderOptions {
  enableShadows?: boolean;
  enablePointLights?: boolean;
  maxLightsPerChunk?: number; // default 2 to prevent WebGL light limit dropping
  pavementColor?: number;     // default 0x1e2026
}

export const DEFAULT_CHUNK_OPTIONS: ChunkBuilderOptions = {
  enableShadows: true,
  enablePointLights: true,
  maxLightsPerChunk: 2,
  pavementColor: SCENE_COLORS.floorColor,
};

// Chinese Night Market Canopy Palette
const CANOPY_PALETTE: number[] = [
  SCENE_COLORS.tentRoofColor,
];

// ---------------------------------------------------------------------------
// Seeded PRNG for Deterministic Procedural Generation
// ---------------------------------------------------------------------------

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed ? Math.abs(seed) : 123456789;
  }

  public next(): number {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296;
    return this.state / 4294967296;
  }

  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  public choice<T>(array: T[]): T {
    return array[Math.floor(this.next() * array.length)];
  }
}

// ---------------------------------------------------------------------------
// Deep GPU Disposal Protocol
// ---------------------------------------------------------------------------

/**
 * Recursively disposes all GPU resources attached to an Object3D hierarchy:
 * 1. Disposes all BufferGeometries (Mesh, Line, LineSegments, Points, InstancedMesh).
 * 2. Disposes all Materials (single material, material arrays, ShaderMaterial, SpriteMaterial).
 * 3. Inspects and disposes all attached Textures (map, normalMap, roughnessMap, alphaMap, etc.).
 * 4. Disposes Light shadow maps.
 * 5. Cleans and unlinks child-parent references in the Three.js scene graph.
 *
 * Guarantees zero VRAM memory leaks when chunks are unloaded from the scene.
 */
export function disposeHierarchy(object: THREE.Object3D | null | undefined): void {
  if (!object) return;

  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<any>();

  const disposeTexture = (texture: any) => {
    if (texture && !disposedTextures.has(texture)) {
      disposedTextures.add(texture);
      if (typeof texture.dispose === 'function') {
        texture.dispose();
      }
      const img = texture.image;
      if (img && typeof img.close === 'function') {
        try {
          img.close();
        } catch {
          // Ignore
        }
      }
    }
  };

  const disposeMaterial = (mat: THREE.Material | null | undefined) => {
    if (!mat || disposedMaterials.has(mat)) return;
    disposedMaterials.add(mat);

    // Inspect standard Three.js texture property slots
    const matAny = mat as any;
    const textureSlots = [
      'map',
      'alphaMap',
      'aoMap',
      'bumpMap',
      'displacementMap',
      'emissiveMap',
      'envMap',
      'lightMap',
      'metalnessMap',
      'normalMap',
      'roughnessMap',
      'specularMap',
      'gradientMap',
    ];

    for (const slot of textureSlots) {
      if (matAny[slot]) {
        disposeTexture(matAny[slot]);
      }
    }

    // Inspect custom ShaderMaterial uniforms for textures
    if (matAny.uniforms && typeof matAny.uniforms === 'object') {
      for (const uniformKey of Object.keys(matAny.uniforms)) {
        const uVal = matAny.uniforms[uniformKey]?.value;
        if (uVal && typeof uVal.dispose === 'function') {
          disposeTexture(uVal);
        } else if (Array.isArray(uVal)) {
          for (const item of uVal) {
            if (item && typeof item.dispose === 'function') {
              disposeTexture(item);
            }
          }
        }
      }
    }

    if (typeof mat.dispose === 'function') {
      mat.dispose();
    }
  };

  // Traversal across all descendant nodes
  object.traverse((child: THREE.Object3D) => {
    const childAny = child as any;

    // 1. BufferGeometry disposal
    if (childAny.geometry) {
      const geo = childAny.geometry;
      if (!disposedGeometries.has(geo)) {
        disposedGeometries.add(geo);
        if (typeof geo.dispose === 'function') {
          geo.dispose();
        }
      }
    }

    // 2. Material & Texture disposal
    if (childAny.material) {
      if (Array.isArray(childAny.material)) {
        for (const m of childAny.material) {
          disposeMaterial(m);
        }
      } else {
        disposeMaterial(childAny.material);
      }
    }

    // 3. Light shadow maps
    if (child instanceof THREE.Light && child.shadow && child.shadow.map) {
      child.shadow.map.dispose();
    }

    // 4. Clear node userData
    child.userData = {};
  });

  // 5. Unlink children from root
  while (object.children.length > 0) {
    const child = object.children[0];
    object.remove(child);
  }

  // 6. Unlink root from parent
  if (object.parent) {
    object.parent.remove(object);
  }

  object.userData = {};
}

// ---------------------------------------------------------------------------
// ChunkBuilder Factory Class
// ---------------------------------------------------------------------------

export class ChunkBuilder {
  /**
   * Main entry point: builds a complete chunk THREE.Group positioned at world (cx * 20, 0, cz * 20).
   */
  public static buildChunk(
    cx: number,
    cz: number,
    data?: ChunkData,
    options?: Partial<ChunkBuilderOptions>
  ): THREE.Group {
    const opts: ChunkBuilderOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options };
    const chunkId = data?.id ?? `${cx}_${cz}`;
    const isLandmark = data?.isLandmark ?? (cx === 5 && cz === 5);

    const chunkGroup = new THREE.Group();
    chunkGroup.name = `chunk_${chunkId}`;
    chunkGroup.position.set(cx * 20, 0, cz * 20);
    chunkGroup.userData = {
      chunkId,
      cx,
      cz,
      isLandmark,
      npcId: isLandmark ? 'lao_wang' : undefined,
    };

    // 1. Ground Tile (PlaneGeometry 20x20)
    const groundMesh = this.buildGroundTile(cx, cz, opts);
    chunkGroup.add(groundMesh);

    // 2. Build Stalls, Props, Lanterns, or Landmark
    if (isLandmark) {
      // Chunk 5_5 Landmark: Lao Wang's Antique Pavilion & NPC Avatar Marker
      const landmarkGroup = this.buildLaoWangLandmark(opts);
      chunkGroup.add(landmarkGroup);

      // Central Plaza (Spawn area): Keep it an open bazaar square without black walls blocking the player!
    } else {
      // Procedural Night Market Generation
      const seed = (cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9;
      const rng = new SeededRandom(seed);

      const proceduralStalls = this.generateProceduralStalls(rng, cx, cz, opts);
      chunkGroup.add(proceduralStalls);

      const proceduralProps = this.generateProceduralProps(rng, opts);
      chunkGroup.add(proceduralProps);

      // Realistic Chinese architecture: 2-sided buildings, pagoda roofs, signboards & overhead wire lanterns!
      const streetAtmosphere = this.generateStreetFacadesAndOverhead(opts);
      chunkGroup.add(streetAtmosphere);
    }

    return chunkGroup;
  }

  /**
   * Generates realistic traditional Chinese architecture:
   * 1. Multi-story building facades behind the stalls on both sides (x <= 4 and x >= 16)
   * 2. Traditional curved pagoda tile roofs (grey/terracotta eaves)
   * 3. Glowing Chinese shop signboards (vertical neon/wood boards with red/gold glow)
   * 4. Overhead wires with hanging red lanterns stretched across the entire street (exactly like reference photo!)
   */
  private static generateStreetFacadesAndOverhead(opts: ChunkBuilderOptions): THREE.Group {
    const group = new THREE.Group();
    group.name = 'facades_and_overhead';

    const wallMat = new THREE.MeshStandardMaterial({ color: SCENE_COLORS.wallBrickColor, roughness: 0.85 });
    const roofTileMat = new THREE.MeshStandardMaterial({ color: 0x3d3a45, roughness: 0.5 }); // Dark slate Chinese roof tiles

    // 1. LEFT SIDE BUILDINGS (x: -1 to 4.5, z: 0 to 20, height: 8.5m)
    const leftBuildingGeo = new THREE.BoxGeometry(5.5, 8.5, 20);
    const leftBuilding = new THREE.Mesh(leftBuildingGeo, wallMat);
    leftBuilding.position.set(1.75, 4.25, 10);
    leftBuilding.receiveShadow = true;
    leftBuilding.userData = { isWall: true };
    group.add(leftBuilding);

    // Left building traditional pagoda roof eave
    const leftEaveGeo = new THREE.BoxGeometry(1.6, 0.25, 20.4);
    const leftEave = new THREE.Mesh(leftEaveGeo, roofTileMat);
    leftEave.position.set(4.6, 6.2, 10);
    leftEave.rotation.z = -0.35; // curved slope down towards street
    group.add(leftEave);

    // 2. RIGHT SIDE BUILDINGS (x: 15.5 to 21, z: 0 to 20, height: 8.5m)
    const rightBuildingGeo = new THREE.BoxGeometry(5.5, 8.5, 20);
    const rightBuilding = new THREE.Mesh(rightBuildingGeo, wallMat);
    rightBuilding.position.set(18.25, 4.25, 10);
    rightBuilding.receiveShadow = true;
    rightBuilding.userData = { isWall: true };
    group.add(rightBuilding);

    // Right building traditional pagoda roof eave
    const rightEaveGeo = new THREE.BoxGeometry(1.6, 0.25, 20.4);
    const rightEave = new THREE.Mesh(rightEaveGeo, roofTileMat);
    rightEave.position.set(15.4, 6.2, 10);
    rightEave.rotation.z = 0.35; // curved slope down towards street
    group.add(rightEave);

    // 3. GLOWING VERTICAL CHINESE SHOP SIGNBOARDS (along facades)
    const signPositions = [
      { x: 4.6, y: 4.2, z: 4.5, rotY: Math.PI / 2, color: 0xff0033 },
      { x: 4.6, y: 4.2, z: 14.5, rotY: Math.PI / 2, color: 0xffaa00 },
      { x: 15.4, y: 4.2, z: 6.5, rotY: -Math.PI / 2, color: 0xff0033 },
      { x: 15.4, y: 4.2, z: 16.5, rotY: -Math.PI / 2, color: 0x00f3ff },
    ];

    const boardGeo = new THREE.BoxGeometry(0.08, 2.2, 0.7);
    for (const sp of signPositions) {
      const boardMat = new THREE.MeshStandardMaterial({
        color: 0x140a08,
        emissive: sp.color,
        emissiveIntensity: 0.6,
        roughness: 0.4,
      });
      const board = new THREE.Mesh(boardGeo, boardMat);
      board.position.set(sp.x, sp.y, sp.z);
      board.rotation.y = sp.rotY;
      group.add(board);
    }

    // 4. OVERHEAD SUSPENSION WIRES WITH CHINESE LANTERNS (stretching from left to right buildings at z = 5, 10, 15)
    const wireZCoords = [5.0, 10.0, 15.0];
    const wireGeo = new THREE.CylinderGeometry(0.015, 0.015, 11.0, 4);
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

    for (const wz of wireZCoords) {
      // Cross-street wire
      const wire = new THREE.Mesh(wireGeo, wireMat);
      wire.rotation.z = Math.PI / 2;
      wire.position.set(10.0, 5.2, wz);
      group.add(wire);

      // 4 hanging red/orange lanterns on this wire
      const lanternXs = [6.5, 8.8, 11.2, 13.5];
      for (const lx of lanternXs) {
        const lantern = this.buildLantern(
          {
            x: lx,
            y: 4.6,
            z: wz,
            color: SCENE_COLORS.lanternBodyColor,
            intensity: 1.2,
            distance: 12,
          },
          opts,
          false // visual lanterns on wires, light budget preserved
        );
        group.add(lantern);
      }
    }

    return group;
  }

  /**
   * Builds the 20x20 dark pavement ground tile for the chunk.
   */
  public static buildGroundTile(cx: number, cz: number, opts: ChunkBuilderOptions): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(20, 20);

    const mat = new THREE.MeshStandardMaterial({
      color: opts.pavementColor ?? SCENE_COLORS.floorColor,
      roughness: 0.88,
      metalness: 0.12,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    // Local center of chunk is (10, 0.01, 10)
    mesh.position.set(10, 0.01, 10);
    mesh.receiveShadow = opts.enableShadows ?? true;
    mesh.name = `ground_${cx}_${cz}`;

    return mesh;
  }

  /**
   * Generates procedural market stalls based on chunk coordinate (cx, cz):
   * - Plazas (every 2nd chunk, (cx + cz) % 2 === 0): Open square bazaar with stalls arranged in a square looking INWARDS.
   * - Streets (alternating chunks): Straight or turning street corridor leading into the squares.
   */
  private static generateProceduralStalls(rng: SeededRandom, cx: number, cz: number, opts: ChunkBuilderOptions): THREE.Group {
    const group = new THREE.Group();
    group.name = 'stalls_group';

    let lightsCreated = 0;

    // Pattern: Plazas (open squares with inward stalls) vs Cross/Turn Streets
    const isSquarePlaza = (cx + cz) % 2 === 0;

    let slots: Array<{ x: number; z: number; rotY: number }> = [];

    if (isSquarePlaza) {
      // SQUARE PLAZA: Stalls along 4 perimeter sides facing the open central square!
      slots = [
        // North side (facing south: rotY = Math.PI)
        { x: 6.5, z: 3.5, rotY: Math.PI },
        { x: 13.5, z: 3.5, rotY: Math.PI },
        // South side (facing north: rotY = 0)
        { x: 6.5, z: 16.5, rotY: 0 },
        { x: 13.5, z: 16.5, rotY: 0 },
        // West side (facing east: rotY = -Math.PI / 2)
        { x: 3.5, z: 10.0, rotY: -Math.PI / 2 },
        // East side (facing west: rotY = Math.PI / 2)
        { x: 16.5, z: 10.0, rotY: Math.PI / 2 },
      ];
    } else {
      // STREET CORRIDOR / TURN: Two side rows with intersections
      const isEastWestTurn = (cx % 2 === 0);
      if (isEastWestTurn) {
        // Horizontal street (walk East-West)
        slots = [
          { x: 3.5, z: 6.0, rotY: 0 },
          { x: 10.0, z: 6.0, rotY: 0 },
          { x: 16.5, z: 6.0, rotY: 0 },
          { x: 3.5, z: 14.0, rotY: Math.PI },
          { x: 10.0, z: 14.0, rotY: Math.PI },
          { x: 16.5, z: 14.0, rotY: Math.PI },
        ];
      } else {
        // Vertical street (walk North-South)
        slots = [
          { x: 6.0, z: 3.5, rotY: -Math.PI / 2 },
          { x: 6.0, z: 10.0, rotY: -Math.PI / 2 },
          { x: 6.0, z: 16.5, rotY: -Math.PI / 2 },
          { x: 14.0, z: 3.5, rotY: Math.PI / 2 },
          { x: 14.0, z: 10.0, rotY: Math.PI / 2 },
          { x: 14.0, z: 16.5, rotY: Math.PI / 2 },
        ];
      }
    }

    const stallCount = rng.int(Math.min(4, slots.length), slots.length);

    for (let i = 0; i < stallCount && i < slots.length; i++) {
      const slot = slots[i];
      const canopyColor = rng.choice(CANOPY_PALETTE);
      const stallTypes: StallType[] = ['tea', 'jade', 'food', 'general', 'noodles', 'scrolls', 'herbs', 'weapons'];
      const stallType = stallTypes[(cx * 4 + cz + i) % stallTypes.length];
      const allowLight = lightsCreated < (opts.maxLightsPerChunk ?? 2);

      const stallMesh = this.buildStall(
        {
          x: slot.x,
          z: slot.z,
          rotationY: slot.rotY,
          stallType,
          canopyColor,
          hasLantern: true,
        },
        opts,
        allowLight
      );

      if (allowLight) {
        lightsCreated++;
      }

      group.add(stallMesh);
    }

    return group;
  }

  /**
   * Builds an individual market stall (counter box, corner poles, cloth canopy, props, lantern).
   */
  public static buildStall(
    config: StallConfig,
    opts: ChunkBuilderOptions = DEFAULT_CHUNK_OPTIONS,
    includeLight: boolean = true
  ): THREE.Group {
    const stall = new THREE.Group();
    stall.position.set(config.x, 0, config.z);
    if (config.rotationY) {
      stall.rotation.y = config.rotationY;
    }

    // 1. Counter Base (Wooden cabinet)
    const baseGeo = new THREE.BoxGeometry(3.0, 0.85, 1.2);
    const baseMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.tentBaseColor,
      roughness: 0.75,
      metalness: 0.1,
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.85 / 2;
    baseMesh.castShadow = opts.enableShadows ?? true;
    baseMesh.receiveShadow = opts.enableShadows ?? true;
    baseMesh.userData = { isWall: true, isStall: true };
    stall.add(baseMesh);

    // 2. Counter Top (Slightly larger tabletop)
    const topGeo = new THREE.BoxGeometry(3.2, 0.08, 1.4);
    const topMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.tentBaseColor,
      roughness: 0.6,
      metalness: 0.15,
    });
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.y = 0.85 + 0.04;
    topMesh.castShadow = opts.enableShadows ?? true;
    topMesh.receiveShadow = opts.enableShadows ?? true;
    topMesh.userData = { isWall: true, isStall: true };
    stall.add(topMesh);

    // 3. Four Wooden Support Posts
    const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.3, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: SCENE_COLORS.tentPoleColor, roughness: 0.8 });
    const postOffsets = [
      { x: -1.45, z: -0.55 },
      { x: 1.45, z: -0.55 },
      { x: -1.45, z: 0.55 },
      { x: 1.45, z: 0.55 },
    ];

    for (const offset of postOffsets) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(offset.x, 1.15, offset.z);
      post.castShadow = opts.enableShadows ?? true;
      stall.add(post);
    }

    // 4. Colored Fabric Canopy (Tilted forward towards street)
    const canopyColor = config.canopyColor ?? SCENE_COLORS.tentRoofColor;
    const canopyGeo = new THREE.BoxGeometry(3.4, 0.06, 1.8);
    const canopyMat = new THREE.MeshStandardMaterial({
      color: canopyColor,
      roughness: 0.7,
      metalness: 0.05,
    });
    const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
    canopyMesh.position.set(0, 2.25, 0.1);
    canopyMesh.rotation.x = 0.12; // tilt forward
    canopyMesh.castShadow = opts.enableShadows ?? true;
    stall.add(canopyMesh);

    // 5. Canopy Front Valence (Hanging decorative flap)
    const valenceGeo = new THREE.BoxGeometry(3.4, 0.22, 0.03);
    const valenceMesh = new THREE.Mesh(valenceGeo, canopyMat);
    valenceMesh.position.set(0, 2.15, 0.98);
    stall.add(valenceMesh);

    // 6. Stall Merchandise Props
    this.addStallMerchandise(stall, config.stallType ?? 'general', opts);

    // 7. Hanging Lantern
    if (config.hasLantern) {
      const lanternGroup = this.buildLantern(
        {
          x: 1.25,
          y: 2.05,
          z: 0.85,
          color: 0xff4411,
          intensity: 1.4,
          distance: 14,
        },
        opts,
        includeLight
      );
      stall.add(lanternGroup);
    }

    return stall;
  }

  /**
   * Adds themed merchandise on top of the stall counter with rich unique details.
   */
  private static addStallMerchandise(stall: THREE.Group, type: StallType, opts: ChunkBuilderOptions): void {
    const yTop = 0.85 + 0.08;

    if (type === 'tea') {
      // Ceramic Teapot
      const potGeo = new THREE.SphereGeometry(0.18, 12, 10);
      const potMat = new THREE.MeshStandardMaterial({ color: 0x4a1805, roughness: 0.4 });
      const pot = new THREE.Mesh(potGeo, potMat);
      pot.position.set(-0.6, yTop + 0.18, 0);
      pot.castShadow = opts.enableShadows ?? true;
      stall.add(pot);

      // Ceramic Cups on a tray
      const trayGeo = new THREE.BoxGeometry(0.7, 0.03, 0.4);
      const trayMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
      const tray = new THREE.Mesh(trayGeo, trayMat);
      tray.position.set(0.2, yTop + 0.015, 0);
      stall.add(tray);

      const cupGeo = new THREE.CylinderGeometry(0.06, 0.04, 0.09, 8);
      const cupMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.3 });
      for (let i = 0; i < 3; i++) {
        const cup = new THREE.Mesh(cupGeo, cupMat);
        cup.position.set(0.0 + i * 0.18, yTop + 0.06, 0);
        stall.add(cup);
      }

      // Tea canisters
      const canGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.35, 10);
      const canMat = new THREE.MeshStandardMaterial({ color: 0x1b4332, roughness: 0.4, metalness: 0.2 });
      const can1 = new THREE.Mesh(canGeo, canMat);
      can1.position.set(0.9, yTop + 0.175, -0.15);
      stall.add(can1);

      const can2 = new THREE.Mesh(canGeo, canMat);
      can2.position.set(1.15, yTop + 0.175, 0.1);
      stall.add(can2);
    } else if (type === 'jade') {
      // Jade display velvet cushion
      const trayGeo = new THREE.BoxGeometry(1.2, 0.06, 0.7);
      const trayMat = new THREE.MeshStandardMaterial({ color: 0x1a0a20, roughness: 0.95 });
      const tray = new THREE.Mesh(trayGeo, trayMat);
      tray.position.set(0, yTop + 0.03, 0);
      stall.add(tray);

      // Glowing Jade Stones of different colors
      const jadeColors = [0x2ec4b6, 0x52b788, 0x80ed99];
      for (let i = 0; i < 3; i++) {
        const jadeGeo = new THREE.DodecahedronGeometry(0.13);
        const jadeMat = new THREE.MeshStandardMaterial({
          color: jadeColors[i],
          roughness: 0.15,
          metalness: 0.2,
          emissive: jadeColors[i],
          emissiveIntensity: 0.7,
        });
        const jade = new THREE.Mesh(jadeGeo, jadeMat);
        jade.position.set(-0.35 + i * 0.35, yTop + 0.16, (i % 2 === 0 ? 0.08 : -0.08));
        stall.add(jade);
      }

      // Jewelry stand
      const standGeo = new THREE.TorusGeometry(0.2, 0.03, 8, 16);
      const standMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.2 });
      const stand = new THREE.Mesh(standGeo, standMat);
      stand.position.set(0.9, yTop + 0.25, 0);
      stand.rotation.y = Math.PI / 4;
      stall.add(stand);
    } else if (type === 'noodles') {
      // Steamer baskets (dim sum / baozi)
      const steamerGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.14, 12);
      const steamerMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.9 });
      for (let h = 0; h < 3; h++) {
        const basket = new THREE.Mesh(steamerGeo, steamerMat);
        basket.position.set(-0.7, yTop + 0.07 + h * 0.14, 0);
        stall.add(basket);
      }

      // Large boiling wok / pot
      const wokGeo = new THREE.CylinderGeometry(0.35, 0.2, 0.25, 14);
      const wokMat = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, metalness: 0.8, roughness: 0.3 });
      const wok = new THREE.Mesh(wokGeo, wokMat);
      wok.position.set(0.1, yTop + 0.125, 0);
      stall.add(wok);

      // Red noodle bowls
      const bowlGeo = new THREE.CylinderGeometry(0.14, 0.07, 0.12, 10);
      const bowlMat = new THREE.MeshStandardMaterial({ color: 0xba181b, roughness: 0.3 });
      const bowl1 = new THREE.Mesh(bowlGeo, bowlMat);
      bowl1.position.set(0.75, yTop + 0.06, -0.15);
      stall.add(bowl1);

      const bowl2 = new THREE.Mesh(bowlGeo, bowlMat);
      bowl2.position.set(1.05, yTop + 0.06, 0.1);
      stall.add(bowl2);
    } else if (type === 'scrolls') {
      // Wooden scroll rack with paper rolls
      const rollGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.65, 8);
      const rollMat1 = new THREE.MeshStandardMaterial({ color: 0xfaedcd, roughness: 0.8 });
      const rollMat2 = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.8 });
      for (let s = 0; s < 5; s++) {
        const roll = new THREE.Mesh(rollGeo, s % 2 === 0 ? rollMat1 : rollMat2);
        roll.rotation.z = Math.PI / 2;
        roll.position.set(-0.6 + s * 0.3, yTop + 0.045, 0);
        stall.add(roll);
      }

      // Ink stone and brush holder
      const inkGeo = new THREE.BoxGeometry(0.25, 0.04, 0.35);
      const inkMat = new THREE.MeshStandardMaterial({ color: 0x0b090a, roughness: 0.2 });
      const ink = new THREE.Mesh(inkGeo, inkMat);
      ink.position.set(0.9, yTop + 0.02, 0);
      stall.add(ink);
    } else if (type === 'herbs') {
      // Traditional medicine drawers / ceramic pharmacy jars
      const jarGeo = new THREE.CylinderGeometry(0.13, 0.11, 0.28, 10);
      const jarMat = new THREE.MeshStandardMaterial({ color: 0x2b2d42, roughness: 0.25 });
      for (let j = 0; j < 4; j++) {
        const jar = new THREE.Mesh(jarGeo, jarMat);
        jar.position.set(-0.8 + j * 0.35, yTop + 0.14, -0.1);
        stall.add(jar);
      }

      // Mortar and pestle for grinding herbs
      const mortarGeo = new THREE.CylinderGeometry(0.15, 0.08, 0.16, 10);
      const mortarMat = new THREE.MeshStandardMaterial({ color: 0x6c757d, roughness: 0.7 });
      const mortar = new THREE.Mesh(mortarGeo, mortarMat);
      mortar.position.set(0.8, yTop + 0.08, 0.1);
      stall.add(mortar);
    } else if (type === 'weapons') {
      // Antique daggers / sword display
      const bladeGeo = new THREE.BoxGeometry(0.03, 0.04, 0.9);
      const bladeMat = new THREE.MeshStandardMaterial({ color: 0xced4da, metalness: 0.9, roughness: 0.15 });
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.position.set(0, yTop + 0.08, 0);
      blade.rotation.y = Math.PI / 6;
      stall.add(blade);

      const hiltGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.25, 8);
      const hiltMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.3 });
      const hilt = new THREE.Mesh(hiltGeo, hiltMat);
      hilt.rotation.x = Math.PI / 2;
      hilt.position.set(0.2, yTop + 0.08, -0.4);
      stall.add(hilt);
    } else {
      // General Goods: wooden display box with porcelain jars and goods
      const boxGeo = new THREE.BoxGeometry(0.8, 0.2, 0.5);
      const boxMat = new THREE.MeshStandardMaterial({ color: 0x4f3522, roughness: 0.8 });
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.position.set(0.4, yTop + 0.1, 0);
      stall.add(box);

      const jarGeo = new THREE.CylinderGeometry(0.12, 0.1, 0.3, 10);
      const jarMat = new THREE.MeshStandardMaterial({ color: 0x3d5a80, roughness: 0.3 });
      const jar = new THREE.Mesh(jarGeo, jarMat);
      jar.position.set(-0.5, yTop + 0.15, 0);
      stall.add(jar);
    }
  }

  /**
   * Builds an illuminated Chinese paper lantern with glowing spherical body and optional PointLight.
   */
  public static buildLantern(
    config: LanternConfig,
    opts: ChunkBuilderOptions = DEFAULT_CHUNK_OPTIONS,
    includeLight: boolean = true
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(config.x, config.y, config.z);

    // 1. Suspension Cord
    const cordGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.35, 6);
    const cordMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.y = 0.175;
    group.add(cord);

    // 2. Glowing Lantern Sphere (slightly oblong)
    const sphereGeo = new THREE.SphereGeometry(0.25, 12, 10);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.lanternBodyColor,
      emissive: SCENE_COLORS.lanternBodyColor,
      emissiveIntensity: 1.4,
      roughness: 0.3,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.scale.set(1.0, 1.2, 1.0);
    group.add(sphere);

    // 3. Top and Bottom Gold Cap Rings
    const ringGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.03, 10);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.3 });

    const topRing = new THREE.Mesh(ringGeo, ringMat);
    topRing.position.y = 0.28;
    group.add(topRing);

    const bottomRing = new THREE.Mesh(ringGeo, ringMat);
    bottomRing.position.y = -0.28;
    group.add(bottomRing);

    // 4. PointLight (only if enabled and budget allows)
    if (includeLight && (opts.enablePointLights ?? true)) {
      const pointLight = new THREE.PointLight(
        SCENE_COLORS.lanternLightColor,
        config.intensity ?? 1.4,
        config.distance ?? 14,
        1.8
      );
      pointLight.castShadow = false; // keep performance high
      group.add(pointLight);
    }

    return group;
  }

  /**
   * Generates procedural props (stacked wooden crates, ceramic barrels) along the corners.
   */
  private static generateProceduralProps(rng: SeededRandom, opts: ChunkBuilderOptions): THREE.Group {
    const group = new THREE.Group();
    group.name = 'props_group';

    const propCount = rng.int(2, 4);
    const spawnPoints = [
      { x: 2.2, z: 9.5 },
      { x: 17.8, z: 9.5 },
      { x: 2.5, z: 18.0 },
      { x: 17.5, z: 18.0 },
    ];

    for (let i = 0; i < propCount && i < spawnPoints.length; i++) {
      const pt = spawnPoints[i];
      const isCrate = rng.next() > 0.4;

      if (isCrate) {
        // Wooden Crate
        const size = rng.range(0.6, 0.85);
        const crateGeo = new THREE.BoxGeometry(size, size, size);
        const crateMat = new THREE.MeshStandardMaterial({
          color: 0x5c4033,
          roughness: 0.85,
        });
        const crate = new THREE.Mesh(crateGeo, crateMat);
        crate.position.set(pt.x, size / 2, pt.z);
        crate.rotation.y = rng.range(0, Math.PI);
        crate.castShadow = opts.enableShadows ?? true;
        group.add(crate);
      } else {
        // Ceramic Barrel / Urn
        const barrelGeo = new THREE.CylinderGeometry(0.32, 0.28, 0.8, 12);
        const barrelMat = new THREE.MeshStandardMaterial({
          color: 0x403d39,
          roughness: 0.6,
          metalness: 0.2,
        });
        const barrel = new THREE.Mesh(barrelGeo, barrelMat);
        barrel.position.set(pt.x, 0.4, pt.z);
        barrel.castShadow = opts.enableShadows ?? true;
        group.add(barrel);
      }
    }

    return group;
  }

  /**
   * Landmark: Chunk 5_5 Lao Wang Pavilion & Avatar Marker.
   * Prominent central landmark in the night market.
   */
  public static buildLaoWangLandmark(opts: ChunkBuilderOptions = DEFAULT_CHUNK_OPTIONS): THREE.Group {
    const landmark = new THREE.Group();
    landmark.name = 'lao_wang_landmark';
    // Positioned in center of chunk (x=10, z=10), facing South towards player spawn (100, 100)
    landmark.position.set(10, 0, 9.5);

    // 1. Pavilion Platform (Stone foundation)
    const platformGeo = new THREE.BoxGeometry(5.2, 0.25, 3.6);
    const platformMat = new THREE.MeshStandardMaterial({ color: 0x333533, roughness: 0.9 });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = 0.125;
    platform.receiveShadow = opts.enableShadows ?? true;
    landmark.add(platform);

    // 2. Grand Rosewood Counter
    const counterGeo = new THREE.BoxGeometry(4.0, 0.9, 1.3);
    const counterMat = new THREE.MeshStandardMaterial({
      color: 0x2b170c, // Rich dark rosewood
      roughness: 0.5,
      metalness: 0.2,
    });
    const counter = new THREE.Mesh(counterGeo, counterMat);
    counter.position.set(0, 0.25 + 0.45, 0.3);
    counter.castShadow = opts.enableShadows ?? true;
    counter.receiveShadow = opts.enableShadows ?? true;
    counter.userData = { isWall: true };
    landmark.add(counter);

    // 3. Four Ornate Red Lacquer Pillars
    const pillarGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.8, 12);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x800e13, roughness: 0.4 });
    const pillarCoords = [
      { x: -2.3, z: -1.4 },
      { x: 2.3, z: -1.4 },
      { x: -2.3, z: 1.4 },
      { x: 2.3, z: 1.4 },
    ];
    for (const coord of pillarCoords) {
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(coord.x, 1.4, coord.z);
      pillar.castShadow = opts.enableShadows ?? true;
      landmark.add(pillar);
    }

    // 4. Double-Tiered Curved Pagoda Eaves (Roof)
    // Tier 1: Lower roof canopy
    const roof1Geo = new THREE.BoxGeometry(5.6, 0.14, 4.0);
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x9e1212, // Imperial Vermilion
      roughness: 0.5,
      metalness: 0.15,
    });
    const roof1 = new THREE.Mesh(roof1Geo, roofMat);
    roof1.position.set(0, 2.7, 0);
    roof1.castShadow = opts.enableShadows ?? true;
    landmark.add(roof1);

    // Tier 2: Upper roof peak with gold trim
    const roof2Geo = new THREE.BoxGeometry(4.2, 0.18, 3.0);
    const roof2 = new THREE.Mesh(roof2Geo, roofMat);
    roof2.position.set(0, 3.0, 0);
    roof2.castShadow = opts.enableShadows ?? true;
    landmark.add(roof2);

    // Golden Roof Ridge Finial
    const finialGeo = new THREE.ConeGeometry(0.18, 0.45, 8);
    const finialMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.2 });
    const finial = new THREE.Mesh(finialGeo, finialMat);
    finial.position.set(0, 3.32, 0);
    landmark.add(finial);

    // 5. Signboard Plaque ("老王古玩" - Lao Wang Antiques)
    const signGeo = new THREE.BoxGeometry(2.4, 0.55, 0.08);
    const signMat = new THREE.MeshStandardMaterial({
      color: 0x1a0f08,
      emissive: 0x3d1a00,
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, 2.5, 1.6);
    landmark.add(sign);

    // 6. Inspectable Antique Teapot (Milestone M4 integration target)
    const teapotGroup = new THREE.Group();
    teapotGroup.name = 'item_teapot';
    teapotGroup.userData = {
      itemId: 'teapot',
      inspectable: true,
      title: 'Антикварный исинский чайник',
    };
    teapotGroup.position.set(-0.8, 0.25 + 0.9 + 0.12, 0.3);

    const teapotBodyGeo = new THREE.SphereGeometry(0.14, 12, 10);
    const teapotMat = new THREE.MeshStandardMaterial({
      color: 0x6f2214, // Yixing clay brown
      roughness: 0.45,
      metalness: 0.2,
    });
    const teapotBody = new THREE.Mesh(teapotBodyGeo, teapotMat);
    teapotGroup.add(teapotBody);

    const teapotSpoutGeo = new THREE.CylinderGeometry(0.025, 0.045, 0.16, 8);
    const teapotSpout = new THREE.Mesh(teapotSpoutGeo, teapotMat);
    teapotSpout.rotation.z = Math.PI / 4;
    teapotSpout.position.set(0.14, 0.05, 0);
    teapotGroup.add(teapotSpout);

    landmark.add(teapotGroup);

    // 7. Authentic Jade Ornament on counter
    const jadePlaqueGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.05, 16);
    const jadePlaqueMat = new THREE.MeshStandardMaterial({
      color: 0x38b000,
      roughness: 0.2,
      metalness: 0.1,
      emissive: 0x007200,
      emissiveIntensity: 0.8,
    });
    const jadePlaque = new THREE.Mesh(jadePlaqueGeo, jadePlaqueMat);
    jadePlaque.position.set(0.8, 0.25 + 0.9 + 0.03, 0.3);
    landmark.add(jadePlaque);

    // 8. Lao Wang 3D Avatar Marker (Standing behind counter at z = -0.65)
    const npcAvatar = this.buildLaoWangAvatar();
    npcAvatar.position.set(0, 0.25, -0.65);
    landmark.add(npcAvatar);

    // 9. Two Grand Imperial Lanterns with warm illumination
    const lanternLeft = this.buildLantern(
      { x: -2.1, y: 2.3, z: 1.3, color: 0xff3300, intensity: 1.8, distance: 18 },
      opts,
      true
    );
    landmark.add(lanternLeft);

    const lanternRight = this.buildLantern(
      { x: 2.1, y: 2.3, z: 1.3, color: 0xff4400, intensity: 1.8, distance: 18 },
      opts,
      true
    );
    landmark.add(lanternRight);

    return landmark;
  }

  /**
   * Builds the 3D stylized NPC avatar marker for Lao Wang.
   */
  private static buildLaoWangAvatar(): THREE.Group {
    const npc = new THREE.Group();
    npc.name = 'npc_lao_wang';
    npc.userData = {
      npcId: 'lao_wang',
      isNpc: true,
      interactive: true,
    };

    // Body / Changshan Robe (Imperial Maroon Silk)
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.95, 14);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x6a040f,
      roughness: 0.5,
      metalness: 0.1,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.95 / 2;
    npc.add(body);

    // Head
    const headGeo = new THREE.SphereGeometry(0.22, 14, 14);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xe0a96d, roughness: 0.6 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.95 + 0.22;
    npc.add(head);

    // Traditional Mandarin Cap (Gua Pi Mao / 瓜皮帽)
    const capGeo = new THREE.SphereGeometry(0.23, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.95 + 0.26;
    npc.add(cap);

    // Golden Button on Cap Peak
    const btnGeo = new THREE.SphereGeometry(0.04, 8, 8);
    const btnMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9 });
    const btn = new THREE.Mesh(btnGeo, btnMat);
    btn.position.y = 0.95 + 0.48;
    npc.add(btn);

    // Spectacles / Glasses (Gold rims)
    const glassesGeo = new THREE.BoxGeometry(0.24, 0.05, 0.08);
    const glassesMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9 });
    const glasses = new THREE.Mesh(glassesGeo, glassesMat);
    glasses.position.set(0, 0.95 + 0.24, 0.19);
    npc.add(glasses);

    return npc;
  }
}
