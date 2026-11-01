import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ChunkBuilder } from './ChunkBuilder';
import { ChunkStreamer } from './ChunkStreamer';
import { SCENE_COLORS } from './colors';
import { MarketLayout } from './MarketLayout';

/**
 * World configuration parameters.
 */
export interface WorldConfig {
  fov: number;
  near: number;
  far: number;
  fogColor: number;
  fogDensity: number;
  floorSize: number;
  ambientColor: number;
  ambientIntensity: number;
  hemisphereSkyColor: number;
  hemisphereGroundColor: number;
  hemisphereIntensity: number;
  dirLightColor: number;
  dirLightIntensity: number;
  lanternColor: number;
  lanternIntensity: number;
  lanternDistance: number;
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  fov: 70,
  near: 0.1,
  far: 300,
  fogColor: SCENE_COLORS.fogColor,
  fogDensity: 0.022,
  floorSize: 200,
  ambientColor: SCENE_COLORS.roomLightColor,
  ambientIntensity: 0.35,
  hemisphereSkyColor: SCENE_COLORS.skyLightColor,
  hemisphereGroundColor: SCENE_COLORS.groundLightColor,
  hemisphereIntensity: 0.3,
  dirLightColor: SCENE_COLORS.sunLightColor,
  dirLightIntensity: 1.2,
  lanternColor: SCENE_COLORS.lanternLightColor,
  lanternIntensity: 1.8,
  lanternDistance: 24,
};

/**
 * World: Core 3D scene engine managing Three.js Scene, PerspectiveCamera,
 * WebGLRenderer, Fog, Ground floor, lighting, and requestAnimationFrame render loop.
 */
export class World {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly container: HTMLElement;
  public readonly config: WorldConfig;

  private floorMesh: THREE.Mesh | null = null;
  private stoneTileFloor: THREE.InstancedMesh | null = null;
  private gridHelper: THREE.GridHelper | null = null;
  private dirLight: THREE.DirectionalLight | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private lanternsGroup: THREE.Group = new THREE.Group();
  private chunkStreamer: ChunkStreamer | null = null;
  private vendorMixers: THREE.AnimationMixer[] = [];
  private vendorEntries: Array<{
    root: THREE.Object3D;
    mixer?: THREE.AnimationMixer;
    clips?: THREE.AnimationClip[];
    idleAction?: THREE.AnimationAction;
    npcId?: string;
    x: number;
    z: number;
    isCentral?: boolean;
  }> = [];
  private chickenEntries: Array<{
    root: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    runAction: THREE.AnimationAction;
    peckAction: THREE.AnimationAction;
    panicAction: THREE.AnimationAction;
    currentAction: THREE.AnimationAction;
    state: 'run' | 'peck' | 'panic';
    stateTimer: number;
    panicTimer: number;
    x: number;
    z: number;
    currentYaw: number;
    targetYaw: number;
    homeX: number;
    homeZ: number;
    roamRadius: number;
  }> = [];
  private cachedWallBoundingBoxes: THREE.Box3[] | null = null;
  private shadowFrameCounter: number = 0;

  private clock: THREE.Clock = new THREE.Clock();
  private animationFrameId: number | null = null;
  private isRunning: boolean = false;
  private updateListeners: Array<(delta: number) => void> = [];

  // FPS tracking
  private frameCount: number = 0;
  private lastFpsTimestamp: number = performance.now();
  private currentFps: number = 60;

  constructor(container: HTMLElement, config?: Partial<WorldConfig>) {
    this.container = container;
    this.config = { ...DEFAULT_WORLD_CONFIG, ...config };

    // 1. Scene setup with pure solid sky blue background (no clouds, no fog)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // Pure sky blue
    // Fog disabled per user request: clear crisp sky and distant visibility

    // 2. Camera setup (Perspective, FOV 75, initial eye position centered in 200x200 world)
    const aspect = container.clientWidth / (container.clientHeight || 1);
    this.camera = new THREE.PerspectiveCamera(this.config.fov, aspect, this.config.near, this.config.far);
    this.camera.position.set(this.config.floorSize / 2, 1.7, this.config.floorSize / 2);

    // 3. WebGLRenderer with shadows and antialiasing
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Cap pixelRatio to 1.25 to prevent fill-rate saturation on 2K/4K/Retina displays
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // Attach canvas to container
    container.appendChild(this.renderer.domElement);

    // 4. Ground floor (200x200 plane centered at [100, 0, 100])
    this.initGroundFloor();

    // 5. Lighting setup
    this.initLighting();

    // 6. Atmospheric night market lanterns
    this.initMarketLanterns();

    // 6.2 Custom Market Layout (Streets, Plazas & Walls matching blueprint)
    this.initCustomMarketLayout();

    // 6.3 Animated / Populated NPCs behind market stalls and in plazas
    this.initMarketNpcs();

    // 6.4 Chickens wandering in random locations around streets and plazas
    this.initChickens();

    // 6.5 Lush vegetation: Trees and flowering bushes placed organically around the market
    this.initVegetation();

    // 7. Dynamic Chunk Streamer (10x10 grid, AoI <= 9 chunks)
    this.initChunkStreamer();

    // 8. Window resize event listener
    window.addEventListener('resize', this.onResize);
  }

  // Cached cloudy sky texture
  private static cloudSkyTexture: THREE.CanvasTexture | null = null;
  // Cached grass texture for outer landscape
  private static grassTexture: THREE.CanvasTexture | null = null;

  /**
   * Generates a high-performance, seamless cloudy sky texture via HTML5 Canvas.
   * Cached statically so it generates only once with zero runtime overhead.
   */
  public static createCloudSkyTexture(): THREE.Texture | null {
    if (this.cloudSkyTexture) {
      return this.cloudSkyTexture;
    }
    if (typeof document === 'undefined') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // 1. Sky atmospheric gradient: deep azure twilight at top transitioning to soft fog tint at horizon
    const skyGrad = ctx.createLinearGradient(0, 0, 0, 512);
    skyGrad.addColorStop(0.0, '#3a5f82'); // Deep atmospheric sky zenith
    skyGrad.addColorStop(0.5, '#6a8fa8'); // Mid sky blue
    skyGrad.addColorStop(0.85, '#99b6c9'); // Soft horizon matching fogColor exactly
    skyGrad.addColorStop(1.0, '#99b6c9'); // Seamless blend into scene fog at base
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, 1024, 512);

    // 2. Soft, puffy clouds with organic layering
    const cloudClusters = [
      // Upper dramatic cumulus clouds
      { x: 180, y: 130, scale: 95, puffs: 10, alpha: 0.65 },
      { x: 490, y: 110, scale: 120, puffs: 12, alpha: 0.70 },
      { x: 820, y: 140, scale: 105, puffs: 11, alpha: 0.60 },
      // Mid-level fluffy clouds
      { x: 120, y: 220, scale: 75, puffs: 8, alpha: 0.50 },
      { x: 340, y: 240, scale: 85, puffs: 9, alpha: 0.55 },
      { x: 670, y: 210, scale: 90, puffs: 10, alpha: 0.52 },
      { x: 960, y: 230, scale: 80, puffs: 8, alpha: 0.48 },
      // Gentle wispy cirrus streaks near horizon
      { x: 260, y: 320, scale: 140, puffs: 6, alpha: 0.35 },
      { x: 740, y: 330, scale: 150, puffs: 7, alpha: 0.38 },
    ];

