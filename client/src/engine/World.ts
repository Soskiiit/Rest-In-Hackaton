import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

    // 1. Scene setup with night market background and FogExp2
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.config.fogColor);
    this.scene.fog = new THREE.FogExp2(this.config.fogColor, this.config.fogDensity);

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

  /**
   * Initializes the 200x200 ground floor and 10x10 chunk boundary grid helper.
   */
  private initGroundFloor(): void {
    const halfSize = this.config.floorSize / 2;

    const floorGeo = new THREE.PlaneGeometry(this.config.floorSize, this.config.floorSize, 40, 40);
    const floorMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.floorColor,
      roughness: 0.85,
      metalness: 0.15,
    });
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

        // Populate tiles covering the playable market area with generous margins [42, 158] x [54, 154]
        // Outside these coordinates are tall 8.5m solid exterior walls and fog
        const startX = 42;
        const endX = 158;
        const startZ = 54;
        const endZ = 154;
        const step = 2.0;

        const countX = Math.round((endX - startX) / step);
        const countZ = Math.round((endZ - startZ) / step);
        const totalInstances = countX * countZ;

        const instancedMesh = new THREE.InstancedMesh(
          mergedGeo,
          materials.length === 1 ? materials[0] : materials,
          totalInstances
        );
        instancedMesh.receiveShadow = true;
        instancedMesh.castShadow = false;

        const dummy = new THREE.Object3D();
        let idx = 0;

        for (let ix = 0; ix < countX; ix++) {
          const posX = startX + ix * step + 1;
          for (let iz = 0; iz < countZ; iz++) {
            const posZ = startZ + iz * step + 1;
            dummy.position.set(posX, 0.015, posZ);
            dummy.updateMatrix();
            instancedMesh.setMatrixAt(idx++, dummy.matrix);
          }
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

    const half = this.config.floorSize / 2;
    const lanternPositions = [
      { x: half - 12, y: 3.8, z: half - 12 },
      { x: half + 12, y: 3.8, z: half - 12 },
      { x: half - 12, y: 3.8, z: half + 12 },
      { x: half + 12, y: 3.8, z: half + 12 },
      { x: half, y: 4.5, z: half - 25 },
      { x: half, y: 4.5, z: half + 25 },
    ];

    for (const pos of lanternPositions) {
      this.addLantern(pos.x, pos.y, pos.z, SCENE_COLORS.lanternBodyColor, this.config.lanternIntensity, this.config.lanternDistance);
    }
  }

  /**
   * Adds an illuminated lantern object with a PointLight and glowing sphere.
   */
  public addLantern(
    x: number,
    y: number,
    z: number,
    bodyColor: number = SCENE_COLORS.lanternBodyColor,
    intensity: number = this.config.lanternIntensity,
    distance: number = this.config.lanternDistance
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Glowing lantern body (Orange)
    const lanternGeo = new THREE.SphereGeometry(0.32, 12, 12);
    const lanternMat = new THREE.MeshBasicMaterial({ color: bodyColor });
    const mesh = new THREE.Mesh(lanternGeo, lanternMat);
    group.add(mesh);

    // PointLight (Yellow light)
    const pointLight = new THREE.PointLight(SCENE_COLORS.lanternLightColor, intensity, distance, 1.6);
    pointLight.castShadow = false; // keep perf high
    group.add(pointLight);

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
      if (laoGltf.animations && laoGltf.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(centralLaoWang);
        const idleClip = laoGltf.animations.find((a) => a.name === 'Idle') ?? laoGltf.animations[0];
        mixer.clipAction(idleClip).play();
        this.vendorMixers.push(mixer);
      }

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
            child.receiveShadow = true;
          }
        });
        this.scene.add(clone);

        // Play Idle animation with slight random time offset
        if (sourceGltf.animations && sourceGltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(clone);
          const idleClip = sourceGltf.animations.find((a) => a.name === 'Idle') ?? sourceGltf.animations[0];
          const action = mixer.clipAction(idleClip);
          action.time = Math.random() * 4.0; // Desynchronize animations naturally
          action.play();
          this.vendorMixers.push(mixer);
        }
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

      for (let i = 0; i < chickenSpawnSpots.length; i++) {
        const spot = chickenSpawnSpots[i];
        // Jitter position slightly for a natural random spread
        const randJitterX = (Math.sin(i * 19.3) * 0.8);
        const randJitterZ = (Math.cos(i * 27.7) * 0.8);
        const randomRotY = (i * 1.6180339887) % (Math.PI * 2);

        const chicken = gltf.scene.clone(true);
        chicken.position.set(spot.x + randJitterX, 0.0, spot.z + randJitterZ);
        chicken.rotation.set(0, randomRotY, 0);
        chicken.scale.set(chickenScale, chickenScale, chickenScale);

        chicken.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        this.scene.add(chicken);
      }
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

        for (let i = 0; i < treeSpots.length; i++) {
          const spot = treeSpots[i];
          const baseScale = 0.012 * (spot.scaleMod ?? 1.0);
          const rotY = (i * 2.39996) % (Math.PI * 2);

          const tree = treeGltf.scene.clone(true);
          tree.position.set(spot.x, 0, spot.z);
          tree.rotation.set(0, rotY, 0);
          tree.scale.set(baseScale, baseScale, baseScale);

          tree.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          this.scene.add(tree);
        }

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

        for (let i = 0; i < bushSpots.length; i++) {
          const spot = bushSpots[i];
          const scale = spot.scale ?? 0.9;
          const rotY = (i * 1.832) % (Math.PI * 2);

          const bush = bushGltf.scene.clone(true);
          bush.position.set(spot.x, 0, spot.z);
          bush.rotation.set(0, rotY, 0);
          bush.scale.set(scale, scale, scale);

          bush.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          this.scene.add(bush);
        }
      })
      .catch((err) => {
        console.warn('[World] Failed to load vegetation models:', err);
      });
  }

  /**
   * Initializes the ChunkStreamer engine component.
   */
  private initChunkStreamer(): void {
    this.chunkStreamer = new ChunkStreamer(this.scene, {
      chunkSize: 20,
      gridWidth: 10,
      gridHeight: 10,
      maxAoIChunks: 9,
      totalChunks: 100,
    });
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
   * Only processes skeletal animation if NPC is within distance threshold N (35m)
   * AND approximately in front of camera view direction (dot > 0.15, ~162° view cone),
   * or very close (< 4m) for peripheral vision.
   */
  public updateVendorAnimations(delta: number): void {
    if (this.vendorMixers.length === 0) return;

    const camPos = this.camera.position;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();

    const maxDistSq = 35.0 * 35.0; // 35m distance threshold

    for (let i = 0; i < this.vendorMixers.length; i++) {
      const mixer = this.vendorMixers[i];
      const root = mixer.getRoot() as THREE.Object3D;
      if (!root || !root.position) {
        mixer.update(delta);
        continue;
      }

      const dx = root.position.x - camPos.x;
      const dz = root.position.z - camPos.z;
      const distSq = dx * dx + dz * dz;

      // 1. Distance check: if further than 35m, skip skeletal animation
      if (distSq > maxDistSq) {
        continue;
      }

      // 2. Proximity override: if very close (< 4m), always update (even in peripheral vision)
      if (distSq < 16.0) {
        mixer.update(delta);
        continue;
      }

      // 3. Direction check: verify NPC is roughly in front of camera view cone
      const dist = Math.sqrt(distSq);
      const dot = camDir.x * (dx / dist) + camDir.z * (dz / dist);

      // dot > 0.15 corresponds to ~81° off-axis (~162° view cone)
      if (dot > 0.15) {
        mixer.update(delta);
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
