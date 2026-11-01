/**
 * LevelEditor.test.ts
 *
 * Automated Comprehensive Integration & E2E Test Suite for Milestone M5:
 * Master Integration, Full User Workflow Wiring & Automated Verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  LevelEditor,
  AppMode,
  EditorStateManager,
  EditorSelectionManager,
  AssetCatalog,
  AssetCatalogUI,
  PropertyInspector,
  RawChunkData,
} from '../src/editor/LevelEditor';
import { EditorCamera } from '../src/editor/EditorCamera';
import { PlayerGhostBeacon } from '../src/editor/PlayerGhostBeacon';
import { MockChunkStorage } from '../src/editor/ChunkStorage';
import {
  validateChunkData,
} from '../src/editor/ChunkPersistence';

// ============================================================================
// Headless DOM Environment Mocks
// ============================================================================

// ============================================================================
// Zero-Dependency Headless Mock DOM Harness for Node / Vitest
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
  public step: string = '';
  public min: string = '';
  public max: string = '';
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
    if (selector.startsWith('#')) {
      return this.id === selector.slice(1);
    }
    if (selector.startsWith('.')) {
      return this.classList.contains(selector.slice(1));
    }
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const inner = selector.slice(1, -1);
      const [attr, val] = inner.split('=');
      const cleanVal = val ? val.replace(/["']/g, '') : null;
      if (cleanVal !== null) {
        return this.getAttribute(attr) === cleanVal || (attr.startsWith('data-') && this.dataset[attr.slice(5)] === cleanVal);
      }
      return attr in this.attributes;
    }
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

  // Build HUD boilerplate
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

class MockHUD {
  public toasts: string[] = [];
  public showToast(msg: string): void {
    this.toasts.push(msg);
  }
}

class MockWorld {
  public invalidateCollisionCache = vi.fn();

  public invalidateWallBoundingBoxesCache(): void {
    this.invalidateCollisionCache();
  }
}

class MockPlayerController {
  private locked: boolean = false;
  private pos = new THREE.Vector3(100, 1.7, 100);
  private yaw: number = 0;

  public setLocked(l: boolean): void {
    this.locked = l;
  }
  public isLocked(): boolean {
    return this.locked;
  }
  public getPosition(): THREE.Vector3 {
    return this.pos.clone();
  }
  public getRotationY(): number {
    return this.yaw;
  }
  public resetCameraToPlayer(_yaw?: number): void {}
}

// ============================================================================
// Test Suite: Milestone M5 Master Integration
// ============================================================================

describe('Milestone M5: Level Editor Master Integration & Full Workflow', () => {
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let domElement: MockDomElement;
  let stateManager: EditorStateManager;
  let editorCamera: EditorCamera;
  let selectionManager: EditorSelectionManager;
  let assetCatalog: AssetCatalog;
  let catalogUI: AssetCatalogUI;
  let inspector: PropertyInspector;
  let storage: MockChunkStorage;
  let ghostBeacon: PlayerGhostBeacon;
  let playerController: MockPlayerController;
  let hud: MockHUD;
  let world: MockWorld;
  let editor: LevelEditor;

  beforeEach(() => {
    setupMockDOM();

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.1, 1000);
    camera.position.set(100, 15, 100);

    domElement = mockDoc.createElement('div');

    stateManager = new EditorStateManager(AppMode.GAME);
    editorCamera = new EditorCamera(camera, domElement as any);
    selectionManager = new EditorSelectionManager(scene, camera, domElement as any);
    assetCatalog = new AssetCatalog();
    catalogUI = new AssetCatalogUI(assetCatalog);
    inspector = new PropertyInspector();
    storage = new MockChunkStorage();
    ghostBeacon = new PlayerGhostBeacon(scene);
    playerController = new MockPlayerController();
    hud = new MockHUD();
    world = new MockWorld();

    editor = new LevelEditor({
      scene,
      camera,
      domElement: domElement as any,
      world: world as any,
      stateManager,
      editorCamera,
      selectionManager,
      assetCatalog,
      catalogUI,
      inspector,
      storage,
      ghostBeacon,
      playerController: playerController as any,
      hud: hud as any,
      autoInitUI: true,
    });
  });

  afterEach(() => {
    if (editor) {
      editor.dispose();
    }
    teardownMockDOM();
  });

  // ==========================================================================
  // 1. Mode Switching Lifecycle & Coordination
  // ==========================================================================
  describe('1. Mode Switching Lifecycle & Coordination', () => {
    it('should initialize in GAME mode by default with editor subsystems dormant', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);
      expect(editor.isGame()).toBe(true);
      expect(editor.isEditor()).toBe(false);

      expect(editorCamera.isEnabled()).toBe(false);
      expect(selectionManager.isEnabled()).toBe(false);
      expect(catalogUI.getElement().style.display).toBe('none');
      expect(inspector.getElement().style.display).toBe('none');
      expect(playerController.isLocked()).toBe(false);
    });

    it('should cleanly activate EDITOR mode and coordinate all subsystems', () => {
      const changed = editor.setMode(AppMode.EDITOR);
      expect(changed).toBe(true);

      expect(editor.getMode()).toBe(AppMode.EDITOR);
      expect(editor.isEditor()).toBe(true);
      expect(editor.isGame()).toBe(false);

      // Subsystem activation
      expect(editorCamera.isEnabled()).toBe(true);
      expect(selectionManager.isEnabled()).toBe(true);
      expect(catalogUI.getElement().style.display).toBe('flex');
      expect(inspector.getElement().style.display).toBe('flex');
      expect(playerController.isLocked()).toBe(true);

      // Ghost beacon mounted in scene
      expect(ghostBeacon.isSpawned()).toBe(true);

      // HUD Toast notification
      expect(hud.toasts).toContain('🛠️ Режим редактора уровней включен (F2)');
    });

    it('should return to GAME mode, restoring camera and unlocking player controller', () => {
      editor.setMode(AppMode.EDITOR);
      expect(editor.isEditor()).toBe(true);

      // Switch back to GAME mode
      const changed = editor.setMode(AppMode.GAME);
      expect(changed).toBe(true);

      expect(editor.getMode()).toBe(AppMode.GAME);
      expect(editor.isGame()).toBe(true);

      // Subsystems deactivated
      expect(editorCamera.isEnabled()).toBe(false);
      expect(selectionManager.isEnabled()).toBe(false);
      expect(catalogUI.getElement().style.display).toBe('none');
      expect(inspector.getElement().style.display).toBe('none');
      expect(playerController.isLocked()).toBe(false);
      expect(ghostBeacon.isSpawned()).toBe(false);

      // HUD Toast notification
      expect(hud.toasts).toContain('🎮 Игровой режим активирован (F2)');
    });

    it('should toggle mode back and forth with toggleMode()', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);

      const mode1 = editor.toggleMode();
      expect(mode1).toBe(AppMode.EDITOR);
      expect(editor.isEditor()).toBe(true);

      const mode2 = editor.toggleMode();
      expect(mode2).toBe(AppMode.GAME);
      expect(editor.isGame()).toBe(true);
    });

    it('should be idempotent when setting the currently active mode', () => {
      editor.setMode(AppMode.EDITOR);
      const toastCountBefore = hud.toasts.length;

      const repeated = editor.setMode(AppMode.EDITOR);
      expect(repeated).toBe(false);
      expect(hud.toasts.length).toBe(toastCountBefore);
    });
  });

  // ==========================================================================
  // 2. Free Fly Camera & Gizmo Dragging Decoupling
  // ==========================================================================
  describe('2. Free Fly Camera & Gizmo Dragging Decoupling', () => {
    it('should update free camera coordinates in editor update loop', () => {
      editor.setMode(AppMode.EDITOR);

      const startPos = editorCamera.getPosition();
      expect(startPos.x).toBe(100);
      expect(startPos.z).toBe(100);

      // Frame update
      editor.update(0.016);
      const postUpdatePos = editorCamera.getPosition();
      expect(postUpdatePos.x).toBe(100);
      expect(postUpdatePos.z).toBe(100);
    });

    it('should pause camera mouse look when gizmo dragging begins and resume when finished', () => {
      editor.setMode(AppMode.EDITOR);
      expect(editorCamera.isLookPaused()).toBe(false);

      // Gizmo dragging starts
      (selectionManager as any).isDraggingGizmo = true;
      (selectionManager as any).transformControls.dispatchEvent({ type: 'dragging-changed', value: true });
      expect(editorCamera.isLookPaused()).toBe(true);

      // Gizmo dragging finishes
      (selectionManager as any).isDraggingGizmo = false;
      (selectionManager as any).transformControls.dispatchEvent({ type: 'dragging-changed', value: false });
      expect(editorCamera.isLookPaused()).toBe(false);
    });

    it('should provide framing target for selected entity via focusTargetProvider', () => {
      editor.setMode(AppMode.EDITOR);

      // When nothing is selected, focus target is null
      const provider = (editorCamera as any).focusTargetProvider;
      expect(provider).toBeDefined();
      expect(provider()).toBeNull();

      // Spawn an asset
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(42, 0, 78));
      expect(editor.getSelected()).toBe(entity);

      // Focus target returns entity position
      const target = provider();
      expect(target).not.toBeNull();
      expect(target.position.x).toBeCloseTo(42);
      expect(target.position.z).toBeCloseTo(78);
      expect(target.distance).toBe(6.0);
    });
  });

  // ==========================================================================
  // 3. Asset Catalog Spawning & Scene Placement
  // ==========================================================================
  describe('3. Asset Catalog Spawning & Scene Placement', () => {
    it('should spawn a prop at specified world position and tag with selectable metadata', () => {
      editor.setMode(AppMode.EDITOR);

      const spawnPos = new THREE.Vector3(15.5, 0.0, 25.5);
      const entity = editor.spawnAsset('prop_crate', spawnPos);

      expect(entity).toBeDefined();
      expect(entity.assetId).toBe('prop_crate');
      expect(entity.rootObject).toBeDefined();
      expect(scene.children).toContain(entity.rootObject);

      // Coordinates
      expect(entity.worldPos?.x).toBeCloseTo(15.5);
      expect(entity.worldPos?.z).toBeCloseTo(25.5);
      expect(entity.chunkId).toBe('0_1'); // 15.5 / 20 = 0, 25.5 / 20 = 1

      // Tags
      expect(entity.rootObject.userData.isSelectable).toBe(true);
      expect(entity.rootObject.userData.assetId).toBe('prop_crate');
      expect(entity.rootObject.userData.chunkId).toBe('0_1');
      expect(entity.rootObject.userData.id).toBe(entity.id);
    });

    it('should automatically select newly spawned entity and attach BoxHelper & TransformControls', () => {
      editor.setMode(AppMode.EDITOR);

      const entity = editor.spawnAsset('prop_barrel', new THREE.Vector3(30, 0, 30));
      expect(editor.getSelected()).toBe(entity);

      // BoxHelper active in scene
      const boxHelper = selectionManager.getBoxHelper();
      expect(boxHelper).not.toBeNull();
      expect(boxHelper?.visible).toBe(true);
      expect(scene.children).toContain(boxHelper);

      // TransformControls attached
      expect(selectionManager.getTransformControls().object).toBe(entity.rootObject);

      // PropertyInspector bound
      expect(inspector.getBoundEntity()).toBe(entity);
    });

    it('should automatically mark host chunk as dirty when asset is spawned', () => {
      editor.setMode(AppMode.EDITOR);
      expect(editor.getDirtyCount()).toBe(0);

      editor.spawnAsset('prop_tree', new THREE.Vector3(55, 0, 85));
      expect(editor.isChunkDirty('2_4')).toBe(true); // 55/20=2, 85/20=4
      expect(editor.getDirtyCount()).toBe(1);
      expect(editor.getDirtyChunks()).toEqual(['2_4']);
    });

    it('should support spawning diverse catalog categories (NPC, Structure, Item)', () => {
      editor.setMode(AppMode.EDITOR);

      // NPC
      const npc = editor.spawnAsset('npc_lao_wang', new THREE.Vector3(100, 0, 100));
      expect(npc.type).toBe('npcs');
      expect(npc.chunkId).toBe('5_5');

      // Structure
      const stall = editor.spawnAsset('structure_stall_tea', new THREE.Vector3(110, 0, 100));
      expect(stall.type).toBe('structures');
      expect(stall.chunkId).toBe('5_5');

      // Item
      const item = editor.spawnAsset('item_teapot', new THREE.Vector3(100, 1, 105));
      expect(item.type).toBe('items');
      expect(item.chunkId).toBe('5_5');

      expect(editor.getEntitiesByChunk('5_5').length).toBe(3);
    });

    it('should project spawn position in front of camera if position is omitted', () => {
      editor.setMode(AppMode.EDITOR);
      camera.position.set(50, 5, 50);
      camera.lookAt(new THREE.Vector3(50, 5, 100)); // Looking along +Z

      const entity = editor.spawnAsset('prop_bush');
      expect(entity.rootObject.position.x).toBeCloseTo(50, 0);
      expect(entity.rootObject.position.z).toBeGreaterThan(50); // Ahead of camera along +Z
    });
  });

  // ==========================================================================
  // 4. Visual Selection, BoxHelper & Invariants
  // ==========================================================================
  describe('4. Visual Selection, BoxHelper & Invariants', () => {
    it('should unfreeze matrixAutoUpdate recursively on selected entity', () => {
      editor.setMode(AppMode.EDITOR);

      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(20, 0, 20));
      // Manually freeze to simulate static chunk optimization
      entity.rootObject.matrixAutoUpdate = false;
      entity.rootObject.traverse((child) => {
        child.matrixAutoUpdate = false;
      });

      // Deselect and re-select
      editor.select(null);
      expect(editor.getSelected()).toBeNull();

      editor.select(entity);
      expect(editor.getSelected()).toBe(entity);

      // Invariant: all meshes must have matrixAutoUpdate = true
      expect(entity.rootObject.matrixAutoUpdate).toBe(true);
      entity.rootObject.traverse((child) => {
        expect(child.matrixAutoUpdate).toBe(true);
      });
    });

    it('should clean up BoxHelper and TransformControls when deselected', () => {
      editor.setMode(AppMode.EDITOR);

      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));
      expect(selectionManager.getBoxHelper()).not.toBeNull();
      expect(selectionManager.getTransformControls().object).toBe(entity.rootObject);

      // Deselect
      editor.select(null);
      expect(editor.getSelected()).toBeNull();
      expect(selectionManager.getBoxHelper()).toBeNull();
      expect(selectionManager.getTransformControls().object).toBeUndefined();
      expect(inspector.getBoundEntity()).toBeNull();
    });

    it('should switch selection smoothly between different entities', () => {
      editor.setMode(AppMode.EDITOR);

      const crate = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));
      const barrel = editor.spawnAsset('prop_barrel', new THREE.Vector3(30, 0, 30));

      expect(editor.getSelected()).toBe(barrel);
      expect(inspector.getBoundEntity()).toBe(barrel);

      editor.select(crate);
      expect(editor.getSelected()).toBe(crate);
      expect(inspector.getBoundEntity()).toBe(crate);
      expect(selectionManager.getTransformControls().object).toBe(crate.rootObject);
    });
  });

  // ==========================================================================
  // 5. Transform Manipulation & Live Property Inspector Synchronization
  // ==========================================================================
  describe('5. Transform Manipulation & Live Property Inspector Synchronization', () => {
    it('should switch gizmo modes (translate -> rotate -> scale) and sync with inspector', () => {
      editor.setMode(AppMode.EDITOR);
      editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));

      expect(selectionManager.getGizmoMode()).toBe('translate');

      // Change via selection manager
      selectionManager.setGizmoMode('rotate');
      expect(selectionManager.getGizmoMode()).toBe('rotate');

      // Change via inspector toolbar listener
      (inspector as any).gizmoModeListeners.forEach((fn: any) => fn('scale'));
      expect(selectionManager.getGizmoMode()).toBe('scale');
    });

    it('should update entity coordinates and inspector inputs when object transforms', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));

      // Translate entity root
      entity.rootObject.position.set(14.5, 2.0, 16.5);
      entity.rootObject.updateMatrixWorld();

      // Trigger transform change event (simulating gizmo drag)
      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

      // Entity coordinates synced
      expect(entity.worldPos?.x).toBeCloseTo(14.5);
      expect(entity.worldPos?.y).toBeCloseTo(2.0);
      expect(entity.worldPos?.z).toBeCloseTo(16.5);

      // Inspector updated
      expect(inspector.getBoundEntity()).toBe(entity);
      expect((inspector as any).posXInput.value).toBe('14.50');
      expect((inspector as any).posYInput.value).toBe('2.00');
      expect((inspector as any).posZInput.value).toBe('16.50');
    });

    it('should propagate property edits from inspector numeric inputs to 3D scene', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));

      // Simulate user editing numeric position inputs in PropertyInspector
      (inspector as any).posXInput.value = '18.75';
      (inspector as any).posXInput.dispatchEvent(new Event('change'));

      expect(entity.rootObject.position.x).toBeCloseTo(18.75);
      expect(entity.worldPos?.x).toBeCloseTo(18.75);

      // Simulate scale change
      (inspector as any).scaleInput.value = '2.5';
      (inspector as any).scaleInput.dispatchEvent(new Event('change'));

      expect(entity.rootObject.scale.x).toBeCloseTo(2.5);
      expect(entity.rootObject.scale.y).toBeCloseTo(2.5);
      expect(entity.rootObject.scale.z).toBeCloseTo(2.5);
    });
  });

  // ==========================================================================
  // 6. Cross-Chunk Entity Boundary Migration
  // ==========================================================================
  describe('6. Cross-Chunk Entity Boundary Migration', () => {
    it('should keep entity in chunk 0_0 when moving within [0..20, 0..20]', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(5, 0, 5));
      expect(entity.chunkId).toBe('0_0');
      expect(editor.getEntitiesByChunk('0_0')).toContain(entity);

      // Move within chunk 0_0
      entity.rootObject.position.set(18, 0, 18);
      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

      expect(entity.chunkId).toBe('0_0');
      expect(entity.localPos?.x).toBeCloseTo(18);
      expect(entity.localPos?.z).toBeCloseTo(18);
      expect(editor.isChunkDirty('0_0')).toBe(true);
    });

    it('should migrate entity across chunk boundary from 0_0 to 1_0 and mark both chunks dirty', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(15, 0, 15));
      expect(entity.chunkId).toBe('0_0');
      editor.clearDirtyState();

      // Move across X boundary (x >= 20.0 enters column 1)
      entity.rootObject.position.set(25.5, 0, 15);
      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

      // Entity chunk updated
      expect(entity.chunkId).toBe('1_0');
      expect(entity.worldPos?.x).toBeCloseTo(25.5);
      expect(entity.localPos?.x).toBeCloseTo(5.5); // 25.5 - 1 * 20 = 5.5
      expect(entity.localPos?.z).toBeCloseTo(15.0);

      // Spatial sets updated
      expect(editor.getEntitiesByChunk('0_0')).not.toContain(entity);
      expect(editor.getEntitiesByChunk('1_0')).toContain(entity);

      // Both source and destination chunks marked dirty
      expect(editor.isChunkDirty('0_0')).toBe(true);
      expect(editor.isChunkDirty('1_0')).toBe(true);
      expect(editor.getDirtyChunks()).toEqual(['0_0', '1_0']);
    });

    it('should handle diagonal boundary crossing from 1_0 to 2_1', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(25, 0, 15));
      expect(entity.chunkId).toBe('1_0');
      editor.clearDirtyState();

      // Move diagonally into chunk 2_1 (x >= 40, z >= 20)
      entity.rootObject.position.set(45.2, 0, 28.4);
      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

      expect(entity.chunkId).toBe('2_1');
      expect(entity.localPos?.x).toBeCloseTo(5.2);
      expect(entity.localPos?.z).toBeCloseTo(8.4);

      expect(editor.getEntitiesByChunk('1_0')).not.toContain(entity);
      expect(editor.getEntitiesByChunk('2_1')).toContain(entity);
      expect(editor.isChunkDirty('1_0')).toBe(true);
      expect(editor.isChunkDirty('2_1')).toBe(true);
    });
  });

  // ==========================================================================
  // 7. Object Deletion & Deep GPU Disposal
  // ==========================================================================
  describe('7. Object Deletion & Deep GPU Disposal', () => {
    it('should delete selected object via deleteSelected() and remove from scene graph', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));
      const root = entity.rootObject;
      expect(scene.children).toContain(root);

      const deleted = editor.deleteSelected();
      expect(deleted).toBe(true);

      // Unlinked from scene graph
      expect(scene.children).not.toContain(root);
      expect(root.parent).toBeNull();

      // Selection cleared
      expect(editor.getSelected()).toBeNull();
      expect(selectionManager.getBoxHelper()).toBeNull();
      expect(selectionManager.getTransformControls().object).toBeUndefined();
      expect(inspector.getBoundEntity()).toBeNull();
    });

    it('should trigger deep GPU disposal on all geometries and materials upon deletion', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(10, 0, 10));

      const geometries: THREE.BufferGeometry[] = [];
      const materials: THREE.Material[] = [];

      entity.rootObject.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) {
            geometries.push(mesh.geometry);
            vi.spyOn(mesh.geometry, 'dispose');
          }
          if (mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
              materials.push(m);
              vi.spyOn(m, 'dispose');
            }
          }
        }
      });

      expect(geometries.length).toBeGreaterThan(0);
      expect(materials.length).toBeGreaterThan(0);

      editor.deleteSelected();

      // Verify each geometry and material dispose was executed
      for (const g of geometries) {
        expect(g.dispose).toHaveBeenCalled();
      }
      for (const m of materials) {
        expect(m.dispose).toHaveBeenCalled();
      }
    });

    it('should mark chunk dirty when an object in that chunk is deleted', () => {
      editor.setMode(AppMode.EDITOR);
      editor.spawnAsset('prop_crate', new THREE.Vector3(30, 0, 30)); // chunk 1_1
      editor.clearDirtyState();
      expect(editor.getDirtyCount()).toBe(0);

      editor.deleteSelected();
      expect(editor.isChunkDirty('1_1')).toBe(true);
      expect(editor.getEntitiesByChunk('1_1').length).toBe(0);
    });

    it('should invalidate cached collision boxes when an object is deleted', () => {
      editor.setMode(AppMode.EDITOR);
      editor.spawnAsset('structure_brick_wall', new THREE.Vector3(30, 0, 30));
      world.invalidateCollisionCache.mockClear();

      editor.deleteSelected();

      // The player controller must rebuild obstacles so the deleted wall
      // no longer blocks movement in Play Mode.
      expect(world.invalidateCollisionCache).toHaveBeenCalled();
    });

    it('should delete entity when delete button in PropertyInspector is clicked', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_barrel', new THREE.Vector3(10, 0, 10));
      expect(editor.getSelected()).toBe(entity);

      // Trigger delete from inspector listener
      (inspector as any).deleteListeners.forEach((fn: any) => fn(entity));

      expect(editor.getSelected()).toBeNull();
      expect(scene.children).not.toContain(entity.rootObject);
    });
  });

  // ==========================================================================
  // 8. Chunk Saving & Go Schema Validation
  // ==========================================================================
  describe('8. Chunk Saving & Go Schema Validation', () => {
    it('should serialize dirty chunks into Go-compatible RawChunkData with non-null arrays', async () => {
      editor.setMode(AppMode.EDITOR);

      // Spawn a stall structure in chunk 0_0
      editor.spawnAsset('structure_stall_tea', new THREE.Vector3(5, 0, 5));

      // Spawn an NPC in chunk 0_0
      editor.spawnAsset('npc_lao_wang', new THREE.Vector3(10, 0, 10));

      // Spawn an item in chunk 1_1
      editor.spawnAsset('item_teapot', new THREE.Vector3(25, 0.5, 25));

      expect(editor.getDirtyChunks()).toEqual(['0_0', '1_1']);

      const savedCount = await editor.saveAllDirtyChunks();
      expect(savedCount).toBe(2);

      // Verify dirty state cleared
      expect(editor.getDirtyCount()).toBe(0);

      // Load saved chunk 0_0 from storage
      const chunk00 = await storage.loadChunk('0_0');
      expect(chunk00).not.toBeNull();
      expect(chunk00?.chunk_id).toBe('0_0');

      // Go server strict non-null invariant validation
      expect(validateChunkData(chunk00!)).toBe(true);
      expect(Array.isArray(chunk00?.buildings)).toBe(true);
      expect(Array.isArray(chunk00?.lanterns)).toBe(true);
      expect(Array.isArray(chunk00?.signs)).toBe(true);
      expect(Array.isArray(chunk00?.npcs)).toBe(true);
      expect(Array.isArray(chunk00?.items)).toBe(true);

      // Buildings & NPCs present
      expect(chunk00?.buildings.length).toBeGreaterThanOrEqual(1);
      expect(chunk00?.npcs.length).toBeGreaterThanOrEqual(1);

      // Load saved chunk 1_1 from storage
      const chunk11 = await storage.loadChunk('1_1');
      expect(chunk11).not.toBeNull();
      expect(validateChunkData(chunk11!)).toBe(true);
      expect(chunk11?.items.length).toBeGreaterThanOrEqual(1);

      // Toast feedback
      expect(hud.toasts).toContain('✅ Изменения чанков сохранены на диск!');
    });

    it('should autosave dirty chunks after edits settle', async () => {
      vi.useFakeTimers();
      try {
        editor.setMode(AppMode.EDITOR);
        editor.spawnAsset('prop_crate', new THREE.Vector3(25, 0, 25)); // chunk 1_1

        expect(editor.getDirtyCount()).toBe(1);
        expect(storage.getChunkCount()).toBe(0);

        // Debounced autosave fires after the delay without pressing Ctrl+S.
        await vi.advanceTimersByTimeAsync(1300);

        expect(editor.getDirtyCount()).toBe(0);
        expect(storage.getChunkCount()).toBeGreaterThan(0);
        expect(storage.isDirty('1_1')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should save empty chunk when all entities in a dirty chunk are deleted', async () => {
      editor.setMode(AppMode.EDITOR);
      editor.spawnAsset('prop_crate', new THREE.Vector3(5, 0, 5));
      expect(editor.isChunkDirty('0_0')).toBe(true);

      // Delete the only entity
      editor.deleteSelected();
      expect(editor.isChunkDirty('0_0')).toBe(true);

      await editor.saveAllDirtyChunks();

      const chunk = await storage.loadChunk('0_0');
      expect(chunk).not.toBeNull();
      expect(validateChunkData(chunk!)).toBe(true);
      expect(chunk?.buildings.length).toBe(0);
      expect(chunk?.npcs.length).toBe(0);
      expect(chunk?.items.length).toBe(0);
    });

    it('should return 0 and show informational toast when saving with no dirty chunks', async () => {
      editor.setMode(AppMode.EDITOR);
      expect(editor.getDirtyCount()).toBe(0);

      const saved = await editor.saveAllDirtyChunks();
      expect(saved).toBe(0);
      expect(hud.toasts).toContain('ℹ️ Нет изменений чанков для сохранения');
    });
  });

  // ==========================================================================
  // 9. Startup World Reload & Entity Reconstruction
  // ==========================================================================
  describe('9. Startup World Reload & Entity Reconstruction', () => {
    it('should reconstruct entities in 3D scene from saved chunk configurations', async () => {
      // Seed storage with pre-existing saved chunk data
      const seedChunk: RawChunkData = {
        chunk_id: '3_4',
        buildings: [{ type: 'tea', x: 4.5, z: 6.5 }],
        lanterns: [{ x: 10.0, y: 3.5, z: 12.0 }],
        signs: [],
        npcs: [{ npc_id: 'lao_wang', x: 8.0, y: 0.0, z: 8.0 }],
        items: [{ item_id: 'teapot', x: 5.0, y: 1.0, z: 7.0 }],
      };
      await storage.saveChunk('3_4', seedChunk);

      // Load all stored chunks into editor
      const chunksLoaded = await editor.loadAllStoredChunks();
      expect(chunksLoaded).toBe(1);

      const entities = editor.getEntitiesByChunk('3_4');
      expect(entities.length).toBe(4); // 1 building, 1 lantern, 1 npc, 1 item

      // Verify reconstructed world coordinates for chunk 3_4:
      // cx = 3, cz = 4 -> worldX_origin = 60, worldZ_origin = 80
      const building = entities.find((e) => e.type === 'building' || (e.rootObject.userData as any).stallType);
      expect(building).toBeDefined();
      expect(building?.worldPos?.x).toBeCloseTo(60 + 4.5);
      expect(building?.worldPos?.z).toBeCloseTo(80 + 6.5);
      expect(scene.children).toContain(building?.rootObject);

      const npc = entities.find((e) => e.type === 'npc');
      expect(npc).toBeDefined();
      expect(npc?.worldPos?.x).toBeCloseTo(60 + 8.0);
      expect(npc?.worldPos?.z).toBeCloseTo(80 + 8.0);
      expect(scene.children).toContain(npc?.rootObject);

      const item = entities.find((e) => e.type === 'item');
      expect(item).toBeDefined();
      expect(item?.worldPos?.x).toBeCloseTo(60 + 5.0);
      expect(item?.worldPos?.z).toBeCloseTo(80 + 7.0);

      // Reconstructed entities are selectable immediately
      editor.select(building!);
      expect(editor.getSelected()).toBe(building);
      expect(inspector.getBoundEntity()).toBe(building);
    });

    it('should avoid creating duplicate entities if chunk is reloaded multiple times', async () => {
      const seedChunk: RawChunkData = {
        chunk_id: '2_2',
        buildings: [{ type: 'general', x: 10.0, z: 10.0 }],
        lanterns: [],
        signs: [],
        npcs: [],
        items: [],
      };
      await storage.saveChunk('2_2', seedChunk);

      await editor.loadAllStoredChunks();
      const count1 = editor.getEntitiesByChunk('2_2').length;

      // Second load
      await editor.loadAllStoredChunks();
      const count2 = editor.getEntitiesByChunk('2_2').length;

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });
  });
});
