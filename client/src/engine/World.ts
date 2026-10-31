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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

        // 100 x 100 grid spanning [0, 200] in X and Z
        const countX = 100;
        const countZ = 100;
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
          const posX = ix * 2 + 1; // centered in 2m grid: 1, 3, 5, ..., 199
          for (let iz = 0; iz < countZ; iz++) {
            const posZ = iz * 2 + 1;
            dummy.position.set(posX, 0.015, posZ);
            dummy.updateMatrix();
            instancedMesh.setMatrixAt(idx++, dummy.matrix);
          }
        }

        instancedMesh.instanceMatrix.needsUpdate = true;
        this.stoneTileFloor = instancedMesh;
        this.scene.add(this.stoneTileFloor);
        console.log('[World] Stone tile pavement floor generated across 200x200 world (10,000 instances).');
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
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 10;
    this.dirLight.shadow.camera.far = 250;
    this.dirLight.shadow.camera.left = -110;
    this.dirLight.shadow.camera.right = 110;
    this.dirLight.shadow.camera.top = 110;
    this.dirLight.shadow.camera.bottom = -110;
    this.dirLight.shadow.bias = -0.0005;

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
    const vendorPositions: Array<{ x: number; z: number; rotY: number }> = [];
    for (const stall of stalls) {
      const distToLaoWang = Math.hypot(stall.x - 100.0, stall.z - 124.0);
      if (distToLaoWang < 3.5) continue;

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
      const centralLaoWang = laoGltf.scene.clone(true);
      centralLaoWang.position.set(100.0, 0.0, 124.65); // Other side of the counter, facing North (rotY = Math.PI)
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
            child.castShadow = true;
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

    // Update animated vendor models (Chef Chen & Lao Wang)
    for (const mixer of this.vendorMixers) {
      mixer.update(delta);
    }

    // Render frame
    this.renderer.render(this.scene, this.camera);
  };

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
   */
  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Directly executes update hooks with delta time and updates chunk streamer if player coordinates provided.
   */
  public update(delta: number, playerX?: number, playerZ?: number): void {
    if (this.chunkStreamer && playerX !== undefined && playerZ !== undefined) {
      this.chunkStreamer.update(playerX, playerZ);
    }
    for (const listener of this.updateListeners) {
      listener(delta);
    }
  }

  /**
   * Scans active scene for wall objects with userData.isWall and computes their world Box3 bounding boxes.
   * Updates world matrix beforehand to guarantee 100% accurate global bounding boxes.
   */
  public getWallBoundingBoxes(): THREE.Box3[] {
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
    return boxes;
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
