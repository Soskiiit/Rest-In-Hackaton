/**
 * AdversarialStressLvl2.test.ts
 *
 * Empirical Adversarial Challenger Level 2 Test Suite:
 * Stress-testing Memory Management, WebGL Resource Leaks, and Chunk Streaming Limits.
 *
 * Requirements Verified:
 * 1. GPU Resource Cleanup & Zero Leakage:
 *    - Spawn, manipulate, and delete 500+ objects from the catalog across all categories
 *      (props, NPCs, stalls, lanterns, items, structures).
 *    - Verify that all geometries, materials, and textures are thoroughly disposed via disposeHierarchy().
 *    - Verify complete unlinking of scene graph hierarchies (zero detached subtree leaks).
 *    - Verify mass burst spawning and bulk deletion without lingering state.
 * 2. Chunk Streaming 10% Memory Ceiling Invariant:
 *    - High-speed camera flight across the entire 200x200 world (diagonal sweeps, zigzag, Lissajous).
 *    - 1000+ random teleportation jumps including out-of-bounds coordinates.
 *    - Assert that loaded chunks NEVER exceed 9 chunks at any frame (<= 10% world cache ceiling strictly preserved).
 *    - Micro-tick atomic verification: unloads execute before loads so transient memory never spikes > 9 chunks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  LevelEditor,
  AppMode,
  SelectableEntity,
} from '../src/editor/LevelEditor';
import { MockChunkStorage } from '../src/editor/ChunkStorage';
import { ChunkStreamer, DEFAULT_CHUNK_CONFIG } from '../src/engine/ChunkStreamer';
import { ChunkBuilder, disposeHierarchy } from '../src/engine/ChunkBuilder';

// ============================================================================
// Headless DOM Environment Mocks
// ============================================================================

class MockClassList {
  private classes = new Set<string>();

  constructor(initial: string = '') {
    if (initial) {
      initial.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    }
  }

  public add(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.add(t));
  }

  public remove(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.delete(t));
  }

  public contains(token: string): boolean {
    return this.classes.has(token);
  }

  public toggle(token: string, force?: boolean): boolean {
    if (force !== undefined) {
      if (force) this.classes.add(token);
      else this.classes.delete(token);
      return force;
    }
    if (this.classes.has(token)) {
      this.classes.delete(token);
      return false;
    } else {
      this.classes.add(token);
      return true;
    }
  }

  public toString(): string {
    return Array.from(this.classes).join(' ');
  }
}

class MockDomElement {
  public id: string = '';
  public tagName: string = 'DIV';
  public parentElement: MockDomElement | null = null;
  public parentNode: MockDomElement | null = null;
  public children: MockDomElement[] = [];
  public classList: MockClassList;
  public style: Record<string, string> = { touchAction: 'auto', display: '' };
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public listeners: Record<string, Function[]> = {};

  public type: string = '';
  public value: string = '';
  public placeholder: string = '';
  public title: string = '';
  public clientWidth: number = 800;
  public clientHeight: number = 600;
  public ownerDocument: any = null;
  public onclick: any = null;

  private _textContent: string = '';
  private _innerHTML: string = '';

  constructor(id: string = '', tagName: string = 'DIV', initialClass: string = '') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList(initialClass);
  }

  public get className(): string {
    return this.classList.toString();
  }

  public set className(val: string) {
    this.classList = new MockClassList(val);
  }

  public get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join(' ');
    }
    return this._textContent;
  }

  public set textContent(val: string) {
    this._textContent = val;
    this._innerHTML = val;
    this.children = [];
  }

  public get innerHTML(): string {
    return this._innerHTML;
  }

  public set innerHTML(val: string) {
    this._innerHTML = val;
    this._textContent = val.replace(/<[^>]*>/g, '');
    this.children = [];
  }

  public appendChild<T extends MockDomElement>(child: T): T {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public removeChild<T extends MockDomElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child.parentNode = null;
    }
    return child;
  }

  public insertBefore<T extends MockDomElement>(newChild: T, _refChild: any): T {
    newChild.parentElement = this;
    newChild.parentNode = this;
    this.children.push(newChild);
    return newChild;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[prop] = value;
    }
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): boolean {
    const ev = {
      stopPropagation: () => {},
      preventDefault: () => {},
      ...event,
      target: this,
      currentTarget: this,
    };
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(ev);
    }
    return true;
  }

  public click(): void {
    if (this.onclick) {
      this.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    }
    this.dispatchEvent({ type: 'click' });
  }

  public querySelector(selector: string): MockDomElement | null {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  public querySelectorAll(selector: string): MockDomElement[] {
    const results: MockDomElement[] = [];
    if (this.matches(selector)) {
      results.push(this);
    }
    for (const child of this.children) {
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  public getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
      right: this.clientWidth,
      bottom: this.clientHeight,
      x: 0,
      y: 0,
      toJSON: () => {},
    };
  }

  public setPointerCapture(): void {}
  public releasePointerCapture(): void {}

  public getContext(_type?: string): any {
    return {
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      beginPath: () => {},
      arc: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      closePath: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      setTransform: () => {},
      fillText: () => {},
      measureText: () => ({ width: 10 }),
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
    };
  }
}

class MockDocument {
  public head: MockDomElement = new MockDomElement('head', 'HEAD');
  public body: MockDomElement = new MockDomElement('body', 'BODY');
  public activeElement: MockDomElement | null = null;
  public pointerLockElement: any = null;
  public listeners: Record<string, Function[]> = {};

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): boolean {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }

  public createElement(tag: string): MockDomElement {
    const el = new MockDomElement('', tag);
    el.ownerDocument = this;
    return el;
  }

  public getElementById(id: string): MockDomElement | null {
    if (this.body.id === id) return this.body;
    return this.body.querySelector(`#${id}`);
  }

  public querySelector(selector: string): MockDomElement | null {
    return this.body.querySelector(selector);
  }

  public querySelectorAll(selector: string): MockDomElement[] {
    return this.body.querySelectorAll(selector);
  }

  public exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

class MockWindow {
  public document!: MockDocument;
  public listeners: Record<string, Function[]> = {};

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): boolean {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }
}

let mockDoc: MockDocument;
let mockWin: MockWindow;
const originalDoc = (global as any).document;
const originalWin = (global as any).window;

function setupMockDOM(): void {
  mockDoc = new MockDocument();
  mockWin = new MockWindow();
  mockWin.document = mockDoc;
  (global as any).document = mockDoc;
  (global as any).window = mockWin;

  const hud = mockDoc.createElement('div');
  hud.id = 'hud';
  const hudHeader = mockDoc.createElement('div');
  hudHeader.className = 'hud-header';
  const hudBody = mockDoc.createElement('div');
  hudBody.className = 'hud-body';
  hud.appendChild(hudHeader);
  hud.appendChild(hudBody);
  mockDoc.body.appendChild(hud);

  const blocker = mockDoc.createElement('div');
  blocker.id = 'blocker';
  mockDoc.body.appendChild(blocker);

  const crosshair = mockDoc.createElement('div');
  crosshair.id = 'crosshair';
  mockDoc.body.appendChild(crosshair);

  const toastContainer = mockDoc.createElement('div');
  toastContainer.id = 'toast-container';
  mockDoc.body.appendChild(toastContainer);
}

function teardownMockDOM(): void {
  if (originalDoc) {
    (global as any).document = originalDoc;
  } else {
    delete (global as any).document;
  }
  if (originalWin) {
    (global as any).window = originalWin;
  } else {
    delete (global as any).window;
  }
}

// ============================================================================
// Adversarial Challenger Test Suite
// ============================================================================

describe('Adversarial Stress Harness Lvl 2: Memory & Chunk Limits', () => {
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let containerEl: MockDomElement;
  let levelEditor: LevelEditor;
  let storage: MockChunkStorage;

  beforeEach(() => {
    setupMockDOM();
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.1, 1000);
    camera.position.set(100, 15, 100);
    containerEl = mockDoc.createElement('div');
    containerEl.id = 'canvas-container';
    mockDoc.body.appendChild(containerEl);

    storage = new MockChunkStorage();
    levelEditor = new LevelEditor({
      scene,
      camera,
      domElement: containerEl as any,
      storage,
      autoInitUI: true,
    });
    levelEditor.setMode(AppMode.EDITOR);
  });

  afterEach(() => {
    levelEditor.dispose();
    teardownMockDOM();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // SECTION 1: GPU Resource Cleanup & Zero Leakage (500+ Objects Across Catalog)
  // ==========================================================================

  describe('1. GPU Resource Cleanup & Zero Leakage Across 500+ Catalog Objects', () => {
    it('1.1 should spawn, manipulate across chunk boundaries, and delete 500+ objects with 100% disposal coverage', () => {
      const catalog = levelEditor.assetCatalog;
      const allAssets = catalog.getAssets();
      expect(allAssets.length).toBeGreaterThanOrEqual(20);

      // Verify representations in each required category
      const categories = ['props', 'npcs', 'structures', 'items'];
      for (const cat of categories) {
        const assetsInCat = catalog.getAssetsByCategory(cat);
        expect(assetsInCat.length).toBeGreaterThan(0);
      }

      const initialSceneChildCount = scene.children.length;

      // Track all created resources to verify disposal
      const allTrackedGeometries: THREE.BufferGeometry[] = [];
      const allTrackedMaterials: THREE.Material[] = [];
      const allTrackedTextures: any[] = [];

      const TOTAL_OBJECTS = 528; // 24 assets * 22 iterations
      const iterations = Math.ceil(TOTAL_OBJECTS / allAssets.length);
      let objectsProcessed = 0;

      for (let iter = 0; iter < iterations && objectsProcessed < TOTAL_OBJECTS; iter++) {
        for (const assetDef of allAssets) {
          if (objectsProcessed >= TOTAL_OBJECTS) break;

          // 1. Spawning phase
          // Position spread across world coordinates [5..195]
          const wx = 10 + ((objectsProcessed * 7) % 180);
          const wy = 0.5;
          const wz = 10 + ((objectsProcessed * 13) % 180);
          const spawnPos = new THREE.Vector3(wx, wy, wz);

          const entity = levelEditor.spawnAsset(assetDef.id, spawnPos);
          expect(entity).toBeDefined();
          expect(entity.rootObject).toBeDefined();

          // Collect geometries, materials, and textures for this entity
          const entityGeos: THREE.BufferGeometry[] = [];
          const entityMats: THREE.Material[] = [];
          const entityTexs: any[] = [];

          entity.rootObject.traverse((node: THREE.Object3D) => {
            const anyNode = node as any;
            if (anyNode.geometry && !allTrackedGeometries.includes(anyNode.geometry)) {
              allTrackedGeometries.push(anyNode.geometry);
              entityGeos.push(anyNode.geometry);
            }
            if (anyNode.material) {
              const mats = Array.isArray(anyNode.material) ? anyNode.material : [anyNode.material];
              for (const m of mats) {
                if (m && !allTrackedMaterials.includes(m)) {
                  allTrackedMaterials.push(m);
                  entityMats.push(m);
                  // Check attached textures
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
                    if ((m as any)[slot] && !allTrackedTextures.includes((m as any)[slot])) {
                      allTrackedTextures.push((m as any)[slot]);
                      entityTexs.push((m as any)[slot]);
                    }
                  }
                }
              }
            }
          });

          // Ensure entity has renderable geometry
          expect(entityGeos.length).toBeGreaterThan(0);
          expect(entityMats.length).toBeGreaterThan(0);

          // 2. Manipulation phase: translate across chunk boundaries, rotate, scale
          const prevChunk = entity.chunkId;
          // Offset by +25 units in X to cross at least one 20m chunk boundary
          const newX = (wx + 25) % 195;
          const newZ = (wz + 25) % 195;
          entity.rootObject.position.set(newX, wy + 1.0, newZ);
          entity.rootObject.rotation.set(0.1, 0.5, 0.2);
          entity.rootObject.scale.set(1.2, 1.2, 1.2);

          // Trigger transform notification in editor
          (levelEditor as any).handleEntityMoved(entity);

          // If crossed chunk boundary, check chunk migration
          const expectedNewChunk = `${Math.floor(newX / 20)}_${Math.floor(newZ / 20)}`;
          expect(entity.chunkId).toBe(expectedNewChunk);
          if (prevChunk !== expectedNewChunk) {
            expect(levelEditor.isChunkDirty(prevChunk)).toBe(true);
            expect(levelEditor.isChunkDirty(expectedNewChunk)).toBe(true);
          }

          // 3. Deletion phase
          levelEditor.select(entity);
          expect(levelEditor.getSelected()).toBe(entity);

          // Spy on disposal methods for this entity
          const geoSpies = entityGeos.map((g) => vi.spyOn(g, 'dispose'));
          const matSpies = entityMats.map((m) => vi.spyOn(m, 'dispose'));
          const texSpies = entityTexs.map((t) => vi.spyOn(t, 'dispose'));

          const deleted = levelEditor.deleteSelected();
          expect(deleted).toBe(true);

          // Verify all geometries disposed
          for (const spy of geoSpies) {
            expect(spy).toHaveBeenCalled();
          }
          // Verify all materials disposed
          for (const spy of matSpies) {
            expect(spy).toHaveBeenCalled();
          }
          // Verify textures disposed if present
          for (const spy of texSpies) {
            expect(spy).toHaveBeenCalled();
          }

          // Verify scene graph hierarchy unlinking
          expect(entity.rootObject.children.length).toBe(0);
          expect(entity.rootObject.parent).toBeNull();

          // Verify unselected
          expect(levelEditor.getSelected()).toBeNull();

          objectsProcessed++;
        }
      }

      expect(objectsProcessed).toBe(TOTAL_OBJECTS);
      expect(allTrackedGeometries.length).toBeGreaterThanOrEqual(TOTAL_OBJECTS);
      expect(allTrackedMaterials.length).toBeGreaterThanOrEqual(TOTAL_OBJECTS);

      // Verify entire entity pool is completely clean
      expect(levelEditor.getAllEntities().length).toBe(0);
      // Scene child count must return precisely to initial baseline
      expect(scene.children.length).toBe(initialSceneChildCount);
    });

    it('1.2 should survive mass burst spawn and bulk deletion of 500 objects simultaneously without memory leakage', () => {
      const catalog = levelEditor.assetCatalog;
      const allAssets = catalog.getAssets();
      const spawnedEntities: SelectableEntity[] = [];

      const initialSceneChildren = scene.children.length;

      // 1. Burst spawn 500 objects simultaneously into the scene
      for (let i = 0; i < 500; i++) {
        const assetDef = allAssets[i % allAssets.length];
        const wx = (i * 3.7) % 190 + 5;
        const wz = (i * 7.1) % 190 + 5;
        const entity = levelEditor.spawnAsset(assetDef.id, new THREE.Vector3(wx, 0, wz));
        spawnedEntities.push(entity);
      }

      expect(spawnedEntities.length).toBe(500);
      expect(levelEditor.getAllEntities().length).toBe(500);

      // 2. Manipulate all 500 entities
      for (let i = 0; i < 500; i++) {
        const entity = spawnedEntities[i];
        entity.rootObject.position.x += 10;
        entity.rootObject.position.z += 10;
        (levelEditor as any).handleEntityMoved(entity);
      }

      // 3. Bulk delete all 500 entities in mixed order (odd first, then even)
      const deletionOrder = [
        ...spawnedEntities.filter((_, idx) => idx % 2 === 1),
        ...spawnedEntities.filter((_, idx) => idx % 2 === 0),
      ];

      for (const entity of deletionOrder) {
        levelEditor.select(entity);
        const success = levelEditor.deleteSelected();
        expect(success).toBe(true);
      }

      // 4. Assert zero leakage
      expect(levelEditor.getAllEntities().length).toBe(0);
      expect(levelEditor.getSelected()).toBeNull();
      expect(scene.children.length).toBe(initialSceneChildren);

      // Verify internal spatial partitioning maps are wiped
      const chunkCoords = levelEditor.getDirtyChunks();
      for (const cid of chunkCoords) {
        expect(levelEditor.getEntitiesByChunk(cid).length).toBe(0);
      }
    });

    it('1.3 should handle disposeHierarchy() edge cases robustly (null, empty, cyclic, light shadows, multi-materials)', () => {
      // Robustness to null / undefined
      expect(() => disposeHierarchy(null)).not.toThrow();
      expect(() => disposeHierarchy(undefined)).not.toThrow();

      // Empty group
      const emptyGroup = new THREE.Group();
      expect(() => disposeHierarchy(emptyGroup)).not.toThrow();

      // Multi-material mesh
      const multiGeo = new THREE.BoxGeometry(1, 1, 1);
      const multiMats = [
        new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
      ];
      const multiMatMesh = new THREE.Mesh(multiGeo, multiMats);
      scene.add(multiMatMesh);

      const geoSpy = vi.spyOn(multiGeo, 'dispose');
      const matSpies = multiMats.map((m) => vi.spyOn(m, 'dispose'));

      disposeHierarchy(multiMatMesh);

      expect(geoSpy).toHaveBeenCalledTimes(1);
      for (const spy of matSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
      expect(multiMatMesh.parent).toBeNull();

      // Light with shadow map
      const light = new THREE.PointLight(0xffffff, 1, 10);
      light.shadow.map = { dispose: vi.fn() } as any;
      scene.add(light);

      disposeHierarchy(light);
      expect((light.shadow.map as any).dispose).toHaveBeenCalledTimes(1);

      // Double disposal idempotency test
      const testMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial()
      );
      disposeHierarchy(testMesh);
      expect(() => disposeHierarchy(testMesh)).not.toThrow();
    });
  });

  // ==========================================================================
  // SECTION 2: Chunk Streaming 10% Memory Ceiling Invariant (<= 9 Chunks)
  // ==========================================================================

  describe('2. Chunk Streaming 10% Memory Ceiling Invariant (<= 9 Chunks / <= 10%)', () => {
    let streamerScene: THREE.Scene;
    let streamer: ChunkStreamer;

    beforeEach(() => {
      streamerScene = new THREE.Scene();
      streamer = new ChunkStreamer(streamerScene);
    });

    afterEach(() => {
      streamer.dispose();
      streamerScene.clear();
    });

    it('2.1 should strictly enforce loadedChunks <= 9 during high-speed diagonal flight across 200x200 world', () => {
      const speeds = [2, 5, 10, 20, 35, 50]; // Various speeds in m/frame

      for (const speed of speeds) {
        // Diagonal 1: (0, 0) -> (200, 200)
        for (let coord = 0; coord <= 200; coord += speed) {
          streamer.update(coord, coord);

          const loaded = streamer.getLoadedChunksCount();
          const cachePct = streamer.getCachePercentage();

          expect(loaded).toBeGreaterThanOrEqual(4);
          expect(loaded).toBeLessThanOrEqual(9);
          expect(cachePct).toBeLessThanOrEqual(9.0); // 9 out of 100 = 9.0% <= 10.0%
          expect(streamerScene.children.length).toBe(loaded);
        }

        // Diagonal 2: (200, 0) -> (0, 200)
        for (let t = 0; t <= 200; t += speed) {
          const x = 200 - t;
          const z = t;
          streamer.update(x, z);

          const loaded = streamer.getLoadedChunksCount();
          const cachePct = streamer.getCachePercentage();

          expect(loaded).toBeGreaterThanOrEqual(4);
          expect(loaded).toBeLessThanOrEqual(9);
          expect(cachePct).toBeLessThanOrEqual(9.0);
          expect(streamerScene.children.length).toBe(loaded);
        }
      }
    });

    it('2.2 should strictly preserve loadedChunks <= 9 under 1000 random high-speed teleportation jumps including out-of-bounds', () => {
      let maxChunksEverSeen = 0;
      let maxCacheEverSeen = 0;

      // 1000 jumps across normal space, world edges, corners, and out-of-bounds coords
      for (let jump = 0; jump < 1000; jump++) {
        let x: number;
        let z: number;

        if (jump % 20 === 0) {
          // Extreme negative coordinates
          x = -100 + Math.random() * 50;
          z = -100 + Math.random() * 50;
        } else if (jump % 20 === 1) {
          // Extreme positive out-of-bounds coordinates
          x = 220 + Math.random() * 100;
          z = 220 + Math.random() * 100;
        } else if (jump % 20 === 2) {
          // Boundary corners: (0,0), (0,200), (200,0), (200,200)
          const corners = [
            [0, 0],
            [0, 199.9],
            [199.9, 0],
            [199.9, 199.9],
          ];
          const c = corners[jump % 4];
          x = c[0];
          z = c[1];
        } else {
          // Standard random coordinates within world
          x = Math.random() * 200;
          z = Math.random() * 200;
        }

        streamer.update(x, z);

        const loaded = streamer.getLoadedChunksCount();
        const cachePct = streamer.getCachePercentage();

        if (loaded > maxChunksEverSeen) maxChunksEverSeen = loaded;
        if (cachePct > maxCacheEverSeen) maxCacheEverSeen = cachePct;

        // INVARIANT ASSERTIONS:
        expect(loaded).toBeGreaterThanOrEqual(4); // Min 4 at corners (2x2)
        expect(loaded).toBeLessThanOrEqual(9); // Max 9 at interior (3x3)
        expect(cachePct).toBeLessThanOrEqual(9.0); // <= 9.0% <= 10.0%
        expect(streamerScene.children.length).toBe(loaded);
      }

      expect(maxChunksEverSeen).toBe(9);
      expect(maxCacheEverSeen).toBe(9.0);
    });

    it('2.3 should enforce micro-tick atomic invariant: unloads execute before loads so memory never spikes > 9', () => {
      let microTickMaxChunks = 0;
      let currentActiveCount = 0;

      const trackedFactory = (cx: number, cz: number) => {
        currentActiveCount++;
        if (currentActiveCount > microTickMaxChunks) {
          microTickMaxChunks = currentActiveCount;
        }
        return ChunkBuilder.buildChunk(cx, cz);
      };

      const trackedDisposer = (group: THREE.Object3D) => {
        currentActiveCount--;
        disposeHierarchy(group);
      };

      const testStreamer = new ChunkStreamer(
        streamerScene,
        DEFAULT_CHUNK_CONFIG,
        trackedFactory,
        trackedDisposer
      );

      // Perform rapid jumps across diametrically opposite corners:
      // (10, 10) [corner 0_0] -> (190, 190) [corner 9_9] -> (10, 190) -> (190, 10)
      const oppositeJumps = [
        [10, 10],
        [190, 190],
        [10, 190],
        [190, 10],
        [100, 100],
        [10, 10],
        [190, 190],
      ];

      for (const [x, z] of oppositeJumps) {
        testStreamer.update(x, z);

        // At every step after update
        expect(testStreamer.getLoadedChunksCount()).toBeLessThanOrEqual(9);
      }

      // Assert that AT NO INSTANT during execution did currentActiveCount exceed 9
      // (Because unloads happened strictly before loads)
      expect(microTickMaxChunks).toBeLessThanOrEqual(9);

      testStreamer.dispose();
      expect(currentActiveCount).toBe(0);
    });

    it('2.4 should maintain continuous 10% ceiling through 2000 frames of camera flight in LevelEditor mode', () => {
      // Simulate camera flight via EditorCamera
      const editorCam = levelEditor.editorCamera;
      let totalLoads = 0;
      let totalUnloads = 0;

      const trackingStreamer = new ChunkStreamer(
        scene,
        DEFAULT_CHUNK_CONFIG,
        (cx, cz) => {
          totalLoads++;
          return ChunkBuilder.buildChunk(cx, cz);
        },
        (group) => {
          totalUnloads++;
          disposeHierarchy(group);
        }
      );

      // Flight along a complex Lissajous trajectory for 2000 simulated frames
      for (let frame = 0; frame < 2000; frame++) {
        const t = frame * 0.05;
        // Lissajous curve inside [10..190]
        const camX = 100 + 85 * Math.sin(t * 0.7);
        const camZ = 100 + 85 * Math.sin(t * 1.1);

        editorCam.setPosition(new THREE.Vector3(camX, 15, camZ));
        levelEditor.update(0.016);

        // Feed camera coordinates to ChunkStreamer
        trackingStreamer.update(camX, camZ);

        const loaded = trackingStreamer.getLoadedChunksCount();
        expect(loaded).toBeGreaterThanOrEqual(4);
        expect(loaded).toBeLessThanOrEqual(9);
        expect(trackingStreamer.getCachePercentage()).toBeLessThanOrEqual(9.0);
      }

      // Assert high churn was executed
      expect(totalLoads).toBeGreaterThan(50);
      expect(totalUnloads).toBeGreaterThan(40);

      // Clean disposal
      trackingStreamer.dispose();
      expect(trackingStreamer.getLoadedChunksCount()).toBe(0);
    });

    it('2.5 should gracefully handle invalid inputs (NaN, Infinity, undefined) without crashing or violating cache bounds', () => {
      // Initialize with valid center
      streamer.update(100, 100);
      expect(streamer.getLoadedChunksCount()).toBe(9);

      // Feed NaN
      const resNaN = streamer.update(NaN, 100);
      expect(resNaN).toBe(false);
      expect(streamer.getLoadedChunksCount()).toBe(9);

      // Feed Infinity
      const resInf = streamer.update(Infinity, -Infinity);
      expect(resInf).toBe(false);
      expect(streamer.getLoadedChunksCount()).toBe(9);

      // Feed undefined
      const resUndef = streamer.update(undefined as any, 100);
      expect(resUndef).toBe(false);
      expect(streamer.getLoadedChunksCount()).toBe(9);
    });
  });
});