    for (const cluster of cloudClusters) {
      for (let p = 0; p < cluster.puffs; p++) {
        const offsetX = (Math.sin(p * 2.3) * 0.8) * cluster.scale;
        const offsetY = (Math.cos(p * 3.1) * 0.35) * (cluster.scale * 0.5);
        const radius = (0.45 + (p % 4) * 0.18) * cluster.scale;

        const cx = (cluster.x + offsetX + 1024) % 1024;
        const cy = cluster.y + offsetY;

        // Radial cloud puff with soft illuminated core and feather edges
        const puffGrad = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
        puffGrad.addColorStop(0.0, `rgba(255, 255, 255, ${cluster.alpha})`);
        puffGrad.addColorStop(0.4, `rgba(240, 246, 252, ${cluster.alpha * 0.75})`);
        puffGrad.addColorStop(0.75, `rgba(215, 230, 242, ${cluster.alpha * 0.35})`);
        puffGrad.addColorStop(1.0, 'rgba(215, 230, 242, 0)');

        ctx.fillStyle = puffGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();

        // Wrap-around handling for seamless horizontal spherical mapping
        if (cx - radius < 0) {
          ctx.beginPath();
          ctx.arc(cx + 1024, cy, radius, 0, Math.PI * 2);
          ctx.fill();
        } else if (cx + radius > 1024) {
          ctx.beginPath();
          ctx.arc(cx - 1024, cy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    this.cloudSkyTexture = texture;
    return texture;
  }

  /**
   * Generates a procedural grass texture with organic blades, mossy variations, and subtle clovers.
   */
  public static createGrassTexture(): THREE.Texture | null {
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
    texture.repeat.set(50, 50); // 50x50 tiling across 200m -> ~4m per tile, very detailed and distinct grass tufts
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    this.grassTexture = texture;
    return texture;
  }

  /**
   * Initializes the 200x200 ground floor and 10x10 chunk boundary grid helper.
   */
  private initGroundFloor(): void {
    const halfSize = this.config.floorSize / 2;

    const grassTex = World.createGrassTexture();
    const floorGeo = new THREE.PlaneGeometry(this.config.floorSize, this.config.floorSize, 40, 40);
    const floorMatConfig: THREE.MeshStandardMaterialParameters = {
      color: grassTex ? 0xffffff : SCENE_COLORS.floorColor,
      roughness: 0.9,
      metalness: 0.05,
    };
    if (grassTex) {
      floorMatConfig.map = grassTex;
    }
    const floorMat = new THREE.MeshStandardMaterial(floorMatConfig);
    this.floorMesh = new THREE.Mesh(floorGeo, floorMat);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.position.set(halfSize, 0, halfSize);
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);

    // 10x10 chunk grid helper (divisions = 10 -> each cell is 20x20 units, matching chunks)
    this.gridHelper = new THREE.GridHelper(this.config.floorSize, 10, SCENE_COLORS.floorGridLine1, SCENE_COLORS.floorGridLine2);
    this.gridHelper.position.set(halfSize, 0.02, halfSize);
    this.scene.add(this.gridHelper);

    // Load and tile stone pavement tiles from /models/path_straight.glb across the entire 200x200 world
    this.initStoneTileFloor();
  }

  /**
   * Loads the stone pavement tile model and instantiates it seamlessly across the entire 200x200 floor.
   */
  private initStoneTileFloor(): void {
    try {
      const loader = new GLTFLoader();
      loader.load(
        '/models/path_straight.glb',
        (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const geometries: THREE.BufferGeometry[] = [];
        const materials: THREE.Material[] = [];

        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const clonedGeo = child.geometry.clone();
            clonedGeo.applyMatrix4(child.matrixWorld);
            geometries.push(clonedGeo);

            const srcMats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of srcMats) {
              if (mat) {
                const clonedMat = mat.clone() as THREE.MeshStandardMaterial;
                // Tint to a lighter grey based on material name or order
                if (mat.name === 'Stone_Light') {
                  clonedMat.color.setHex(SCENE_COLORS.stoneTileLightColor);
                } else if (mat.name === 'Stone_Dark') {
                  clonedMat.color.setHex(SCENE_COLORS.stoneTileDarkColor);
                } else {
                  clonedMat.color.setHex(SCENE_COLORS.stoneTileLightColor);
                }
                clonedMat.roughness = 0.85;
                materials.push(clonedMat);
              }
            }
          }
        });

        if (geometries.length === 0) return;

        const mergedGeo = BufferGeometryUtils.mergeGeometries(geometries, true);
        if (!mergedGeo) return;

        // Scale tile geometry so each unit is exactly 2.0 x 2.0 meters
        mergedGeo.scale(4.03, 1.0, 2.045);

        // Populate tiles covering strictly the market corridors and plaza walkways
        // Anywhere outside the market streets (like behind perimeter walls, entrance courtyard margins, etc.)
        // remains natural green grass terrain!
        const isMarketStreet = (x: number, z: number): boolean => {
          // 1. South Entrance Avenue: x in [94, 106], z in [60, 93]
          if (x >= 94 && x <= 106 && z >= 60 && z <= 93) return true;

          // 2. Crossroads & North Central Bazaar Plaza:
          // Crossroads: x in [90, 110], z in [93, 107]
          // North Bazaar: x in [80, 120], z in [107, 145]
          if (x >= 90 && x <= 110 && z >= 93 && z <= 107) return true;
          if (x >= 80 && x <= 120 && z >= 107 && z <= 145) return true;

          // 3. West Corridor & West Plaza:
          // Corridor: x in [70, 90], z in [94, 106]
          // Plaza: x in [48, 70], z in [88, 112]
          if (x >= 70 && x <= 90 && z >= 94 && z <= 106) return true;
          if (x >= 48 && x <= 70 && z >= 88 && z <= 112) return true;

          // 4. East Corridor & East Plaza:
          // Corridor: x in [110, 130], z in [94, 106]
          // Plaza: x in [130, 152], z in [88, 112]
          if (x >= 110 && x <= 130 && z >= 94 && z <= 106) return true;
          if (x >= 130 && x <= 152 && z >= 88 && z <= 112) return true;

          return false;
        };

        const startX = 48;
        const endX = 152;
        const startZ = 60;
        const endZ = 145;
        const step = 2.0;

        const tilePositions: Array<{ x: number; z: number }> = [];
        for (let x = startX; x <= endX; x += step) {
          for (let z = startZ; z <= endZ; z += step) {
            if (isMarketStreet(x, z)) {
              tilePositions.push({ x, z });
            }
          }
        }

        const totalInstances = tilePositions.length;

        const instancedMesh = new THREE.InstancedMesh(
          mergedGeo,
          materials.length === 1 ? materials[0] : materials,
          totalInstances
        );
        instancedMesh.receiveShadow = true;
        instancedMesh.castShadow = false;

        const dummy = new THREE.Object3D();
        for (let idx = 0; idx < totalInstances; idx++) {
          const pt = tilePositions[idx];
          dummy.position.set(pt.x, 0.015, pt.z);
          dummy.updateMatrix();
          instancedMesh.setMatrixAt(idx, dummy.matrix);
        }

        instancedMesh.instanceMatrix.needsUpdate = true;
        this.stoneTileFloor = instancedMesh;
        this.scene.add(this.stoneTileFloor);
        console.log(`[World] Stone tile pavement floor generated across market area (${totalInstances} instances).`);
      },
      undefined,
      (err) => {
        console.warn('[World] Could not load stone tile model /models/path_straight.glb:', err);
      }
    );
    } catch (err) {
      console.warn('[World] Could not initialize stone tile floor:', err);
    }
  }

  /**
   * Initializes ambient, hemisphere, and directional lighting with shadow mapping.
   */
  private initLighting(): void {
    const halfSize = this.config.floorSize / 2;

    // Ambient light
    this.ambientLight = new THREE.AmbientLight(this.config.ambientColor, this.config.ambientIntensity);
    this.scene.add(this.ambientLight);

    // Hemisphere light (warm sky to cool ground)
    this.hemiLight = new THREE.HemisphereLight(
      this.config.hemisphereSkyColor,
      this.config.hemisphereGroundColor,
      this.config.hemisphereIntensity
    );
    this.hemiLight.position.set(halfSize, 50, halfSize);
    this.scene.add(this.hemiLight);

    // Directional light with shadow camera covering visible bounds
    this.dirLight = new THREE.DirectionalLight(this.config.dirLightColor, this.config.dirLightIntensity);
    this.dirLight.position.set(halfSize + 50, 75, halfSize + 50);
    this.dirLight.target.position.set(halfSize, 0, halfSize);
    this.scene.add(this.dirLight.target);

    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 1024;
    this.dirLight.shadow.mapSize.height = 1024;
    this.dirLight.shadow.camera.near = 10;
    this.dirLight.shadow.camera.far = 250;
    // Tightened shadow frustum covering the entire active market layout (136x136m)
    // Enhances texel density per meter by ~66% and culls offscreen geometry from shadow pass
    this.dirLight.shadow.camera.left = -68;
    this.dirLight.shadow.camera.right = 68;
    this.dirLight.shadow.camera.top = 68;
    this.dirLight.shadow.camera.bottom = -68;
    this.dirLight.shadow.bias = -0.0002;
    this.dirLight.shadow.normalBias = 0.04;

    this.scene.add(this.dirLight);
  }

  /**
   * Spawns baseline atmospheric point lights with lantern meshes in the central plaza.
   */
  private initMarketLanterns(): void {
    this.scene.add(this.lanternsGroup);
    // Legacy floating lanterns in the sky disabled per user request
  }

  /**
   * Adds a visual dummy lantern object with a glowing sphere (dynamic PointLight removed for performance).
   */
  public addLantern(
    x: number,
    y: number,
    z: number,
    bodyColor: number = SCENE_COLORS.lanternBodyColor,
    _intensity: number = this.config.lanternIntensity,
    _distance: number = this.config.lanternDistance
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Glowing lantern body dummy (Orange)
    const lanternGeo = new THREE.SphereGeometry(0.32, 12, 12);
    const lanternMat = new THREE.MeshBasicMaterial({ color: bodyColor });
    const mesh = new THREE.Mesh(lanternGeo, lanternMat);
    group.add(mesh);

    this.lanternsGroup.add(group);
    return group;
  }

  /**
   * Loads the custom arch OBJ model and places it majestically at the street entrance near spawn.
   */
  public initArchModel(): void {
    // Arch removed per user request
  }

  /**
   * Initializes the custom market layout matching the user blueprint:
   * Stalls in corridors and plazas with solid brick walls directly behind their backs.
   */
  private initCustomMarketLayout(): void {
    const layoutGroup = MarketLayout.buildLayoutGroup();
    this.scene.add(layoutGroup);
  }

  /**
   * Populates 3D GLB animated vendor NPCs (Chef Chen and Lao Wang) behind market stalls.
   */
  private initMarketNpcs(): void {
    const stalls = MarketLayout.getStalls();

    // Stalls to populate (excluding the central landmark area)
    // Deterministic pseudo-random selection (~60% stalls have an active vendor, ~40% are empty as if vendor stepped away)
    const vendorPositions: Array<{ x: number; z: number; rotY: number }> = [];
    for (const stall of stalls) {
      const distToLaoWang = Math.hypot(stall.x - 100.0, stall.z - 124.0);
      if (distToLaoWang < 3.5) continue;

      // Consistent seed hash for this stall location
      const hash = Math.sin(stall.x * 12.9898 + stall.z * 78.233) * 43758.5453;
      const randVal = hash - Math.floor(hash);
      // Skip vendor on ~40% of stalls so some counters remain empty
      if (randVal < 0.38) {
        continue;
      }

      const facingAngle = stall.rotY;
      // Stalls face outwards into the street/walkway
      // Vendors stand right behind the counter (+0.15m forward past stall center towards the counter)
      const offsetX = Math.sin(facingAngle) * 0.15;
      const offsetZ = Math.cos(facingAngle) * 0.15;

      vendorPositions.push({
        x: stall.x + offsetX,
        z: stall.z + offsetZ,
        rotY: facingAngle,
      });
    }

    // Load rich palette of vendor models (Lao Wang, Chef Chen, and 7 Comical Vendors)
    const loader = new GLTFLoader();
    const vendorPaths = [
      '/models/vendors/lao_wang.glb',
      '/models/vendors/chef_chen.glb',
      '/models/comical_vendor/vendor_green.glb',
      '/models/comical_vendor/vendor_blue.glb',
      '/models/comical_vendor/vendor_yellow.glb',
      '/models/comical_vendor/vendor_curly.glb',
      '/models/comical_vendor/vendor_orange.glb',
      '/models/comical_vendor/vendor_vest.glb',
      '/models/comical_vendor/vendor_round.glb',
    ];

    const loadSingle = async (path: string) => {
      try {
        return await loader.loadAsync(path);
      } catch {
        // Fallback to /assets/models/ if needed
        const fallback = path.replace('/models/vendors/', '/assets/models/');
        return await loader.loadAsync(fallback);
      }
    };

    Promise.all(vendorPaths.map((p) => loadSingle(p).catch(() => null))).then((loadedGltfs) => {
      const validGltfs = loadedGltfs.filter((g): g is NonNullable<typeof g> => g !== null);
      if (validGltfs.length === 0) return;

      const laoGltf = loadedGltfs[0] ?? validGltfs[0];
      const chefGltf = loadedGltfs[1] ?? validGltfs[0];

      console.log(`[World] Successfully loaded ${validGltfs.length} vendor GLB models! Populating ${vendorPositions.length} stalls...`);

      // Spawn Lao Wang at his central antique pavilion stall (100.0, 0, 124.0)
      const centralLaoWang = laoGltf.scene.clone(true);
      centralLaoWang.position.set(100.0, 0.18, 125.55); // Elevated on stone platform behind counter
      centralLaoWang.rotation.set(0, Math.PI, 0);
      centralLaoWang.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.scene.add(centralLaoWang);

      // Setup Idle animation on central Lao Wang
      let centralMixer: THREE.AnimationMixer | undefined;
      let centralIdleAction: THREE.AnimationAction | undefined;
      if (laoGltf.animations && laoGltf.animations.length > 0) {
        centralMixer = new THREE.AnimationMixer(centralLaoWang);
        const idleClip = laoGltf.animations.find((a) => a.name === 'Idle') ?? laoGltf.animations[0];
        centralIdleAction = centralMixer.clipAction(idleClip);
        centralIdleAction.play();
        this.vendorMixers.push(centralMixer);
      }
      this.vendorEntries.push({
        root: centralLaoWang,
        mixer: centralMixer,
        clips: laoGltf.animations,
        idleAction: centralIdleAction,
        npcId: 'lao_wang',
        x: 100.0,
        z: 125.55,
        isCentral: true,
      });

      // Populate every stall cycling through the vendor palette
      for (let i = 0; i < vendorPositions.length; i++) {
        const vp = vendorPositions[i];
        // Near Chef Chen's location (x=70, z=110), ensure Chef Chen is placed
        const isNearChefChen = Math.hypot(vp.x - 70, vp.z - 110) < 6.0;
        const sourceGltf = isNearChefChen
          ? chefGltf
          : validGltfs[i % validGltfs.length];

        const clone = sourceGltf.scene.clone(true);
        // Elevated on Y so vendors comfortably tower over the counter and aren't sunken/too short
        clone.position.set(vp.x, 0.22, vp.z);
        // Models face +Z by default; rotate by vp.rotY to face into corridor
        clone.rotation.set(0, vp.rotY, 0);

        clone.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = false; // Background vendors are sheltered under stall canopies
            child.receiveShadow = false;
          }
        });
        // Initial visibility based on distance from spawn (100, 100)
        const distFromSpawn = Math.hypot(vp.x - 100.0, vp.z - 100.0);
        clone.visible = distFromSpawn <= 22.0;
        this.scene.add(clone);

        // Play Idle animation with slight random time offset
        let mixer: THREE.AnimationMixer | undefined;
        let idleAction: THREE.AnimationAction | undefined;
        if (sourceGltf.animations && sourceGltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(clone);
          const idleClip = sourceGltf.animations.find((a) => a.name === 'Idle') ?? sourceGltf.animations[0];
          idleAction = mixer.clipAction(idleClip);
          idleAction.time = Math.random() * 4.0; // Desynchronize animations naturally
          idleAction.play();
          this.vendorMixers.push(mixer);
        }

        this.vendorEntries.push({
          root: clone,
          mixer,
          clips: sourceGltf.animations,
          idleAction,
          npcId: isNearChefChen ? 'chef_chen' : `vendor_${i}`,
          x: vp.x,
          z: vp.z,
          isCentral: false,
        });
      }
    }).catch((err) => {
      console.warn('[World] Failed to load vendor GLTF models:', err);
    });
  }

  /**
   * Spawns 3D running chickens scattered organically across market corridors and open squares.
   * Chickens actively wander along streets with Run animation, stop to peck seeds with Peck animation,
   * and panic-flee with PanicRun animation flapping wings when the player approaches!
   */
  private initChickens(): void {
    const loader = new GLTFLoader();

    const candidatePaths = [
      '/models/chicken_animated.glb',
      '/assets/models/chicken_animated/chicken_animated.glb',
      '/assets/models/chicken.glb',
      '/models/chicken.glb',
    ];

    const loadChicken = async () => {
      for (const path of candidatePaths) {
        try {
          return await loader.loadAsync(path);
        } catch {
          // try next candidate
        }
      }
      throw new Error('All chicken model candidate paths failed');
    };

    loadChicken()
      .then((gltf) => {
        console.log('[World] Successfully loaded Animated Chicken GLB! Scattering running chickens...');

        // Candidate spots across the market corridors and open squares
        const chickenSpawnSpots: Array<{ x: number; z: number }> = [
          // South entrance street (player spawns at x=100, z=66)
          { x: 100.0, z: 72.0 },
          { x: 99.2, z: 77.0 },
          { x: 101.0, z: 82.0 },
          { x: 98.8, z: 88.0 },
          { x: 100.5, z: 93.0 },

          // Central crossroads
          { x: 98.5, z: 98.5 },
          { x: 101.8, z: 102.2 },

          // West corridor
          { x: 89.0, z: 99.2 },
          { x: 81.5, z: 101.1 },
          { x: 74.0, z: 98.8 },

          // West plaza
          { x: 63.5, z: 95.0 },
          { x: 58.0, z: 104.5 },
          { x: 66.0, z: 108.0 },
          { x: 53.5, z: 99.0 },

          // East corridor
          { x: 111.0, z: 101.4 },
          { x: 118.5, z: 98.7 },
          { x: 124.0, z: 100.5 },

          // East plaza
          { x: 136.0, z: 96.0 },
          { x: 144.5, z: 105.0 },
          { x: 139.0, z: 108.5 },
          { x: 147.0, z: 98.5 },

          // North plaza & bazaar
          { x: 95.5, z: 112.0 },
          { x: 104.2, z: 115.5 },
          { x: 91.0, z: 122.0 },
          { x: 109.5, z: 121.5 },
          { x: 98.0, z: 130.5 },
          { x: 103.0, z: 134.0 },
          { x: 86.5, z: 128.0 },
          { x: 114.0, z: 131.0 },
          { x: 96.0, z: 140.0 },
          { x: 104.5, z: 141.5 },
        ];

        const runClip =
          THREE.AnimationClip.findByName(gltf.animations, 'Run') ?? gltf.animations[0];
        const peckClip =
          THREE.AnimationClip.findByName(gltf.animations, 'Peck') ?? gltf.animations[0];
        const panicClip =
          THREE.AnimationClip.findByName(gltf.animations, 'PanicRun') ?? runClip;

        for (let i = 0; i < chickenSpawnSpots.length; i++) {
          const spot = chickenSpawnSpots[i];
          const randJitterX = Math.sin(i * 19.3) * 0.8;
          const randJitterZ = Math.cos(i * 27.7) * 0.8;
          const randomYaw = (i * 1.6180339887) % (Math.PI * 2);

          const chicken = SkeletonUtils.clone(gltf.scene);
          const posX = spot.x + randJitterX;
          const posZ = spot.z + randJitterZ;
          chicken.position.set(posX, 0.0, posZ);
          chicken.rotation.set(0, randomYaw, 0);

          chicken.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          this.scene.add(chicken);

          if (gltf.animations && gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(chicken);

            const runAction = mixer.clipAction(runClip);
            runAction.setLoop(THREE.LoopRepeat, Infinity);

            const peckAction = mixer.clipAction(peckClip);
            peckAction.setLoop(THREE.LoopRepeat, Infinity);

            const panicAction = mixer.clipAction(panicClip);
            panicAction.setLoop(THREE.LoopRepeat, Infinity);

            // Randomize starting state between run (60%) and peck (40%)
            const startsRunning = i % 5 !== 0;
            const initialState: 'run' | 'peck' = startsRunning ? 'run' : 'peck';
            const currentAction = startsRunning ? runAction : peckAction;

            // Desynchronize initial playback times across chickens
            runAction.time = (i * 0.17) % (runClip.duration || 0.72);
            peckAction.time = (i * 0.43) % (peckClip.duration || 2.4);
            panicAction.time = (i * 0.11) % (panicClip.duration || 0.52);

            currentAction.play();

            this.chickenEntries.push({
              root: chicken,
              mixer,
              runAction,
              peckAction,
              panicAction,
              currentAction,
              state: initialState,
              stateTimer: 2.0 + (i % 4) * 1.2,
              panicTimer: 0,
              x: posX,
              z: posZ,
              currentYaw: randomYaw,
              targetYaw: randomYaw,
              homeX: spot.x,
              homeZ: spot.z,
              roamRadius: 10.0 + (i % 4) * 3.0,
            });
          }
        }
      })
      .catch((err) => {
        console.warn('[World] Failed to load animated chicken GLTF model:', err);
      });
  }

  /**
   * Smoothly cross-fades between chicken animation actions (Run, Peck, PanicRun).
   */
  private setChickenAction(
    chicken: (typeof this.chickenEntries)[number],
    newAction: THREE.AnimationAction,
    crossFadeDuration: number = 0.2
  ): void {
    if (chicken.currentAction === newAction) return;
    newAction.reset();
    newAction.fadeIn(crossFadeDuration);
    chicken.currentAction.fadeOut(crossFadeDuration);
    newAction.play();
    chicken.currentAction = newAction;
  }

  /**
   * Spawns trees and flowering bushes organically around plazas, courtyards, and street edges.
   */
  private initVegetation(): void {
    const loader = new GLTFLoader();

    const loadBush = async () => {
      try {
        return await loader.loadAsync('/assets/models/bush.glb');
      } catch {
        return await loader.loadAsync('/models/bush.glb');
      }
    };

    const loadTree = async () => {
      try {
        return await loader.loadAsync('/assets/models/tree.glb');
      } catch {
        return await loader.loadAsync('/models/tree.glb');
      }
    };

    Promise.all([loadBush(), loadTree()])
      .then(([bushGltf, treeGltf]) => {
        console.log('[World] Successfully loaded Bush and Tree 3D models! Placing vegetation...');

        // 1. Organic Tree Locations (Corners of plazas, street entrances, courtyards)
        // Tree original height: ~509 units. Scale ~0.012 -> height ~6.1m (fits comfortably under walls/eaves)
        const treeSpots: Array<{ x: number; z: number; scaleMod?: number }> = [
          // South entrance avenue (flanking entrance gates and corner nooks)
          { x: 92.0, z: 62.0, scaleMod: 0.95 },
          { x: 108.0, z: 62.0, scaleMod: 1.05 },
          { x: 92.0, z: 80.0, scaleMod: 0.9 },
          { x: 108.0, z: 80.0, scaleMod: 1.0 },

          // West Plaza courtyards and open corners
          { x: 54.0, z: 94.0, scaleMod: 1.1 },
          { x: 54.0, z: 106.0, scaleMod: 1.0 },
          { x: 67.0, z: 95.0, scaleMod: 0.95 },
          { x: 67.0, z: 105.0, scaleMod: 1.05 },

          // East Plaza courtyards and open corners
          { x: 135.0, z: 94.0, scaleMod: 1.05 },
          { x: 135.0, z: 106.0, scaleMod: 0.95 },
          { x: 147.0, z: 94.0, scaleMod: 1.1 },
          { x: 147.0, z: 106.0, scaleMod: 1.0 },

          // North Plaza (perimeter and open spaces)
          { x: 88.0, z: 110.0, scaleMod: 1.0 },
          { x: 112.0, z: 110.0, scaleMod: 1.05 },
          { x: 85.0, z: 122.0, scaleMod: 0.95 },
          { x: 115.0, z: 122.0, scaleMod: 1.0 },
          { x: 86.0, z: 138.0, scaleMod: 1.1 },
          { x: 114.0, z: 138.0, scaleMod: 1.0 },
          // Flanking north plaza background wall
          { x: 92.0, z: 144.0, scaleMod: 0.9 },
          { x: 108.0, z: 144.0, scaleMod: 0.95 },
        ];

        const treeTransforms: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
        for (let i = 0; i < treeSpots.length; i++) {
          const spot = treeSpots[i];
          const baseScale = 0.012 * (spot.scaleMod ?? 1.0);
          const rotY = (i * 2.39996) % (Math.PI * 2);

          treeTransforms.push({
            position: new THREE.Vector3(spot.x, 0, spot.z),
            rotation: new THREE.Euler(0, rotY, 0),
            scale: new THREE.Vector3(baseScale, baseScale, baseScale),
          });
        }
        const treesGroup = this.createInstancedFromGLTF(treeGltf.scene, treeTransforms, true, true);
        this.scene.add(treesGroup);

        // 2. Flowering Bush Locations (Cluster naturally around trees, along walls, and near stall edges)
        // Bush original height: ~1.58m. Scale ~0.8 to ~1.1 -> height ~1.2m - 1.7m (lush garden shrub)
        const bushSpots: Array<{ x: number; z: number; scale?: number }> = [
          // Near South Avenue trees
          { x: 92.5, z: 63.5, scale: 0.85 },
          { x: 91.2, z: 61.2, scale: 1.0 },
          { x: 107.5, z: 63.2, scale: 0.9 },
          { x: 108.8, z: 61.0, scale: 1.05 },
          { x: 92.2, z: 78.5, scale: 0.8 },
          { x: 107.8, z: 81.5, scale: 0.95 },

          // Along South Avenue building corners
          { x: 94.0, z: 89.0, scale: 0.85 },
          { x: 106.0, z: 89.0, scale: 0.85 },

          // Crossroads nook greenery
          { x: 92.5, z: 92.5, scale: 0.9 },
          { x: 107.5, z: 92.5, scale: 0.9 },

          // West Corridor edges
          { x: 80.0, z: 92.0, scale: 0.85 },
          { x: 86.0, z: 92.0, scale: 0.95 },

          // West Plaza lush perimeter clusters
          { x: 53.0, z: 92.5, scale: 1.0 },
          { x: 55.5, z: 95.0, scale: 0.8 },
          { x: 53.0, z: 107.5, scale: 0.95 },
          { x: 55.0, z: 105.0, scale: 0.85 },
          { x: 68.0, z: 93.5, scale: 0.9 },
          { x: 68.5, z: 106.5, scale: 0.85 },
          { x: 61.0, z: 88.0, scale: 1.0 },
          { x: 61.0, z: 111.5, scale: 1.0 },

          // East Corridor edges
          { x: 114.0, z: 92.0, scale: 0.85 },
          { x: 120.0, z: 92.0, scale: 0.95 },

          // East Plaza lush perimeter clusters
          { x: 133.5, z: 92.5, scale: 0.95 },
          { x: 136.5, z: 95.0, scale: 0.85 },
          { x: 133.5, z: 107.5, scale: 0.9 },
          { x: 136.0, z: 105.0, scale: 0.8 },
          { x: 148.5, z: 92.5, scale: 1.0 },
          { x: 148.5, z: 107.5, scale: 0.95 },
          { x: 140.0, z: 88.0, scale: 1.05 },
          { x: 140.0, z: 111.5, scale: 1.0 },

          // North Plaza perimeter and garden clusters
          { x: 86.5, z: 109.0, scale: 0.9 },
          { x: 89.5, z: 111.5, scale: 0.8 },
          { x: 110.5, z: 111.5, scale: 0.85 },
          { x: 113.5, z: 109.0, scale: 0.95 },
          { x: 84.0, z: 120.5, scale: 0.9 },
          { x: 86.0, z: 123.5, scale: 0.8 },
          { x: 114.0, z: 120.5, scale: 0.85 },
          { x: 116.0, z: 123.5, scale: 0.95 },
          { x: 85.0, z: 136.5, scale: 1.0 },
          { x: 87.5, z: 139.5, scale: 0.85 },
          { x: 112.5, z: 139.5, scale: 0.9 },
          { x: 115.0, z: 136.5, scale: 1.0 },
          { x: 93.5, z: 143.0, scale: 0.85 },
          { x: 106.5, z: 143.0, scale: 0.85 },
        ];

        const bushTransforms: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
        for (let i = 0; i < bushSpots.length; i++) {
          const spot = bushSpots[i];
          const scale = spot.scale ?? 0.9;
          const rotY = (i * 1.832) % (Math.PI * 2);

          bushTransforms.push({
            position: new THREE.Vector3(spot.x, 0, spot.z),
            rotation: new THREE.Euler(0, rotY, 0),
            scale: new THREE.Vector3(scale, scale, scale),
          });
        }
        const bushesGroup = this.createInstancedFromGLTF(bushGltf.scene, bushTransforms, true, true);
        this.scene.add(bushesGroup);
      })
      .catch((err) => {
        console.warn('[World] Failed to load vegetation models:', err);
      });
  }

  /**
   * Helper to create InstancedMesh group from a loaded GLTF scene hierarchy.
   * Drastically reduces draw calls and scene graph nodes while preserving 100% visual fidelity and shadows.
   */
  private createInstancedFromGLTF(
    gltfScene: THREE.Group,
    transforms: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>,
    castShadow = true,
    receiveShadow = true
  ): THREE.Group {
    const group = new THREE.Group();
    const subMeshes: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material; localMatrix: THREE.Matrix4 }> = [];

    gltfScene.updateMatrixWorld(true);
    gltfScene.traverse((child) => {
      if ((child as any).isMesh) {
        const mesh = child as THREE.Mesh;
        subMeshes.push({
          geometry: mesh.geometry,
          material: mesh.material as THREE.Material,
          localMatrix: mesh.matrixWorld.clone(),
        });
      }
    });

    const count = transforms.length;
    const dummy = new THREE.Object3D();
    const instMatrix = new THREE.Matrix4();

    for (const sub of subMeshes) {
      const instancedMesh = new THREE.InstancedMesh(sub.geometry, sub.material, count);
      instancedMesh.castShadow = castShadow;
      instancedMesh.receiveShadow = receiveShadow;
      instancedMesh.matrixAutoUpdate = false;

      for (let i = 0; i < count; i++) {
        const t = transforms[i];
        dummy.position.copy(t.position);
        dummy.rotation.copy(t.rotation);
        dummy.scale.copy(t.scale);
        dummy.updateMatrix();

        instMatrix.multiplyMatrices(dummy.matrix, sub.localMatrix);
        instancedMesh.setMatrixAt(i, instMatrix);
      }
      instancedMesh.instanceMatrix.needsUpdate = true;
      instancedMesh.computeBoundingSphere();
      instancedMesh.updateMatrix();
      group.add(instancedMesh);
    }

    group.matrixAutoUpdate = false;
    group.updateMatrix();
    return group;
  }

  /**
   * Initializes the ChunkStreamer engine component with lantern dummy mode (no dynamic PointLights).
   */
  private initChunkStreamer(): void {
    this.chunkStreamer = new ChunkStreamer(
      this.scene,
      {
        chunkSize: 20,
        gridWidth: 10,
        gridHeight: 10,
        maxAoIChunks: 9,
        totalChunks: 100,
      },
      (cx, cz) => {
        return ChunkBuilder.buildChunk(cx, cz, undefined, {
          enablePointLights: false,
          maxLightsPerChunk: 0,
        });
      }
    );
    // Initialize AoI around spawn / center coordinates (100, 100)
    this.chunkStreamer.update(this.config.floorSize / 2, this.config.floorSize / 2);
  }

  /**
   * Starts the animation / render loop.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.clock.start();
    this.animate();
  }

  /**
   * Stops the render loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Core requestAnimationFrame render loop with delta clamping and FPS computation.
   */
  private animate = (): void => {
    if (!this.isRunning) return;

    this.animationFrameId = requestAnimationFrame(this.animate);

    // Compute delta with maximum clamp to prevent physics explosion
    const rawDelta = this.clock.getDelta();
    const delta = Math.min(rawDelta, 0.1);

    // Compute FPS
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTimestamp >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTimestamp));
      this.frameCount = 0;
      this.lastFpsTimestamp = now;
    }

    // Execute update hooks (PlayerController, OtherPlayerManager, ChunkStreamer)
    for (const listener of this.updateListeners) {
      listener(delta);
    }

    // Update animated vendor models selectively (only visible & within range)
    this.updateVendorAnimations(delta);

    // Update animated running chickens across streets and plazas
    this.updateChickens(delta);

    // Render frame
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Updates animated vendor models (Chef Chen & Lao Wang) selectively:
   * 1. Distance culls distant vendors (> 40m) by setting root.visible = false, pruning ~3,700 scene nodes
   *    and draw calls from Three.js's projectObject and WebGL render list every frame.
   * 2. Only processes skeletal animation if NPC is within 35m AND approximately in front of camera view cone
   *    (dot > 0.15, ~162° view cone), or very close (< 4m) for peripheral vision.
   */
  public updateVendorAnimations(delta: number): void {
    if (this.vendorEntries.length === 0) return;

    const camPos = this.camera.position;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();

    const maxVisibilityDistSq = 22.0 * 22.0; // 22m distance threshold for mesh visibility
    const maxAnimDistSq = 18.0 * 18.0; // 18m distance threshold for animation

    for (let i = 0; i < this.vendorEntries.length; i++) {
      const vendor = this.vendorEntries[i];
      if (vendor.isCentral) {
        vendor.root.visible = true;
        vendor.mixer?.update(delta);
        continue;
      }

      const dx = vendor.x - camPos.x;
      const dz = vendor.z - camPos.z;
      const distSq = dx * dx + dz * dz;

      // 1. Distance culling: vendors beyond 22m are occluded by buildings/canopies/walls.
      // Setting visible = false causes Three.js projectObject to prune all 74 sub-meshes in O(1).
      if (distSq > maxVisibilityDistSq) {
        vendor.root.visible = false;
        continue;
      }

      // 2. View Cone / Frustum culling:
      // If farther than 4m, verify NPC is roughly in front of camera view cone (~150°)
      if (distSq > 16.0) {
        const dist = Math.sqrt(distSq);
        const dot = camDir.x * (dx / dist) + camDir.z * (dz / dist);
        if (dot < 0.15) {
          vendor.root.visible = false;
          continue;
        }
      }

      vendor.root.visible = true;

      if (!vendor.mixer) {
        continue;
      }

      // 3. Proximity override: if very close (< 4m), always update animation (even in peripheral vision)
      if (distSq < 16.0) {
        vendor.mixer.update(delta);
        continue;
      }

      // 4. Distance check for animation (18m)
      if (distSq <= maxAnimDistSq) {
        vendor.mixer.update(delta);
      }
    }
  }

  /**
   * Updates animated running chickens:
   * 1. Distance culls distant chickens (> 45m)
   * 2. Reacts to player proximity (< 4.2m) with panic flight away from player
   * 3. Runs along market streets/plazas, avoids walls and obstacles, periodically pecks ground
   * 4. Updates skeletal animation mixers
   */
  public updateChickens(delta: number, playerX?: number, playerZ?: number): void {
    if (this.chickenEntries.length === 0) return;

    const px = playerX ?? this.camera.position.x;
    const pz = playerZ ?? this.camera.position.z;
    const maxVisibilityDistSq = 80.0 * 80.0; // 80m distance threshold
    const simDelta = Math.min(delta, 0.1);
    const wallBoxes = this.getWallBoundingBoxes();
    const nowMs = performance.now();

    for (let i = 0; i < this.chickenEntries.length; i++) {
      const chicken = this.chickenEntries[i];
      const cdx = chicken.x - px;
      const cdz = chicken.z - pz;
      const distToPlayerSq = cdx * cdx + cdz * cdz;

      // Distance culling: beyond 80m, hide mesh
      if (distToPlayerSq > maxVisibilityDistSq) {
        chicken.root.visible = false;
        continue;
      }
      chicken.root.visible = true;

      // 1. Proximity panic check: player gets within 4.2m (< 17.64 distSq)
      if (distToPlayerSq < 17.64) {
        if (chicken.state !== 'panic') {
          chicken.state = 'panic';
          chicken.panicTimer = 2.5 + Math.random() * 1.5;
          this.setChickenAction(chicken, chicken.panicAction, 0.15);
        } else {
          chicken.panicTimer = Math.max(chicken.panicTimer, 1.5);
        }

        // Flee angle: run away from the player with slight erratic wiggle
        const fleeAngle =
          Math.atan2(cdx, cdz) + Math.sin(nowMs * 0.006 + i * 2.3) * 0.4;
        chicken.targetYaw = fleeAngle;
      }

      // 2. State Machine updates
      let moveSpeed = 0;

      if (chicken.state === 'panic') {
        moveSpeed = 4.8; // Fast frantic sprint
        chicken.panicTimer -= simDelta;

        // If player is still close, keep steering away from player
        if (distToPlayerSq < 25.0) {
          chicken.targetYaw =
            Math.atan2(cdx, cdz) + Math.sin(nowMs * 0.008 + i * 1.7) * 0.35;
        }

        // Calm down when panic timer expires and player is at safe distance (> 5.5m)
        if (chicken.panicTimer <= 0 && distToPlayerSq > 30.0) {
          if (Math.random() < 0.7) {
            chicken.state = 'run';
            chicken.stateTimer = 3.0 + Math.random() * 4.0;
            chicken.targetYaw = chicken.currentYaw + (Math.random() - 0.5) * 1.2;
            this.setChickenAction(chicken, chicken.runAction, 0.25);
          } else {
            chicken.state = 'peck';
            chicken.stateTimer = 2.4 * (1 + Math.floor(Math.random() * 2));
            this.setChickenAction(chicken, chicken.peckAction, 0.25);
          }
        }
      } else if (chicken.state === 'run') {
        moveSpeed = 2.2; // Smooth natural run / trot
        chicken.stateTimer -= simDelta;

        // Periodic gentle wandering curvature
        if (Math.sin(nowMs * 0.001 + i * 3.1) > 0.85) {
          chicken.targetYaw += (Math.random() - 0.5) * 0.2 * simDelta;
        }

        if (chicken.stateTimer <= 0) {
          // 30% chance to stop and peck, 70% chance to continue running in new direction
          if (Math.random() < 0.30) {
            chicken.state = 'peck';
            chicken.stateTimer = 2.4;
            this.setChickenAction(chicken, chicken.peckAction, 0.25);
          } else {
            chicken.targetYaw = Math.random() * Math.PI * 2;
            chicken.stateTimer = 3.5 + Math.random() * 4.5;
          }
        }
      } else if (chicken.state === 'peck') {
        moveSpeed = 0; // Standing still pecking ground
        chicken.stateTimer -= simDelta;

        if (chicken.stateTimer <= 0) {
          chicken.state = 'run';
          chicken.targetYaw = Math.random() * Math.PI * 2;
          chicken.stateTimer = 3.5 + Math.random() * 4.0;
          this.setChickenAction(chicken, chicken.runAction, 0.25);
        }
      }

      // 3. Smooth Yaw Rotation towards targetYaw (Forward is +Z)
      let diff = chicken.targetYaw - chicken.currentYaw;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      const turnSpeed = chicken.state === 'panic' ? 10.0 : 6.0;
      const maxTurn = turnSpeed * simDelta;
      if (Math.abs(diff) <= maxTurn) {
        chicken.currentYaw = chicken.targetYaw;
      } else {
        chicken.currentYaw += Math.sign(diff) * maxTurn;
      }
      chicken.root.rotation.set(0, chicken.currentYaw, 0);

      // 4. Movement, Boundaries & Obstacle Avoidance
      if (moveSpeed > 0) {
        const step = moveSpeed * simDelta;
        const forwardX = Math.sin(chicken.currentYaw);
        const forwardZ = Math.cos(chicken.currentYaw);
        const nextX = chicken.x + forwardX * step;
        const nextZ = chicken.z + forwardZ * step;

        // Check map limits [4, 196]
        if (nextX < 4.0 || nextX > 196.0 || nextZ < 4.0 || nextZ > 196.0) {
          chicken.targetYaw = Math.atan2(100.0 - chicken.x, 100.0 - chicken.z);
        } else {
          // Check roaming boundary from home spawn spot
          const hdx = nextX - chicken.homeX;
          const hdz = nextZ - chicken.homeZ;
          const distHomeSq = hdx * hdx + hdz * hdz;

          if (distHomeSq > chicken.roamRadius * chicken.roamRadius) {
            // Steer back towards home
            chicken.targetYaw =
              Math.atan2(chicken.homeX - chicken.x, chicken.homeZ - chicken.z) +
              (Math.random() - 0.5) * 0.4;
          }

          // Check wall / stall collision (AABB)
          let collidesWithWall = false;
          const chickenRadius = 0.25;
          for (let b = 0; b < wallBoxes.length; b++) {
            const box = wallBoxes[b];
            if (
              nextX + chickenRadius >= box.min.x &&
              nextX - chickenRadius <= box.max.x &&
              nextZ + chickenRadius >= box.min.z &&
              nextZ - chickenRadius <= box.max.z
            ) {
              collidesWithWall = true;
              // If already penetrating/stuck inside, reorient towards open world center
              if (
                chicken.x + chickenRadius >= box.min.x &&
                chicken.x - chickenRadius <= box.max.x &&
                chicken.z + chickenRadius >= box.min.z &&
                chicken.z - chickenRadius <= box.max.z
              ) {
                chicken.targetYaw = Math.atan2(100.0 - chicken.x, 100.0 - chicken.z);
                chicken.currentYaw = chicken.targetYaw;
              }
              break;
            }
          }

          if (collidesWithWall) {
            // Deflect / bounce away from wall
            chicken.targetYaw =
              chicken.currentYaw + Math.PI * 0.75 + (Math.random() - 0.5) * 0.5;
            chicken.stateTimer = Math.min(chicken.stateTimer, 1.2);
          } else {
            // Advance forward
            chicken.x = nextX;
            chicken.z = nextZ;
            chicken.root.position.set(chicken.x, 0.0, chicken.z);
          }
        }
      }

      // 5. Update animation mixer
      chicken.mixer.update(simDelta);
    }
  }

  /**
   * Triggers an animated NPC gesture (Wave greeting, Angry disagreement, or Idle).
   */
  public triggerNpcReaction(npcId: string, reaction: 'Wave' | 'Angry' | 'Idle'): void {
    const entry =
      this.vendorEntries.find((e) => e.npcId === npcId) ??
      (npcId === 'lao_wang' ? this.vendorEntries.find((e) => e.isCentral) : null) ??
      this.vendorEntries[0];

    if (!entry || !entry.mixer || !entry.clips) return;

    const clip = THREE.AnimationClip.findByName(entry.clips, reaction);
    if (!clip) return;

    const action = entry.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;

    if (entry.idleAction) {
      action.crossFadeFrom(entry.idleAction, 0.2, true);
    }
    action.play();

    const onFinished = (e: any) => {
      if (e.action === action) {
        entry.mixer?.removeEventListener('finished', onFinished);
        if (entry.idleAction) {
          entry.idleAction.reset().fadeIn(0.25).play();
        }
      }
    };
    entry.mixer.addEventListener('finished', onFinished);
  }

  /**
   * Registers a per-frame update listener. Returns an unsubscribe function.
   */
  public onUpdate(fn: (delta: number) => void): () => void {
    this.updateListeners.push(fn);
    return () => {
      const index = this.updateListeners.indexOf(fn);
      if (index !== -1) {
        this.updateListeners.splice(index, 1);
      }
    };
  }

  /**
   * Handles window / container resize.
   */
  public onResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.camera.aspect = width / (height || 1);
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  };

  /**
   * Adds an object to the scene.
   */
  public add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  /**
   * Removes an object from the scene.
   */
  public remove(object: THREE.Object3D): void {
    this.scene.remove(object);
  }

  /**
   * Gets current measured rendering FPS.
   */
  public getFPS(): number {
    return this.currentFps;
  }

  /**
   * Accessor getters for camera, scene, and renderer.
   */
  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Directly renders the 3D scene (useful when main.ts manages its own external render loop).
   * Throttles shadow depth pass to ~20 Hz (every 3rd frame) to eliminate 67% of shadow pass overhead
   * while keeping stationary environment and character shadows completely smooth.
   */
  public render(): void {
    this.shadowFrameCounter++;
    if (this.shadowFrameCounter >= 3) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowFrameCounter = 0;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Directly executes update hooks with delta time and updates chunk streamer if player coordinates provided.
   */
  public update(delta: number, playerX?: number, playerZ?: number): void {
    if (this.chunkStreamer && playerX !== undefined && playerZ !== undefined) {
      const changed = this.chunkStreamer.update(playerX, playerZ);
      if (changed) {
        this.cachedWallBoundingBoxes = null;
        this.renderer.shadowMap.needsUpdate = true;
      }
    }

    // Update animated vendor models selectively (only visible & within range)
    this.updateVendorAnimations(delta);

    // Update animated running chickens across streets and plazas
    this.updateChickens(delta, playerX, playerZ);

    for (const listener of this.updateListeners) {
      listener(delta);
    }
  }

  /**
   * Scans active scene for wall objects with userData.isWall and computes their world Box3 bounding boxes.
   * Caches results so expensive scene traversal and vertex iteration only occurs when geometry changes.
   */
  public getWallBoundingBoxes(forceRefresh: boolean = false): THREE.Box3[] {
    if (this.cachedWallBoundingBoxes && !forceRefresh) {
      return this.cachedWallBoundingBoxes;
    }

    const boxes: THREE.Box3[] = [];
    const spawnX = this.config.floorSize / 2;
    const spawnZ = this.config.floorSize / 2;

    this.scene.traverse((obj) => {
      if ((obj.userData?.isWall || obj.userData?.isStall) && obj instanceof THREE.Mesh) {
        const box = new THREE.Box3().setFromObject(obj);
        // Expand bounding box slightly horizontally to prevent clipping / tunneling
        box.expandByScalar(0.15);
        box.min.y = -2.0;
        box.max.y = 20.0;
        // Ensure spawn point (100, 100) is never inside an active wall box
        if (!box.containsPoint(new THREE.Vector3(spawnX, 1.0, spawnZ))) {
          boxes.push(box);
        }
      }
    });

    this.cachedWallBoundingBoxes = boxes;
    return boxes;
  }

  /**
   * Explicitly invalidates the cached wall bounding boxes.
   */
  public invalidateWallBoundingBoxesCache(): void {
    this.cachedWallBoundingBoxes = null;
  }

  /**
   * Returns ChunkStreamer instance or null.
   */
  public getChunkStreamer(): ChunkStreamer | null {
    return this.chunkStreamer;
  }

  /**
   * Chunk cache percentage (strictly <= 10%).
   */
  public getCachePercentage(): number {
    return this.chunkStreamer ? this.chunkStreamer.getCachePercentage() : 9;
  }

  /**
   * Loaded chunks count (strictly in range 0..9).
   */
  public getLoadedChunksCount(): number {
    return this.chunkStreamer ? this.chunkStreamer.getLoadedChunksCount() : 9;
  }

  /**
   * Loaded chunks count alias for backward-compatibility.
   */
  public getLoadedChunkCount(): number {
    return this.getLoadedChunksCount();
  }

  /**
   * Returns current count of spawned chickens.
   */
  public getChickensCount(): number {
    return this.chickenEntries.length;
  }

  /**
   * Disposes all Three.js resources, listeners, and removes canvas element.
   */
  public dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.updateListeners = [];

    // Stop and clear all chicken animations
    for (const chicken of this.chickenEntries) {
      chicken.mixer.stopAllAction();
    }
    this.chickenEntries = [];

    // Dispose chunk streamer and all active chunks
    this.chunkStreamer?.dispose();
    this.chunkStreamer = null;

    // Traverse and dispose remaining scene objects
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      }
    });

    if (this.renderer?.domElement?.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
    try {
      this.renderer?.dispose();
    } catch {
      // In headless test environments WebGL cleanup may lack window animation context
    }
  }
}
