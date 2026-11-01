import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
  private merchantClosed = false;
  private merchantAngerTime = 0;
  private closedSign: THREE.Sprite | null = null;
  private vendorEntries: Array<{
    root: THREE.Object3D;
    mixer?: THREE.AnimationMixer;
    x: number;
    z: number;
    isCentral?: boolean;
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
      // Stalls face with canopy tilted forward towards customer side (+Z)
      // Vendors now stand on the other side of the counter (+0.95m forward) facing back towards the stall
      const offsetX = Math.sin(facingAngle) * 0.95;
      const offsetZ = Math.cos(facingAngle) * 0.95;

      vendorPositions.push({
        x: stall.x + offsetX,
        z: stall.z + offsetZ,
        rotY: facingAngle + Math.PI,
      });
    }

    // Load both GLTF vendor models (Chef Chen and Lao Wang)
    const loader = new GLTFLoader();
    const modelUrls = {
      chef: '/assets/models/chef_chen.glb',
      lao: '/assets/models/lao_wang.glb',
    };

    Promise.all([
      loader.loadAsync(modelUrls.chef).catch(() => loader.loadAsync('/models/vendors/chef_chen.glb')),
      loader.loadAsync(modelUrls.lao).catch(() => loader.loadAsync('/models/vendors/lao_wang.glb')),
    ]).then(([chefGltf, laoGltf]) => {
      console.log(`[World] Successfully loaded vendor GLB models! Populating ${vendorPositions.length} stalls...`);

      // Spawn Lao Wang at his central antique pavilion stall (100.0, 0, 124.0)
      // Pavilion center is (100.0, 124.0), counter is at z = 124.3 (extends to z=124.95), platform is from 122.2 to 125.8
      // Position Lao Wang comfortably on the other side of the counter at z = 125.55 (facing towards counter/South: rotY = Math.PI)
      const centralLaoWang = laoGltf.scene.clone(true);
      centralLaoWang.position.set(100.0, 0.0, 125.55); // On the other side of the counter
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
      if (laoGltf.animations && laoGltf.animations.length > 0) {
        centralMixer = new THREE.AnimationMixer(centralLaoWang);
        const idleClip = laoGltf.animations.find((a) => a.name === 'Idle') ?? laoGltf.animations[0];
        centralMixer.clipAction(idleClip).play();
        this.vendorMixers.push(centralMixer);
      }
      this.vendorEntries.push({
        root: centralLaoWang,
        mixer: centralMixer,
        x: 100.0,
        z: 125.55,
        isCentral: true,
      });

      // Populate every stall with Chef Chen and Lao Wang models alternately
      for (let i = 0; i < vendorPositions.length; i++) {
        const vp = vendorPositions[i];
        const isChef = i % 2 === 0;
        const sourceGltf = isChef ? chefGltf : laoGltf;

        const clone = sourceGltf.scene.clone(true);
        clone.position.set(vp.x, 0.0, vp.z);
        // Models face +Z by default; rotate by vp.rotY to face into corridor
        clone.rotation.set(0, vp.rotY, 0);

        clone.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = false; // Background vendors are sheltered under stall canopies
            child.receiveShadow = false; // Background vendors under canopy skip shadow calculation
          }
        });
        // Initial visibility based on distance from spawn (100, 100)
        const distFromSpawn = Math.hypot(vp.x - 100.0, vp.z - 100.0);
        clone.visible = distFromSpawn <= 22.0;
        this.scene.add(clone);

        // Play Idle animation with slight random time offset
        let mixer: THREE.AnimationMixer | undefined;
        if (sourceGltf.animations && sourceGltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(clone);
          const idleClip = sourceGltf.animations.find((a) => a.name === 'Idle') ?? sourceGltf.animations[0];
          const action = mixer.clipAction(idleClip);
          action.time = Math.random() * 4.0; // Desynchronize animations naturally
          action.play();
          this.vendorMixers.push(mixer);
        }

        this.vendorEntries.push({
          root: clone,
          mixer,
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
   * Spawns 3D chickens scattered randomly in corridors and plazas.
   */
  private initChickens(): void {
    const loader = new GLTFLoader();
    const modelUrls = ['/assets/models/chicken.glb', '/models/chicken.glb'];

    const loadChicken = async () => {
      try {
        return await loader.loadAsync(modelUrls[0]);
      } catch {
        return await loader.loadAsync(modelUrls[1]);
      }
    };

    loadChicken().then((gltf) => {
      console.log('[World] Successfully loaded Chicken 3D model! Scattering chickens...');

      // Candidate spots across the market corridors and open squares
      const chickenSpawnSpots: Array<{ x: number; z: number }> = [
        // South entrance street (walkway ~98..102, z ~65..95)
        { x: 99.2, z: 68.5 },
        { x: 101.3, z: 76.0 },
        { x: 98.7, z: 84.5 },
        { x: 100.8, z: 92.0 },

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

      // Original chicken model height is ~189 units.
      // Scaling by ~0.003 brings chicken height to ~0.55m, which looks great and lifelike in the market!
      const chickenScale = 0.0032;

      const chickenTransforms: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
      for (let i = 0; i < chickenSpawnSpots.length; i++) {
        const spot = chickenSpawnSpots[i];
        const randJitterX = Math.sin(i * 19.3) * 0.8;
        const randJitterZ = Math.cos(i * 27.7) * 0.8;
        const randomRotY = (i * 1.6180339887) % (Math.PI * 2);

        chickenTransforms.push({
          position: new THREE.Vector3(spot.x + randJitterX, 0.0, spot.z + randJitterZ),
          rotation: new THREE.Euler(0, randomRotY, 0),
          scale: new THREE.Vector3(chickenScale, chickenScale, chickenScale),
        });
      }

      const chickensGroup = this.createInstancedFromGLTF(gltf.scene, chickenTransforms, true, true);
      this.scene.add(chickensGroup);
    }).catch((err) => {
      console.warn('[World] Failed to load chicken GLTF model:', err);
    });
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
  /** This state is local to the viewing player, never a world-wide closure. */
  public setMerchantClosed(npcId: string, closed: boolean): void {
    if (npcId !== 'lao_wang' || this.merchantClosed === closed) return;
    this.merchantClosed = closed;
    if (closed && !this.closedSign) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#641c1c';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 43px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ДЛЯ ВАС ЗАКРЫТО', 256, 80);
        this.closedSign = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
        this.closedSign.position.set(100, 2.7, 124);
        this.closedSign.scale.set(3.2, 0.8, 1);
        this.scene.add(this.closedSign);
      }
    }
    if (this.closedSign) this.closedSign.visible = closed;
    if (!closed) {
      const vendor = this.vendorEntries.find((entry) => entry.isCentral);
      if (vendor) vendor.root.rotation.z = 0;
    }
  }

  public updateVendorAnimations(delta: number): void {
    if (this.merchantClosed) this.merchantAngerTime += delta;
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
        // The supplied model contains only Idle and Wave: add a clear angry shake.
        vendor.root.rotation.z = this.merchantClosed ? Math.sin(this.merchantAngerTime * 12) * 0.10 : 0;
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
   * Disposes all Three.js resources, listeners, and removes canvas element.
   */
  public dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.updateListeners = [];

    // Dispose chunk streamer and all active chunks
    this.chunkStreamer?.dispose();
    this.chunkStreamer = null;

    if (this.closedSign) {
      const material = this.closedSign.material;
      material.map?.dispose();
      material.dispose();
      this.scene.remove(this.closedSign);
      this.closedSign = null;
    }

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

    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}
