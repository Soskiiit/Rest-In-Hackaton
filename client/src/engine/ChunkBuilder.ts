import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
 * - The single Lao Wang pavilion is built by MarketLayout at the central plaza
 *   (100, 124), so chunk 5_5 is procedural like every other chunk.
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
  maxLightsPerChunk: 1,
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
   * Batches static sub-geometries by material within a group into merged meshes,
   * retaining invisible collision proxies for wall/stall obstacles.
   */
  public static batchStaticGroup(sourceGroup: THREE.Group): THREE.Group {
    sourceGroup.updateMatrixWorld(true);
    const inverseSource = new THREE.Matrix4().copy(sourceGroup.matrixWorld).invert();

    interface Bucket {
      material: THREE.Material;
      geometries: THREE.BufferGeometry[];
      castShadow: boolean;
      receiveShadow: boolean;
    }
    const buckets = new Map<string, Bucket>();
    const proxies: THREE.Mesh[] = [];

    sourceGroup.traverse((child) => {
      if ((child as any).userData?.isWall || (child as any).userData?.isStall) {
        const mesh = child as THREE.Mesh;
        const proxy = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial());
        const localMat = new THREE.Matrix4().multiplyMatrices(inverseSource, mesh.matrixWorld);
        localMat.decompose(proxy.position, proxy.quaternion, proxy.scale);
        proxy.updateMatrix();
        proxy.matrixAutoUpdate = false;
        proxy.userData = { ...mesh.userData };
        proxy.visible = false;
        proxies.push(proxy);
      }

      if ((child as any).isMesh) {
        const mesh = child as THREE.Mesh;
        const mat = mesh.material as any;
        const key = `${mat.type}_${mat.color ? mat.color.getHex() : ''}_${mat.roughness}_${mat.metalness}_${mat.map ? mat.map.uuid : ''}_${mat.emissive ? mat.emissive.getHex() : ''}_${mat.emissiveIntensity}_${mesh.castShadow}_${mesh.receiveShadow}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            material: mat,
            geometries: [],
            castShadow: mesh.castShadow,
            receiveShadow: mesh.receiveShadow,
          });
        }
        const clonedGeo = mesh.geometry.clone();
        const localMat = new THREE.Matrix4().multiplyMatrices(inverseSource, mesh.matrixWorld);
        clonedGeo.applyMatrix4(localMat);
        buckets.get(key)!.geometries.push(clonedGeo);
      }
    });

    const mergedGroup = new THREE.Group();
    mergedGroup.name = sourceGroup.name;

    for (const proxy of proxies) {
      mergedGroup.add(proxy);
    }

    for (const [_, bucket] of buckets.entries()) {
      if (bucket.geometries.length === 0) continue;
      const mergedGeo = BufferGeometryUtils.mergeGeometries(bucket.geometries, false);
      for (const g of bucket.geometries) {
        g.dispose();
      }
      if (mergedGeo) {
        const mergedMesh = new THREE.Mesh(mergedGeo, bucket.material);
        mergedMesh.castShadow = bucket.castShadow;
        mergedMesh.receiveShadow = bucket.receiveShadow;
        mergedMesh.matrixAutoUpdate = false;
        mergedMesh.updateMatrix();
        mergedGroup.add(mergedMesh);
      }
    }

    return mergedGroup;
  }

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

    const chunkGroup = new THREE.Group();
    chunkGroup.name = `chunk_${chunkId}`;
    chunkGroup.position.set(cx * 20, 0, cz * 20);
    chunkGroup.userData = {
      chunkId,
      cx,
      cz,
    };

    // 1. Ground Tile (PlaneGeometry 20x20)
    const groundMesh = this.buildGroundTile(cx, cz, opts);
    chunkGroup.add(groundMesh);

    // 2. Procedural Night Market Generation
    const seed = (cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9;
    const rng = new SeededRandom(seed);

    const stalls = this.generateProceduralStalls(rng, cx, cz, opts);
    chunkGroup.add(this.batchStaticGroup(stalls));

    const proceduralProps = this.generateProceduralProps(rng, opts);
    chunkGroup.add(this.batchStaticGroup(proceduralProps));

    // Freeze local matrices on all static meshes to eliminate scene.updateMatrixWorld CPU overhead
    chunkGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.matrixAutoUpdate = false;
        child.updateMatrix();
      }
    });

    return chunkGroup;
  }

  /**
   * Generates realistic traditional Chinese architecture:
   * 1. Multi-story building facades behind the stalls on both sides (x <= 4 and x >= 16)
   * 2. Traditional curved pagoda tile roofs (grey/terracotta eaves)
   * 3. Glowing Chinese shop signboards (vertical neon/wood boards with red/gold glow)
   * 4. Overhead wires with hanging red lanterns stretched across the entire street (exactly like reference photo!)
   */
  public static generateStreetFacadesAndOverhead(opts: ChunkBuilderOptions): THREE.Group {
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

    const grassTex = this.getGrassTexture();
    const matConfig: THREE.MeshStandardMaterialParameters = {
      color: grassTex ? 0xffffff : (opts.pavementColor ?? SCENE_COLORS.floorColor),
      roughness: 0.9,
      metalness: 0.05,
    };
    if (grassTex) {
      matConfig.map = grassTex;
    }

    const mat = new THREE.MeshStandardMaterial(matConfig);

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

    let slots: Array<{ x: number; z: number; rotY: number }>;

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

  // Cached shared wood plank texture for counters
  private static woodTexture: THREE.CanvasTexture | null = null;
  // Cached shared brushed metal texture for support poles
  private static metalTexture: THREE.CanvasTexture | null = null;
  // Cached shared pleated paper texture for Chinese lanterns
  private static lanternPaperTexture: THREE.CanvasTexture | null = null;
  // Cached shared signboard textures per stall type
  private static signboardTextures: Map<string, THREE.CanvasTexture> = new Map();
  // Cached shared grass texture for chunk ground tiles
  private static grassTexture: THREE.CanvasTexture | null = null;
  // Cached shared wooden crate texture
  private static crateTexture: THREE.CanvasTexture | null = null;
  // Cached shared wine/ceramic barrel texture
  private static barrelTexture: THREE.CanvasTexture | null = null;

  /**
   * Generates authentic wooden freight crate texture with corner iron brackets and cross braces.
   */
  public static getCrateTexture(): THREE.Texture | null {
    if (this.crateTexture) return this.crateTexture;
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // 1. Warm pine wood plank background
    ctx.fillStyle = '#8a5a36';
    ctx.fillRect(0, 0, 256, 256);

    // 4 horizontal wood planks with grain
    const plankH = 256 / 4;
    for (let p = 0; p < 4; p++) {
      const py = p * plankH;
      // Plank seam
      ctx.fillStyle = '#4a2f1c';
      ctx.fillRect(0, py, 256, 3);

      // Fine grain
      for (let y = py + 3; y < py + plankH; y += 3) {
        const hash = Math.sin(y * 73.1 + p * 19.4) * 1000;
        const val = (hash - Math.floor(hash)) * 0.12;
        ctx.fillStyle = val > 0.06 ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.08)';
        ctx.fillRect(0, y, 256, 1.5);
      }
    }

    // 2. Thick outer wooden frame
    ctx.fillStyle = '#6e4426';
    ctx.fillRect(0, 0, 256, 20);
    ctx.fillRect(0, 236, 256, 20);
    ctx.fillRect(0, 0, 20, 256);
    ctx.fillRect(236, 0, 20, 256);

    // 3. Diagonal wooden cross brace
    ctx.strokeStyle = '#633c20';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(244, 244);
    ctx.stroke();

    // 4. Blackened iron corner brackets with brass rivets
    ctx.fillStyle = '#222224';
    const corners = [
      [0, 0], [226, 0], [0, 226], [226, 226]
    ];
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx, cy, 30, 30);
    }

    // Rivet dots
    ctx.fillStyle = '#caa152';
    const rivets = [
      [15, 15], [241, 15], [15, 241], [241, 241],
      [128, 12], [128, 244], [12, 128], [244, 128]
    ];
    for (const [rx, ry] of rivets) {
      ctx.beginPath();
      ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.crateTexture = tex;
    return tex;
  }

  /**
   * Generates traditional Chinese ceramic wine/oil barrel texture with glazed body and red seal cloth.
   */
  public static getBarrelTexture(): THREE.Texture | null {
    if (this.barrelTexture) return this.barrelTexture;
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // 1. Rich terracotta/earthenware stoneware body
    ctx.fillStyle = '#4a2c1d';
    ctx.fillRect(0, 0, 512, 256);

    // Glaze sheen and vertical stoneware staves
    for (let x = 0; x < 512; x += 32) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(x, 0, 2, 256);
    }

    // 2. Heavy wrought iron hoops / bands (top, middle, bottom)
    const bandYs = [30, 115, 210];
    for (const by of bandYs) {
      // Iron strap
      ctx.fillStyle = '#1c1b1a';
      ctx.fillRect(0, by, 512, 16);
      // Metallic highlight on band
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(0, by + 2, 512, 3);
      // Studs/rivets along the iron hoop
      ctx.fillStyle = '#b5924d';
      for (let rx = 16; rx < 512; rx += 48) {
        ctx.beginPath();
        ctx.arc(rx, by + 8, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. Central traditional Chinese Calligraphy seal "酒" (Fine Wine / Spirits)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Red diamond label in center
    ctx.save();
    ctx.translate(256, 128);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#b7094c';
    ctx.fillRect(-28, -28, 56, 56);
    ctx.strokeStyle = '#f4d06f';
    ctx.lineWidth = 2;
    ctx.strokeRect(-28, -28, 56, 56);
    ctx.restore();

    ctx.font = 'bold 36px "Songti SC", "SimSun", serif';
    ctx.fillStyle = '#ffeaa7';
    ctx.fillText('酒', 256, 128);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.barrelTexture = tex;
    return tex;
  }

  /**
   * Generates procedural grass texture for ground tiles.
   */
  public static getGrassTexture(): THREE.Texture | null {
    if (this.grassTexture) {
      return this.grassTexture;
    }
    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // 1. Base is exactly SCENE_COLORS.floorColor (#4f7d2c)
    // The canvas is fully filled with the exact floorColor so the base floor tone is 100% preserved
    ctx.fillStyle = '#4f7d2c';
    ctx.fillRect(0, 0, 512, 512);

    // 2. Visible yet balanced organic grass & moss patches
    for (let i = 0; i < 40; i++) {
      const cx = (Math.sin(i * 19.3) * 0.5 + 0.5) * 512;
      const cy = (Math.cos(i * 29.7) * 0.5 + 0.5) * 512;
      const rad = 25 + (i % 6) * 16;

      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, rad);
      if (i % 2 === 0) {
        grad.addColorStop(0, 'rgba(52, 90, 28, 0.28)'); // natural shadow
        grad.addColorStop(1, 'rgba(79, 125, 44, 0)');
      } else {
        grad.addColorStop(0, 'rgba(115, 175, 65, 0.28)'); // sunlit fresh patch
        grad.addColorStop(1, 'rgba(79, 125, 44, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Crisp, well-defined grass blades across the lawn
    for (let b = 0; b < 2400; b++) {
      const bx = ((b * 137.5) % 512);
      const by = ((b * 269.3) % 512);
      const bladeH = 5 + (b % 6);
      const angle = (Math.sin(b * 12.3) * 0.42);

      const colorVariant = b % 4;
      if (colorVariant === 0) {
        ctx.strokeStyle = 'rgba(52, 90, 28, 0.42)'; // darker blade
      } else if (colorVariant === 1) {
        ctx.strokeStyle = 'rgba(115, 175, 65, 0.45)'; // bright blade
      } else if (colorVariant === 2) {
        ctx.strokeStyle = 'rgba(64, 106, 36, 0.38)'; // medium blade
      } else {
        ctx.strokeStyle = 'rgba(138, 198, 75, 0.35)'; // light clover blade
      }

      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.sin(angle) * bladeH, by - Math.cos(angle) * bladeH);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(5, 5); // 5x5 repeating for 20m chunk
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    this.grassTexture = texture;
    return texture;
  }

  /**
   * Generates a traditional wooden calligraphy signboard texture with gold/black characters and red seal.
   */
  public static getSignboardTexture(type: string): THREE.Texture | null {
    if (this.signboardTextures.has(type)) {
      return this.signboardTextures.get(type)!;
    }

    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;

    // 1. Dark lacquered wood plaque background
    ctx.fillStyle = '#2b170e';
    ctx.fillRect(0, 0, 512, 160);

    // Subtle horizontal wood grain on the plaque
    for (let y = 0; y < 160; y += 4) {
      const gHash = Math.abs(Math.sin(y * 88.3) * 100);
      const intensity = (gHash - Math.floor(gHash)) * 0.08;
      ctx.fillStyle = `rgba(0, 0, 0, ${intensity})`;
      ctx.fillRect(0, y, 512, 2);
    }

    // 2. Ornate gold inner and outer border trim
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 496, 144);

    ctx.strokeStyle = 'rgba(212, 175, 55, 0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 16, 480, 128);

    // Corner decorative brass bracket dots
    ctx.fillStyle = '#f3c053';
    for (const cx of [18, 494]) {
      for (const cy of [18, 142]) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. Shop sign titles matching stall themes
    const signTitles: Record<string, { chinese: string; pinyin: string }> = {
      tea: { chinese: '品茗茶舍', pinyin: 'FINE TEA HOUSE' },
      jade: { chinese: '翠玉古閣', pinyin: 'JADE & GEMS' },
      noodles: { chinese: '百年老麵', pinyin: 'NOODLE KITCHEN' },
      scrolls: { chinese: '文墨翰林', pinyin: 'BOOKS & SCROLLS' },
      herbs: { chinese: '百草同仁', pinyin: 'HERBAL APOTHECARY' },
      weapons: { chinese: '神兵鐵莊', pinyin: 'WEAPONS & BLADES' },
      general: { chinese: '萬寶雜貨', pinyin: 'MARKET TREASURES' },
    };

    const info = signTitles[type] ?? { chinese: '老街名鋪', pinyin: 'SPECIALTY SHOP' };

    // 4. Large embossed golden Chinese Calligraphy characters
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px "Songti SC", "SimSun", "Noto Serif SC", serif';

    // Character drop shadow for 3D engraved look
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillText(info.chinese, 242, 68);

    // Golden characters
    ctx.fillStyle = '#ffdf78';
    ctx.fillText(info.chinese, 240, 66);

    // 5. English / Pinyin subtitle underneath
    ctx.font = 'bold 15px "Cinzel", "Times New Roman", serif';
    ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
    ctx.letterSpacing = '3px';
    ctx.fillText(info.pinyin, 240, 118);

    // 6. Traditional red square cinnabar artist seal stamp on the right
    ctx.fillStyle = '#b7094c';
    ctx.fillRect(430, 48, 42, 42);
    ctx.strokeStyle = '#890620';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(430, 48, 42, 42);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px serif';
    ctx.fillText('御印', 451, 69);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    this.signboardTextures.set(type, texture);
    return texture;
  }

  /**
   * Generates an authentic pleated paper texture with horizontal ribbing/folds
   * and translucent glow for Chinese lanterns.
   */
  public static getLanternPaperTexture(): THREE.Texture | null {
    if (this.lanternPaperTexture) {
      return this.lanternPaperTexture;
    }

    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // 1. Base vibrant lantern red-orange background
    ctx.fillStyle = '#e63900';
    ctx.fillRect(0, 0, 512, 512);

    const ribs = 16; // 16 horizontal paper pleat folds/rings
    const ribHeight = 512 / ribs;

    // 2. Horizontal pleats: shadow in crease and bright highlight along fold crest
    for (let i = 0; i < ribs; i++) {
      const y = i * ribHeight;

      // Dark creased groove (paper fold shadow)
      ctx.fillStyle = 'rgba(70, 5, 0, 0.45)';
      ctx.fillRect(0, y, 512, 3);

      // Soft shadow transition below the crease
      const shadowGrad = ctx.createLinearGradient(0, y, 0, y + ribHeight * 0.4);
      shadowGrad.addColorStop(0, 'rgba(80, 10, 0, 0.35)');
      shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(0, y, 512, ribHeight * 0.4);

      // Bright translucent crest highlight where internal light shines through thin paper
      const crestY = y + ribHeight * 0.55;
      const highlightGrad = ctx.createLinearGradient(0, crestY - 4, 0, crestY + 6);
      highlightGrad.addColorStop(0, 'rgba(255, 235, 150, 0)');
      highlightGrad.addColorStop(0.5, 'rgba(255, 240, 180, 0.4)');
      highlightGrad.addColorStop(1, 'rgba(255, 235, 150, 0)');
      ctx.fillStyle = highlightGrad;
      ctx.fillRect(0, crestY - 4, 512, 10);

      // Fine wire rib line (thin internal bamboo/wire ring)
      ctx.strokeStyle = 'rgba(255, 220, 120, 0.5)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(0, crestY);
      ctx.lineTo(512, crestY);
      ctx.stroke();
    }

    // 3. Subtle vertical paper fiber texture
    for (let x = 0; x < 512; x += 3) {
      const hash = Math.abs(Math.sin(x * 79.19) * 1000);
      const rand = hash - Math.floor(hash);
      if (rand > 0.6) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${(rand - 0.6) * 0.08})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 512);
        ctx.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1, 1);

    this.lanternPaperTexture = texture;
    return texture;
  }

  /**
   * Generates a realistic brushed metal texture for support poles.
   */
  public static getMetalTexture(): THREE.Texture | null {
    if (this.metalTexture) {
      return this.metalTexture;
    }

    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // 1. Base metal grey background
    ctx.fillStyle = '#9e9e9e';
    ctx.fillRect(0, 0, 256, 256);

    // 2. Vertical brushed metal streaks and micro-scratches
    for (let x = 0; x < 256; x += 1) {
      const hash = Math.abs(Math.sin(x * 127.1) * 10000);
      const rand = hash - Math.floor(hash);

      // Alternating light/dark subtle streaks
      if (rand > 0.5) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${(rand - 0.5) * 0.22})`;
      } else {
        ctx.strokeStyle = `rgba(30, 30, 30, ${rand * 0.25})`;
      }
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }

    // 3. Subtle horizontal wear & patina bands
    for (let y = 0; y < 256; y += 16) {
      const bandHash = Math.abs(Math.sin(y * 43.7) * 1000);
      const intensity = (bandHash - Math.floor(bandHash)) * 0.08;
      ctx.fillStyle = `rgba(0, 0, 0, ${intensity})`;
      ctx.fillRect(0, y, 256, 6);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 4);

    this.metalTexture = texture;
    return texture;
  }

  /**
   * Generates a subtle, semi-transparent wood grain and plank texture for stalls.
   */
  public static getWoodTexture(): THREE.Texture | null {
    if (this.woodTexture) {
      return this.woodTexture;
    }

    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // 1. Base wood tone (warm rich dark wood matching tentBaseColor #5a3825)
    ctx.fillStyle = '#5a3825';
    ctx.fillRect(0, 0, 512, 512);

    const planks = 8;
    const plankHeight = 512 / planks; // 64px per horizontal plank

    // 2. Soft horizontal wood grain lines and plank variations
    for (let p = 0; p < planks; p++) {
      const y = p * plankHeight;

      // Slight plank shade variation (semi-transparent)
      const shade = (Math.sin(p * 45.3) * 0.5 + 0.5);
      if (shade > 0.5) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + (shade - 0.5) * 0.05})`;
      } else {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.05 + shade * 0.08})`;
      }
      ctx.fillRect(0, y, 512, plankHeight);

      // Fine organic wood grain streaks
      for (let g = 0; g < 6; g++) {
        const streakY = y + (g + 0.5) * (plankHeight / 6) + (Math.sin(g * 12.4) * 2);
        ctx.strokeStyle = (g % 2 === 0) ? 'rgba(25, 12, 5, 0.18)' : 'rgba(255, 235, 210, 0.05)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, streakY);
        // Subtle wave along the grain
        ctx.bezierCurveTo(
          128, streakY + Math.sin(p + g) * 3,
          384, streakY - Math.sin(p - g) * 3,
          512, streakY
        );
        ctx.stroke();
      }

      // Plank separator groove (dark thin seam)
      ctx.strokeStyle = 'rgba(20, 10, 5, 0.45)';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();

      // Top edge highlight for bevel
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(0, y + 2);
      ctx.lineTo(512, y + 2);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);

    this.woodTexture = texture;
    return texture;
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

    const woodTex = this.getWoodTexture();

    // 1. Counter Base (Wooden cabinet with soft wood plank texture)
    const baseGeo = new THREE.BoxGeometry(3.0, 0.85, 1.2);
    const baseMatConfig: THREE.MeshStandardMaterialParameters = {
      color: woodTex ? 0xffffff : SCENE_COLORS.tentBaseColor,
      roughness: 0.75,
      metalness: 0.08,
    };
    if (woodTex) {
      baseMatConfig.map = woodTex;
    }
    const baseMat = new THREE.MeshStandardMaterial(baseMatConfig);
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.85 / 2;
    baseMesh.castShadow = opts.enableShadows ?? true;
    baseMesh.receiveShadow = opts.enableShadows ?? true;
    baseMesh.userData = { isWall: true, isStall: true };
    stall.add(baseMesh);

    // Front Wooden Signboard Plaque mounted on the front wooden facade facing customers (+Z side)
    const signTex = this.getSignboardTexture(config.stallType ?? 'general');
    const signGeo = new THREE.BoxGeometry(1.6, 0.42, 0.04);
    const signMatConfig: THREE.MeshStandardMaterialParameters = {
      color: signTex ? 0xffffff : 0x2b170e,
      roughness: 0.4,
      metalness: 0.2,
    };
    if (signTex) {
      signMatConfig.map = signTex;
    }
    const signMesh = new THREE.Mesh(signGeo, new THREE.MeshStandardMaterial(signMatConfig));
    // Positioned centered on the front facade of the counter (+Z face: 1.2/2 = 0.60m + 0.025m)
    signMesh.position.set(0, 0.48, 0.625);
    signMesh.castShadow = opts.enableShadows ?? true;
    stall.add(signMesh);

    // 2. Counter Top (Slightly larger tabletop with matching wood texture)
    const topGeo = new THREE.BoxGeometry(3.2, 0.08, 1.4);
    const topMatConfig: THREE.MeshStandardMaterialParameters = {
      color: woodTex ? 0xffffff : SCENE_COLORS.tentBaseColor,
      roughness: 0.6,
      metalness: 0.12,
    };
    if (woodTex) {
      topMatConfig.map = woodTex;
    }
    const topMat = new THREE.MeshStandardMaterial(topMatConfig);
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.y = 0.85 + 0.04;
    topMesh.castShadow = opts.enableShadows ?? true;
    topMesh.receiveShadow = opts.enableShadows ?? true;
    topMesh.userData = { isWall: true, isStall: true };
    stall.add(topMesh);

    // 3. Four Metal Support Posts
    const metalTex = this.getMetalTexture();
    const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.3, 12);
    const postMatConfig: THREE.MeshStandardMaterialParameters = {
      color: metalTex ? 0xffffff : SCENE_COLORS.tentPoleColor,
      roughness: 0.35,
      metalness: 0.85,
    };
    if (metalTex) {
      postMatConfig.map = metalTex;
    }
    const postMat = new THREE.MeshStandardMaterial(postMatConfig);
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

    // 7. Hanging Lantern (Hangs from the front-right corner post of the stall, under the eave)
    if (config.hasLantern) {
      const lanternGroup = this.buildLantern(
        {
          x: 1.45,
          y: 1.60,
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
      // 1. Ornate Ceramic Teapot with handle and spout
      const potBodyGeo = new THREE.SphereGeometry(0.18, 14, 12);
      const ceramicMat = new THREE.MeshStandardMaterial({
        color: 0x5a1805, // Rich Yixing clay terracotta purple-brown
        roughness: 0.28,
        metalness: 0.15,
      });
      const potBody = new THREE.Mesh(potBodyGeo, ceramicMat);
      potBody.position.set(-0.6, yTop + 0.18, 0);
      potBody.scale.set(1.0, 0.85, 1.0);
      potBody.castShadow = opts.enableShadows ?? true;
      stall.add(potBody);

      // Teapot lid & brass finial
      const lidGeo = new THREE.CylinderGeometry(0.09, 0.10, 0.04, 12);
      const lid = new THREE.Mesh(lidGeo, ceramicMat);
      lid.position.set(-0.6, yTop + 0.32, 0);
      stall.add(lid);

      const finialGeo = new THREE.SphereGeometry(0.03, 8, 8);
      const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.2 });
      const finial = new THREE.Mesh(finialGeo, goldMat);
      finial.position.set(-0.6, yTop + 0.36, 0);
      stall.add(finial);

      // Teapot curved handle
      const handleGeo = new THREE.TorusGeometry(0.12, 0.022, 8, 16, Math.PI);
      const handle = new THREE.Mesh(handleGeo, ceramicMat);
      handle.position.set(-0.76, yTop + 0.21, 0);
      handle.rotation.y = Math.PI / 2;
      handle.rotation.z = Math.PI / 2;
      stall.add(handle);

      // Teapot curved pouring spout
      const spoutGeo = new THREE.CylinderGeometry(0.025, 0.04, 0.14, 8);
      const spout = new THREE.Mesh(spoutGeo, ceramicMat);
      spout.position.set(-0.46, yTop + 0.22, 0);
      spout.rotation.z = -Math.PI / 3.5;
      stall.add(spout);

      // 2. Bamboo tea serving tray with white porcelain cups
      const trayGeo = new THREE.BoxGeometry(0.75, 0.03, 0.45);
      const trayMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.7 });
      const tray = new THREE.Mesh(trayGeo, trayMat);
      tray.position.set(0.15, yTop + 0.015, 0);
      stall.add(tray);

      const cupGeo = new THREE.CylinderGeometry(0.055, 0.035, 0.075, 10);
      const porcelainMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.18, metalness: 0.08 });
      for (let i = 0; i < 4; i++) {
        const cup = new THREE.Mesh(cupGeo, porcelainMat);
        const col = i % 2;
        const row = Math.floor(i / 2);
        cup.position.set(0.02 + col * 0.22, yTop + 0.065, -0.09 + row * 0.18);
        stall.add(cup);
      }

      // 3. Round green tea canisters with decorative gold lids
      const canGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.38, 14);
      const canMat = new THREE.MeshStandardMaterial({ color: 0x1b4332, roughness: 0.35, metalness: 0.2 });
      const can1 = new THREE.Mesh(canGeo, canMat);
      can1.position.set(0.85, yTop + 0.19, -0.15);
      stall.add(can1);

      const canLidGeo = new THREE.CylinderGeometry(0.125, 0.125, 0.05, 14);
      const canLid1 = new THREE.Mesh(canLidGeo, goldMat);
      canLid1.position.set(0.85, yTop + 0.40, -0.15);
      stall.add(canLid1);

      const can2 = new THREE.Mesh(canGeo, canMat);
      can2.position.set(1.15, yTop + 0.19, 0.1);
      stall.add(can2);

      const canLid2 = new THREE.Mesh(canLidGeo, goldMat);
      canLid2.position.set(1.15, yTop + 0.40, 0.1);
      stall.add(canLid2);
    } else if (type === 'jade') {
      // 1. Dark polished hardwood tray with red velvet interior
      const trayBaseGeo = new THREE.BoxGeometry(1.25, 0.05, 0.7);
      const woodTrayMat = new THREE.MeshStandardMaterial({ color: 0x24140e, roughness: 0.5 });
      const tray = new THREE.Mesh(trayBaseGeo, woodTrayMat);
      tray.position.set(-0.25, yTop + 0.025, 0);
      stall.add(tray);

      const velvetGeo = new THREE.BoxGeometry(1.15, 0.02, 0.6);
      const velvetMat = new THREE.MeshStandardMaterial({ color: 0x660708, roughness: 0.95 });
      const velvet = new THREE.Mesh(velvetGeo, velvetMat);
      velvet.position.set(-0.25, yTop + 0.055, 0);
      stall.add(velvet);

      // 2. Sculpted Chinese Jade Artifacts:
      // A) Carved Jade Bangle Ring (Emerald green)
      const ringGeo = new THREE.TorusGeometry(0.12, 0.035, 12, 24);
      const greenJadeMat = new THREE.MeshStandardMaterial({
        color: 0x2d6a4f,
        roughness: 0.12,
        metalness: 0.1,
        emissive: 0x1b4332,
        emissiveIntensity: 0.45,
      });
      const jadeRing = new THREE.Mesh(ringGeo, greenJadeMat);
      jadeRing.rotation.x = Math.PI / 2;
      jadeRing.position.set(-0.65, yTop + 0.08, 0);
      stall.add(jadeRing);

      // B) Smooth White Jade Pebble Talisman / Bi Disc (Hetian jade)
      const discGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16);
      const whiteJadeMat = new THREE.MeshStandardMaterial({
        color: 0xe8e8e4,
        roughness: 0.15,
        metalness: 0.05,
        emissive: 0xd8e2dc,
        emissiveIntensity: 0.25,
      });
      const biDisc = new THREE.Mesh(discGeo, whiteJadeMat);
      biDisc.position.set(-0.25, yTop + 0.08, 0.08);
      stall.add(biDisc);

      // Red silk cord through disc
      const cordGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.22, 6);
      const redCordMat = new THREE.MeshBasicMaterial({ color: 0xd90429 });
      const redCord = new THREE.Mesh(cordGeo, redCordMat);
      redCord.rotation.x = Math.PI / 2;
      redCord.position.set(-0.25, yTop + 0.085, 0.08);
      stall.add(redCord);

      // C) Carved Lavender Jade Figurine / Dragon Seal
      const sealGeo = new THREE.BoxGeometry(0.12, 0.18, 0.12);
      const lavenderJadeMat = new THREE.MeshStandardMaterial({
        color: 0x9b5de5,
        roughness: 0.15,
        emissive: 0x7209b7,
        emissiveIntensity: 0.35,
      });
      const seal = new THREE.Mesh(sealGeo, lavenderJadeMat);
      seal.position.set(0.15, yTop + 0.15, -0.05);
      stall.add(seal);

      // 3. Ornate Golden Dragon display stand
      const standGeo = new THREE.TorusGeometry(0.22, 0.035, 10, 20);
      const standMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.85, roughness: 0.25 });
      const stand = new THREE.Mesh(standGeo, standMat);
      stand.position.set(0.95, yTop + 0.26, 0);
      stand.rotation.y = Math.PI / 3;
      stall.add(stand);

      const standBase = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.06, 12), standMat);
      standBase.position.set(0.95, yTop + 0.03, 0);
      stall.add(standBase);
    } else if (type === 'noodles') {
      // 1. Stack of bamboo steamer baskets (Dim Sum / Baozi) with woven lids
      const steamerGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.12, 16);
      const steamerMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.85 });
      for (let h = 0; h < 3; h++) {
        const basket = new THREE.Mesh(steamerGeo, steamerMat);
        basket.position.set(-0.75, yTop + 0.06 + h * 0.12, 0);
        stall.add(basket);
      }
      // Steamer wooden rim band
      const steamerLidHandle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 0.06, 8),
        new THREE.MeshStandardMaterial({ color: 0x8c5b36, roughness: 0.7 })
      );
      steamerLidHandle.position.set(-0.75, yTop + 0.44, 0);
      stall.add(steamerLidHandle);

      // 2. Large black cast-iron boiling cooking wok with two metal ear handles
      const wokGeo = new THREE.CylinderGeometry(0.36, 0.22, 0.22, 16);
      const ironMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.85, roughness: 0.3 });
      const wok = new THREE.Mesh(wokGeo, ironMat);
      wok.position.set(0.05, yTop + 0.11, 0);
      stall.add(wok);

      // Glowing hot broth inside wok
      const brothGeo = new THREE.CircleGeometry(0.33, 16);
      const brothMat = new THREE.MeshStandardMaterial({
        color: 0xcc6600,
        emissive: 0xff4400,
        emissiveIntensity: 0.45,
        roughness: 0.1,
      });
      const broth = new THREE.Mesh(brothGeo, brothMat);
      broth.rotation.x = -Math.PI / 2;
      broth.position.set(0.05, yTop + 0.20, 0);
      stall.add(broth);

      // Wok metal ear handles
      const wokHandleGeo = new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI);
      const handleL = new THREE.Mesh(wokHandleGeo, ironMat);
      handleL.position.set(-0.32, yTop + 0.20, 0);
      handleL.rotation.y = -Math.PI / 2;
      stall.add(handleL);

      const handleR = new THREE.Mesh(wokHandleGeo, ironMat);
      handleR.position.set(0.42, yTop + 0.20, 0);
      handleR.rotation.y = Math.PI / 2;
      stall.add(handleR);

      // 3. Ceramic noodle bowls with chopsticks laid across the rim
      const bowlGeo = new THREE.CylinderGeometry(0.15, 0.08, 0.11, 14);
      const redBowlMat = new THREE.MeshStandardMaterial({ color: 0xb5179e, roughness: 0.25 });
      const chopsticksMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.6 });
      const noodleMat = new THREE.MeshStandardMaterial({ color: 0xf5ee9e, roughness: 0.5 });

      const bowlPositions = [
        { x: 0.8, z: -0.12 },
        { x: 1.15, z: 0.10 },
      ];

      for (const bp of bowlPositions) {
        const bowl = new THREE.Mesh(bowlGeo, redBowlMat);
        bowl.position.set(bp.x, yTop + 0.055, bp.z);
        stall.add(bowl);

        // Noodles inside bowl
        const noodles = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 12), noodleMat);
        noodles.position.set(bp.x, yTop + 0.09, bp.z);
        stall.add(noodles);

        // Bamboo chopsticks pair laid across bowl
        for (let c = 0; c < 2; c++) {
          const chopstick = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.004, 0.32, 6), chopsticksMat);
          chopstick.rotation.z = Math.PI / 2;
          chopstick.position.set(bp.x, yTop + 0.12, bp.z - 0.02 + c * 0.04);
          stall.add(chopstick);
        }
      }
    } else if (type === 'scrolls') {
      // 1. Wooden book/scroll display stand
      const standBaseGeo = new THREE.BoxGeometry(0.9, 0.04, 0.45);
      const standWoodMat = new THREE.MeshStandardMaterial({ color: 0x3d2314, roughness: 0.7 });
      const stand = new THREE.Mesh(standBaseGeo, standWoodMat);
      stand.position.set(-0.45, yTop + 0.02, 0);
      stall.add(stand);

      // 2. Open parchment scroll laid out flat on the table with calligraphy weights
      const openScrollGeo = new THREE.BoxGeometry(0.75, 0.015, 0.38);
      const parchmentMat = new THREE.MeshStandardMaterial({ color: 0xf5ebd0, roughness: 0.85 });
      const openScroll = new THREE.Mesh(openScrollGeo, parchmentMat);
      openScroll.position.set(-0.45, yTop + 0.045, 0);
      stall.add(openScroll);

      // Rolled edges of the scroll at both ends (compact rolled parchment cylinders)
      const rolledEdgeGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8);
      const leftRoll = new THREE.Mesh(rolledEdgeGeo, parchmentMat);
      leftRoll.rotation.x = Math.PI / 2;
      leftRoll.position.set(-0.82, yTop + 0.06, 0);
      stall.add(leftRoll);

      const rightRoll = new THREE.Mesh(rolledEdgeGeo, parchmentMat);
      rightRoll.rotation.x = Math.PI / 2;
      rightRoll.position.set(-0.08, yTop + 0.06, 0);
      stall.add(rightRoll);

      // 3. Stack of traditional silk-bound ancient books
      const bookColors = [0x1d3557, 0x780000, 0x283618];
      for (let b = 0; b < 3; b++) {
        const bookGeo = new THREE.BoxGeometry(0.32, 0.045, 0.42);
        const bookMat = new THREE.MeshStandardMaterial({ color: bookColors[b], roughness: 0.6 });
        const book = new THREE.Mesh(bookGeo, bookMat);
        // Slight natural rotation offset for the stack
        book.rotation.y = (b * 0.08) - 0.06;
        book.position.set(0.4, yTop + 0.025 + b * 0.046, 0);
        stall.add(book);
      }

      // 4. Black calligraphy inkstone and brush
      const inkGeo = new THREE.BoxGeometry(0.22, 0.035, 0.28);
      const inkMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.1 });
      const ink = new THREE.Mesh(inkGeo, inkMat);
      ink.position.set(0.85, yTop + 0.018, -0.08);
      stall.add(ink);

      // Calligraphy brush resting on brush rest
      const brushGeo = new THREE.CylinderGeometry(0.012, 0.008, 0.32, 6);
      const brushMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.5 });
      const brush = new THREE.Mesh(brushGeo, brushMat);
      brush.rotation.z = Math.PI / 2.3;
      brush.rotation.y = Math.PI / 6;
      brush.position.set(0.85, yTop + 0.045, 0.12);
      stall.add(brush);
    } else if (type === 'herbs') {
      // 1. Herbal Medicine Apothecary Chest (multi-drawer wooden box)
      const cabinetGeo = new THREE.BoxGeometry(0.75, 0.45, 0.35);
      const woodChestMat = new THREE.MeshStandardMaterial({ color: 0x3d2012, roughness: 0.65 });
      const cabinet = new THREE.Mesh(cabinetGeo, woodChestMat);
      cabinet.position.set(-0.65, yTop + 0.225, -0.15);
      stall.add(cabinet);

      // Brass ring pulls on apothecary drawers (3x2 grid)
      const brassPullMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.85, roughness: 0.25 });
      const ringPullGeo = new THREE.TorusGeometry(0.02, 0.005, 6, 12);
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 3; c++) {
          const pull = new THREE.Mesh(ringPullGeo, brassPullMat);
          pull.position.set(-0.85 + c * 0.20, yTop + 0.14 + r * 0.17, 0.03);
          stall.add(pull);
        }
      }

      // 2. Ceramic pharmacy jars with red paper cloth ties
      const jarGeo = new THREE.CylinderGeometry(0.11, 0.09, 0.26, 12);
      const jarMat = new THREE.MeshStandardMaterial({ color: 0x22333b, roughness: 0.25 });
      const redCapMat = new THREE.MeshStandardMaterial({ color: 0xba181b, roughness: 0.85 });

      for (let j = 0; j < 3; j++) {
        const jar = new THREE.Mesh(jarGeo, jarMat);
        jar.position.set(0.0 + j * 0.26, yTop + 0.13, -0.12);
        stall.add(jar);

        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.04, 12), redCapMat);
        cap.position.set(0.0 + j * 0.26, yTop + 0.27, -0.12);
        stall.add(cap);
      }

      // 3. Stone Mortar and Pestle for grinding traditional remedies
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x495057, roughness: 0.85 });
      const mortar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.10, 0.16, 14), stoneMat);
      mortar.position.set(0.9, yTop + 0.08, 0.05);
      stall.add(mortar);

      // Dried green herbs inside mortar
      const herbFill = new THREE.Mesh(
        new THREE.CircleGeometry(0.14, 12),
        new THREE.MeshStandardMaterial({ color: 0x2d6a4f, roughness: 0.9 })
      );
      herbFill.rotation.x = -Math.PI / 2;
      herbFill.position.set(0.9, yTop + 0.14, 0.05);
      stall.add(herbFill);

      // Pestle standing tilted in the mortar
      const pestle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.28, 8), stoneMat);
      pestle.rotation.z = Math.PI / 5;
      pestle.position.set(0.92, yTop + 0.16, 0.05);
      stall.add(pestle);
    } else if (type === 'weapons') {
      // 1. Double-Tiered Wooden Weapon Display Rack
      const rackMat = new THREE.MeshStandardMaterial({ color: 0x2b1e16, roughness: 0.7 });
      const rackBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.35), rackMat);
      rackBase.position.set(0.0, yTop + 0.02, 0);
      stall.add(rackBase);

      const postMat = rackMat;
      for (const rx of [-0.35, 0.35]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.38, 0.06), postMat);
        post.position.set(rx, yTop + 0.20, 0);
        stall.add(post);
      }

      // 2. Traditional Chinese Jian (Straight Sword) on the upper tier
      const swordSteel = new THREE.MeshStandardMaterial({ color: 0xe0e1dd, metalness: 0.95, roughness: 0.1 });
      const swordGold = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.85, roughness: 0.2 });

      // Steel blade with central ridge
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.035, 0.008), swordSteel);
      blade.position.set(0.1, yTop + 0.32, 0);
      stall.add(blade);

      // Ornate sword crossguard
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, 0.035), swordGold);
      guard.position.set(-0.45, yTop + 0.32, 0);
      stall.add(guard);

      // Hilt with cord wrap
      const hilt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.016, 0.26, 8),
        new THREE.MeshStandardMaterial({ color: 0x582f0e, roughness: 0.8 })
      );
      hilt.rotation.z = Math.PI / 2;
      hilt.position.set(-0.60, yTop + 0.32, 0);
      stall.add(hilt);

      // Pommel ring
      const pommel = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.008, 6, 12), swordGold);
      pommel.rotation.y = Math.PI / 2;
      pommel.position.set(-0.74, yTop + 0.32, 0);
      stall.add(pommel);

      // Red sword tassel hanging down
      const tassel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.025, 0.18, 6),
        new THREE.MeshBasicMaterial({ color: 0xd90429 })
      );
      tassel.position.set(-0.74, yTop + 0.20, 0);
      stall.add(tassel);

      // 3. Curved Scabbard / Dao Saber on the lower tier
      const scabbardMat = new THREE.MeshStandardMaterial({ color: 0x0d1b2a, roughness: 0.35 });
      const scabbard = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 1.1, 8), scabbardMat);
      scabbard.rotation.z = Math.PI / 2;
      scabbard.position.set(0.05, yTop + 0.14, 0);
      stall.add(scabbard);
    } else {
      // General Goods: Ming-style Blue & White Porcelain Vases and stacked Fortune Baskets
      // 1. Traditional Porcelain Vase (cobalt blue on white)
      const vaseGeo = new THREE.SphereGeometry(0.22, 16, 14);
      const porcelainMat = new THREE.MeshStandardMaterial({ color: 0xf8f9fa, roughness: 0.15, metalness: 0.05 });
      const vase = new THREE.Mesh(vaseGeo, porcelainMat);
      vase.scale.set(0.9, 1.4, 0.9);
      vase.position.set(-0.65, yTop + 0.28, 0);
      stall.add(vase);

      // Cobalt blue neck & flare rim
      const neckMat = new THREE.MeshStandardMaterial({ color: 0x1d3557, roughness: 0.2 });
      const vaseNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.18, 14), neckMat);
      vaseNeck.position.set(-0.65, yTop + 0.52, 0);
      stall.add(vaseNeck);

      // 2. Stacked Wooden Market Produce Crate with red apples/oranges
      const crateGeo = new THREE.BoxGeometry(0.7, 0.18, 0.5);
      const crateWoodMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.8 });
      const crate = new THREE.Mesh(crateGeo, crateWoodMat);
      crate.position.set(0.2, yTop + 0.09, 0);
      stall.add(crate);

      // Bright red-orange festive fruits in the crate
      const fruitMat = new THREE.MeshStandardMaterial({ color: 0xf77f00, roughness: 0.35 });
      const fruitGeo = new THREE.SphereGeometry(0.065, 8, 8);
      for (let fx = 0; fx < 3; fx++) {
        for (let fz = 0; fz < 2; fz++) {
          const fruit = new THREE.Mesh(fruitGeo, fruitMat);
          fruit.position.set(0.05 + fx * 0.14, yTop + 0.18, -0.1 + fz * 0.20);
          stall.add(fruit);
        }
      }

      // 3. Traditional Brass Incense Burner (Censer) with golden smoke handles
      const burnerMat = new THREE.MeshStandardMaterial({ color: 0xca6702, metalness: 0.85, roughness: 0.25 });
      const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.10, 0.12, 12), burnerMat);
      burner.position.set(0.95, yTop + 0.06, 0);
      stall.add(burner);

      const burnerLid = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), burnerMat);
      burnerLid.position.set(0.95, yTop + 0.12, 0);
      stall.add(burnerLid);
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

    // 2. Glowing Lantern Sphere (slightly oblong with pleated paper folds)
    const paperTex = this.getLanternPaperTexture();
    const sphereGeo = new THREE.SphereGeometry(0.25, 24, 20);
    const sphereMatConfig: THREE.MeshStandardMaterialParameters = {
      color: paperTex ? 0xffffff : SCENE_COLORS.lanternBodyColor,
      emissive: SCENE_COLORS.lanternBodyColor,
      emissiveIntensity: 1.25,
      roughness: 0.55,
      metalness: 0.02,
    };
    if (paperTex) {
      sphereMatConfig.map = paperTex;
      sphereMatConfig.emissiveMap = paperTex;
    }
    const sphereMat = new THREE.MeshStandardMaterial(sphereMatConfig);
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
        // Detailed Wooden Freight Crate with iron brackets and corner braces
        const size = rng.range(0.65, 0.85);
        const crateGeo = new THREE.BoxGeometry(size, size, size);
        const crateTex = this.getCrateTexture();
        const crateMat = new THREE.MeshStandardMaterial({
          map: crateTex ?? null,
          color: crateTex ? 0xffffff : 0x7c4f2b,
          roughness: 0.75,
          metalness: 0.15,
        });
        const crate = new THREE.Mesh(crateGeo, crateMat);
        crate.position.set(pt.x, size / 2, pt.z);
        crate.rotation.y = rng.range(0, Math.PI);
        crate.castShadow = opts.enableShadows ?? true;
        crate.receiveShadow = opts.enableShadows ?? true;
        group.add(crate);

        // 35% chance to stack a second smaller crate on top naturally
        if (rng.next() < 0.35) {
          const topSize = size * 0.72;
          const topGeo = new THREE.BoxGeometry(topSize, topSize, topSize);
          const topCrate = new THREE.Mesh(topGeo, crateMat);
          topCrate.position.set(pt.x + rng.range(-0.06, 0.06), size + topSize / 2, pt.z + rng.range(-0.06, 0.06));
          topCrate.rotation.y = crate.rotation.y + rng.range(-0.25, 0.25);
          topCrate.castShadow = opts.enableShadows ?? true;
          topCrate.receiveShadow = opts.enableShadows ?? true;
          group.add(topCrate);
        }
      } else {
        // Detailed Authentic Chinese Wine/Spirits Barrel with iron hoops and lid
        const barrelGroup = new THREE.Group();
        barrelGroup.position.set(pt.x, 0, pt.z);
        barrelGroup.rotation.y = rng.range(0, Math.PI * 2);

        const barrelTex = this.getBarrelTexture();
        const height = 0.85;
        const radius = 0.34;

        // Barrel main belly (slightly bulged cylinder)
        const bellyGeo = new THREE.CylinderGeometry(radius * 0.88, radius * 0.92, height, 16);
        const bellyMat = new THREE.MeshStandardMaterial({
          map: barrelTex ?? null,
          color: barrelTex ? 0xffffff : 0x4a2c1d,
          roughness: 0.55,
          metalness: 0.2,
        });
        const bellyMesh = new THREE.Mesh(bellyGeo, bellyMat);
        bellyMesh.position.y = height / 2;
        bellyMesh.castShadow = opts.enableShadows ?? true;
        bellyMesh.receiveShadow = opts.enableShadows ?? true;
        barrelGroup.add(bellyMesh);

        // Top lid rim with red cloth seal cap
        const capGeo = new THREE.CylinderGeometry(radius * 0.75, radius * 0.8, 0.08, 16);
        const capMat = new THREE.MeshStandardMaterial({
          color: 0x9b111e, // Ruby red cinnabar silk cap
          roughness: 0.7,
        });
        const capMesh = new THREE.Mesh(capGeo, capMat);
        capMesh.position.y = height + 0.03;
        barrelGroup.add(capMesh);

        // Golden twine tying the red cloth lid
        const twineGeo = new THREE.TorusGeometry(radius * 0.76, 0.02, 6, 16);
        const twineMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.5 });
        const twineMesh = new THREE.Mesh(twineGeo, twineMat);
        twineMesh.rotation.x = Math.PI / 2;
        twineMesh.position.y = height + 0.02;
        barrelGroup.add(twineMesh);

        group.add(barrelGroup);
      }
    }

    return group;
  }

  /**
   * Landmark: Lao Wang Pavilion & Avatar Marker.
   * Prominent central landmark in the North Plaza at world (100, 124).
   */
  public static buildLaoWangLandmark(opts: ChunkBuilderOptions = DEFAULT_CHUNK_OPTIONS, includeAvatar: boolean = false): THREE.Group {
    const landmark = new THREE.Group();
    landmark.name = 'lao_wang_landmark';
    // Central pavilion position, facing South towards the player approach.
    landmark.position.set(100, 0, 124);

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

    // 8. Lao Wang 3D Avatar Marker (only if requested or in tests)
    if (includeAvatar) {
      const npcAvatar = this.buildLaoWangAvatar();
      npcAvatar.position.set(0, 0.25, -0.65);
      landmark.add(npcAvatar);
    }

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
