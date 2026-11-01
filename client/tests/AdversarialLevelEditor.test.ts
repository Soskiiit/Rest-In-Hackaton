/**
 * AdversarialLevelEditor.test.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS HARNESS FOR MILESTONE M5 (LEVEL EDITOR)
 * Challenger: challenger_lvl_1
 *
 * Challenge Dimensions:
 * 1. Mode Switching Stress & Concurrency:
 *    - 150-burst F2 hotkey spam within single millisecond (debounce stress).
 *    - 150-burst UI button click spam.
 *    - Sustained 120-cycle (240 state transitions) rapid mode cycling with time advancement.
 *    - Re-entrancy transition locking test (prevent recursive transition corruption).
 *    - Hostile DOM pointer lock rejection & exception handling.
 *    - Mode switch with active selection & active gizmo drag (clean teardown).
 *
 * 2. Coordinate & Extreme Boundary Value Stress:
 *    - Boundary coordinate placements: x=0, 20, 199.9, 200.
 *    - Pathological negative and extreme out-of-bounds coordinates (x=-100, x=350, sub-pixel floats).
 *    - Seam boundary oscillation: 100 rapid crossings back and forth between chunk 0_0 and 1_0.
 *
 * 3. Cross-Chunk Migration & Go Schema Invariant Verification:
 *    - 4-Way circuit migration (100 transitions across 4 chunks in loop).
 *    - Mass boundary placement: 200 entities across boundary seams without ID collisions.
 *    - Strict Go chunk schema compliance on all exported chunks:
 *      * chunk_id pattern ^\d+_\d+$
 *      * non-null slices for buildings, lanterns, signs, npcs, items
 *      * local coordinate invariant: 0 <= x < 20 and 0 <= z < 20
 *      * no duplicate entity IDs across or within chunks.
 *    - Migration followed by deletion ensuring clean persistence sync.
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
} from '../src/editor/LevelEditor';
import { EditorCamera } from '../src/editor/EditorCamera';
import { PlayerGhostBeacon } from '../src/editor/PlayerGhostBeacon';
import { MockChunkStorage } from '../src/editor/ChunkStorage';
import {
  validateChunkData,
} from '../src/editor/ChunkPersistence';

// ============================================================================
// Lightweight Headless DOM Harness
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
    if (selector.includes(' ')) {
      const parts = selector.split(/\s+/).filter(Boolean);
      let current: MockDomElement | null = this;
      for (const part of parts) {
        if (!current) return null;
        current = current.querySelector(part);
      }
      return current;
    }
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
  public exitPointerLockShouldThrow: boolean = false;

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
    if (this.exitPointerLockShouldThrow) {
      throw new Error('DOMException: The element is not pointer locked.');
    }
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

// ============================================================================
// Test Suite Setup
// ============================================================================

describe('Adversarial Level Editor Verification Suite (Milestone M5)', () => {
  let mockDoc: MockDocument;
  let mockWin: MockWindow;
  let originalDoc: any;
  let originalWin: any;

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
  let editor: LevelEditor;

  beforeEach(() => {
    originalDoc = (global as any).document;
    originalWin = (global as any).window;

    mockDoc = new MockDocument();
    mockWin = new MockWindow();
    mockWin.document = mockDoc;
    (global as any).document = mockDoc;
    (global as any).window = mockWin;

    // Build HUD DOM boilerplate
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

    // Three.js instances
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 1000);
    domElement = mockDoc.createElement('div');
    mockDoc.body.appendChild(domElement);

    stateManager = new EditorStateManager(AppMode.GAME);
    editorCamera = new EditorCamera(camera, domElement as any);
    selectionManager = new EditorSelectionManager(scene, camera, domElement as any);
    assetCatalog = new AssetCatalog();
    catalogUI = new AssetCatalogUI(assetCatalog);
    inspector = new PropertyInspector();
    storage = new MockChunkStorage();
    ghostBeacon = new PlayerGhostBeacon(scene);

    editor = new LevelEditor({
      scene,
      camera,
      domElement: domElement as any,
      stateManager,
      editorCamera,
      selectionManager,
      assetCatalog,
      catalogUI,
      inspector,
      storage,
      ghostBeacon,
      autoInitUI: true,
    });
  });

  afterEach(() => {
    editor.dispose();
    if (originalDoc) (global as any).document = originalDoc;
    else delete (global as any).document;
    if (originalWin) (global as any).window = originalWin;
    else delete (global as any).window;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Dimension 1: Mode Switching Stress & Debouncing Concurrency
  // ==========================================================================
  describe('Dimension 1: Mode Switching Stress & Debouncing Concurrency', () => {
    it('STRESS-MODE-01: Rapid 150-burst F2 hotkey spam within single millisecond must be cleanly debounced to exactly 1 transition', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);

      const initialTime = 10000;
      vi.spyOn(Date, 'now').mockReturnValue(initialTime);

      let transitionCount = 0;
      stateManager.addListener(() => {
        transitionCount++;
      });

      // Fire 150 F2 keydown events consecutively at the exact same timestamp
      for (let i = 0; i < 150; i++) {
        mockWin.dispatchEvent({
          type: 'keydown',
          key: 'F2',
          code: 'F2',
          repeat: false,
          preventDefault: () => {},
        });
      }

      // Assert: Exactly ONE transition occurred (GAME -> EDITOR), 149 were cleanly debounced
      expect(transitionCount).toBe(1);
      expect(editor.getMode()).toBe(AppMode.EDITOR);
      expect(editor.isEditor()).toBe(true);

      // Verify UI state consistency
      const toggleBtn = mockDoc.getElementById('mode-toggle-btn');
      expect(toggleBtn).not.toBeNull();
      expect(toggleBtn?.classList.contains('mode-editor-active')).toBe(true);
      expect(editorCamera.isEnabled()).toBe(true);
      expect(selectionManager.isEnabled()).toBe(true);
    });

    it('STRESS-MODE-02: Rapid 150-burst UI button click spam must trigger exactly 1 transition', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);

      const initialTime = 20000;
      vi.spyOn(Date, 'now').mockReturnValue(initialTime);

      const toggleBtn = mockDoc.getElementById('mode-toggle-btn');
      expect(toggleBtn).not.toBeNull();

      let transitionCount = 0;
      stateManager.addListener(() => {
        transitionCount++;
      });

      // Rapidly click the button 150 times
      for (let i = 0; i < 150; i++) {
        toggleBtn!.click();
      }

      expect(transitionCount).toBe(1);
      expect(editor.getMode()).toBe(AppMode.EDITOR);
    });

    it('STRESS-MODE-03: Sustained rapid cycling across 120 cycles (240 transitions) maintains strict state invariants without leaks', () => {
      let currentTime = 50000;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      const toggleBtn = mockDoc.getElementById('mode-toggle-btn');
      expect(toggleBtn).not.toBeNull();

      // Run 120 complete cycles (GAME -> EDITOR -> GAME = 240 toggles)
      for (let cycle = 0; cycle < 120; cycle++) {
        // Toggle to EDITOR (advance clock by 260ms > 250ms debounce threshold)
        currentTime += 260;
        toggleBtn!.click();

        expect(editor.getMode()).toBe(AppMode.EDITOR);
        expect(editor.isEditor()).toBe(true);
        expect(editorCamera.isEnabled()).toBe(true);
        expect(selectionManager.isEnabled()).toBe(true);
        expect((catalogUI as any).rootEl.style.display !== 'none').toBe(true);
        expect((inspector as any).rootEl.style.display !== 'none').toBe(true);

        // Toggle back to GAME
        currentTime += 260;
        toggleBtn!.click();

        expect(editor.getMode()).toBe(AppMode.GAME);
        expect(editor.isGame()).toBe(true);
        expect(editorCamera.isEnabled()).toBe(false);
        expect(selectionManager.isEnabled()).toBe(false);
        expect((catalogUI as any).rootEl.style.display !== 'none').toBe(false);
        expect((inspector as any).rootEl.style.display !== 'none').toBe(false);
      }

      // Verify scene is clean: ghost beacon was cleanly removed and did not leak meshes
      const ghostMeshes = scene.children.filter((c) => c.userData?.isGhostBeacon);
      expect(ghostMeshes.length).toBe(0);

      dateSpy.mockRestore();
    });

    it('STRESS-MODE-04: Re-entrant / recursive mode toggle during transition is safely rejected by transition lock', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);

      let reentrantCallResult: boolean | null = null;

      // Add a listener that attempts to re-enter setMode during transition
      stateManager.addListener((newMode) => {
        if (newMode === AppMode.EDITOR) {
          // Attempt recursive call back to GAME mode while transition is underway
          reentrantCallResult = editor.setMode(AppMode.GAME);
        }
      });

      const success = editor.setMode(AppMode.EDITOR);
      expect(success).toBe(true);
      expect(editor.getMode()).toBe(AppMode.EDITOR);

      // Re-entrant call must have been rejected by isModeTransitioning lock
      expect(reentrantCallResult).toBe(false);
    });

    it('STRESS-MODE-05: Hostile DOM pointer lock exception does not crash or corrupt editor mode transition', () => {
      expect(editor.getMode()).toBe(AppMode.GAME);

      // Simulate pointer locked element in DOM
      mockDoc.pointerLockElement = domElement;
      // Hostile browser throws DOMException when exitPointerLock is called
      mockDoc.exitPointerLockShouldThrow = true;

      // Should complete transition gracefully without unhandled exception
      expect(() => {
        editor.setMode(AppMode.EDITOR);
      }).not.toThrow();

      expect(editor.getMode()).toBe(AppMode.EDITOR);
      expect(editor.isEditor()).toBe(true);
    });

    it('DEFECT-01: Active gizmo drag look pause is leaked on mode switch to GAME, permanently freezing camera freelook', () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_tree', new THREE.Vector3(10, 0, 10));

      expect(editor.getSelected()).toBe(entity);
      expect(inspector.getBoundEntity()).toBe(entity);

      // Simulate user actively dragging the gizmo in EDITOR mode
      selectionManager.getTransformControls().dispatchEvent({ type: 'dragging-changed', value: true });
      expect(editorCamera.isLookPaused()).toBe(true);

      // Switch back to GAME mode
      editor.setMode(AppMode.GAME);

      // Selection is cleared
      expect(editor.getSelected()).toBeNull();
      expect(selectionManager.getSelected()).toBeNull();

      // EMPIRICAL DEFECT CHECK:
      // Camera look pause MUST be cleared when returning to GAME mode, so that subsequent
      // EDITOR mode activations do not inherit a frozen camera.
      // Current implementation defect: Neither selectionManager.disable() nor editorCamera.disable() resets _isLookPaused.
      expect(editorCamera.isLookPaused()).toBe(false);
    });
  });

  // ==========================================================================
  // Dimension 2: Coordinate & Extreme Boundary Value Stress
  // ==========================================================================
  describe('Dimension 2: Coordinate & Extreme Boundary Value Stress', () => {
    it('DEFECT-02: SelectionManager.select() corrupts entity.localPos by overwriting chunk-local coords with world coords', () => {
      editor.setMode(AppMode.EDITOR);

      // Place asset at x=20.0, z=20.0 (Chunk 1_1, chunk-local x=0, z=0)
      const entity = editor.spawnAsset('prop_bush', new THREE.Vector3(20, 0, 20));
      expect(entity.chunkId).toBe('1_1');

      // EMPIRICAL DEFECT CHECK:
      // LevelEditor.spawnAsset computes worldToLocal(20, 20) -> lx=0, lz=0.
      // But immediately calls selectionManager.select(entity), which invokes syncEntityCoordinates():
      //   entity.localPos = { x: root.position.x, y: root.position.y, z: root.position.z };
      // This overwrites chunk-local coordinates with world coordinates (x=20), violating Go's 0 <= x < 20 local schema.
      expect(entity.localPos?.x).toBeCloseTo(0, 3);
      expect(entity.localPos?.z).toBeCloseTo(0, 3);
    });

    it('STRESS-COORD-01: Boundary value asset placements (x=0, 20, 199.9, 200) strictly satisfy Go schema in exported JSON', async () => {
      editor.setMode(AppMode.EDITOR);

      const boundaryCoords = [
        { wx: 0, wz: 0, expectedChunk: '0_0' },
        { wx: 20, wz: 20, expectedChunk: '1_1' },
        { wx: 199.9, wz: 199.9, expectedChunk: '9_9' },
        { wx: 200, wz: 200, expectedChunk: '9_9' },
      ];

      for (const item of boundaryCoords) {
        const entity = editor.spawnAsset('prop_bush', new THREE.Vector3(item.wx, 0, item.wz));
        expect(entity.chunkId).toBe(item.expectedChunk);
      }

      // Save chunks and verify Go chunk data compliance
      const savedCount = await editor.saveAllDirtyChunks();
      expect(savedCount).toBeGreaterThan(0);

      const storedChunks = await storage.listChunks();
      for (const chunkId of storedChunks) {
        const rawChunk = await storage.loadChunk(chunkId);
        expect(rawChunk).not.toBeNull();
        expect(validateChunkData(rawChunk!)).toBe(true);

        for (const b of rawChunk!.buildings) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x).toBeLessThan(20);
          expect(b.z).toBeGreaterThanOrEqual(0);
          expect(b.z).toBeLessThan(20);
        }
      }
    });

    it('STRESS-COORD-02: Pathological out-of-bounds coordinates (x=-100, x=350, sub-pixel floats) clamp safely in Go chunk JSON', async () => {
      editor.setMode(AppMode.EDITOR);

      const pathologicalCoords = [
        { wx: -50.0, wz: -100.0, expectedChunk: '0_0' },
        { wx: -0.000001, wz: -0.000001, expectedChunk: '0_0' },
        { wx: 350.0, wz: 500.0, expectedChunk: '9_9' },
        { wx: 19.999999, wz: 39.999999, expectedChunk: '0_1' },
      ];

      for (const item of pathologicalCoords) {
        const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(item.wx, 0, item.wz));
        expect(entity.chunkId).toBe(item.expectedChunk);
      }

      await editor.saveAllDirtyChunks();
      const storedChunks = await storage.listChunks();
      for (const chunkId of storedChunks) {
        const rawChunk = await storage.loadChunk(chunkId);
        expect(validateChunkData(rawChunk!)).toBe(true);
        for (const b of rawChunk!.buildings) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x).toBeLessThan(20);
          expect(b.z).toBeGreaterThanOrEqual(0);
          expect(b.z).toBeLessThan(20);
        }
      }
    });

    it('STRESS-COORD-03: Boundary seam oscillation (100 rapid crossings) maintains strict entity uniqueness and spatial partition invariants', async () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_tree', new THREE.Vector3(19.95, 0, 10.0));
      expect(entity.chunkId).toBe('0_0');
      editor.clearDirtyState();

      // Oscillate across x = 20 boundary (between chunk 0_0 and 1_0) 100 times
      for (let i = 0; i < 100; i++) {
        const crossToChunk1 = i % 2 === 0;
        const targetX = crossToChunk1 ? 20.05 : 19.95;
        const expectedChunk = crossToChunk1 ? '1_0' : '0_0';

        entity.rootObject.position.x = targetX;
        selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

        expect(entity.chunkId).toBe(expectedChunk);

        // Invariant: Entity must be present in exactly one chunk set
        const inChunk0 = editor.getEntitiesByChunk('0_0').includes(entity);
        const inChunk1 = editor.getEntitiesByChunk('1_0').includes(entity);
        expect(Number(inChunk0) + Number(inChunk1)).toBe(1);

        // Invariant: Total registered selectables must remain 1
        expect(editor.getAllEntities().length).toBe(1);
      }

      // Both chunks must be marked dirty
      expect(editor.isChunkDirty('0_0')).toBe(true);
      expect(editor.isChunkDirty('1_0')).toBe(true);

      // Save and verify persistence
      await editor.saveAllDirtyChunks();
      const chunk0 = await storage.loadChunk('0_0');
      const chunk1 = await storage.loadChunk('1_0');

      expect(validateChunkData(chunk0!)).toBe(true);
      expect(validateChunkData(chunk1!)).toBe(true);

      // Entity ended at i=99 (crossToChunk1 = false -> targetX = 19.95 -> chunk 0_0)
      expect(chunk0!.buildings.length).toBe(1);
      expect(chunk1!.buildings.length).toBe(0);
    });
  });

  // ==========================================================================
  // Dimension 3: Cross-Chunk Migration & Go Schema Invariant Verification
  // ==========================================================================
  describe('Dimension 3: Cross-Chunk Migration & Go Schema Invariant Verification', () => {
    it('STRESS-MIGRATE-01: 4-Way circuit migration (100 transitions across 4 chunks) maintains data integrity and zero duplication', async () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('structure_lantern_red', new THREE.Vector3(10, 0, 10)); // chunk 0_0
      expect(entity.chunkId).toBe('0_0');
      editor.clearDirtyState();

      const waypoints = [
        { wx: 30, wz: 10, chunk: '1_0' },
        { wx: 30, wz: 30, chunk: '1_1' },
        { wx: 10, wz: 30, chunk: '0_1' },
        { wx: 10, wz: 10, chunk: '0_0' },
      ];

      // Execute 25 full loops (100 migrations)
      for (let loop = 0; loop < 25; loop++) {
        for (const wp of waypoints) {
          entity.rootObject.position.set(wp.wx, 0, wp.wz);
          selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

          expect(entity.chunkId).toBe(wp.chunk);
          expect(editor.getEntitiesByChunk(wp.chunk)).toContain(entity);
          expect(editor.getAllEntities().length).toBe(1);
        }
      }

      // Final state: entity returned to 0_0
      expect(entity.chunkId).toBe('0_0');
      expect(editor.getEntitiesByChunk('0_0').length).toBe(1);
      expect(editor.getEntitiesByChunk('1_0').length).toBe(0);
      expect(editor.getEntitiesByChunk('1_1').length).toBe(0);
      expect(editor.getEntitiesByChunk('0_1').length).toBe(0);

      // Save and verify Go schemas of all touched chunks
      await editor.saveAllDirtyChunks();
      for (const id of ['0_0', '1_0', '1_1', '0_1']) {
        const rawChunk = await storage.loadChunk(id);
        expect(rawChunk).not.toBeNull();
        expect(validateChunkData(rawChunk!)).toBe(true);
      }
    });

    it('STRESS-MIGRATE-02: Mass boundary placement of 200 entities guarantees zero ID collisions and strict Go schema compliance', async () => {
      editor.setMode(AppMode.EDITOR);

      const entityIds = new Set<string>();
      const boundaryValues = [0, 19.99, 20.0, 39.99, 40.0, 199.9, 200];

      // Spawn 200 entities at boundary coordinates
      for (let i = 0; i < 200; i++) {
        const bx = boundaryValues[i % boundaryValues.length];
        const bz = boundaryValues[(i * 3) % boundaryValues.length];

        const entity = editor.spawnAsset('prop_crate', new THREE.Vector3(bx, 0, bz));

        // Assert strictly unique IDs
        expect(entityIds.has(entity.id)).toBe(false);
        entityIds.add(entity.id);

        // Verify valid chunk coords
        expect(entity.chunkId).toMatch(/^\d+_\d+$/);
      }

      expect(entityIds.size).toBe(200);
      expect(editor.getAllEntities().length).toBe(200);

      // Save all dirty chunks
      const savedCount = await editor.saveAllDirtyChunks();
      expect(savedCount).toBeGreaterThan(0);

      // Verify every saved chunk adheres to Go server schema
      const chunkIds = await storage.listChunks();
      let totalSerializedBuildings = 0;

      for (const id of chunkIds) {
        const chunk = await storage.loadChunk(id);
        expect(chunk).not.toBeNull();

        // 1. Chunk ID pattern
        expect(chunk!.chunk_id).toBe(id);
        expect(chunk!.chunk_id).toMatch(/^\d+_\d+$/);

        // 2. Non-null array slices (Go requirement)
        expect(Array.isArray(chunk!.buildings)).toBe(true);
        expect(Array.isArray(chunk!.lanterns)).toBe(true);
        expect(Array.isArray(chunk!.signs)).toBe(true);
        expect(Array.isArray(chunk!.npcs)).toBe(true);
        expect(Array.isArray(chunk!.items)).toBe(true);

        // 3. Local coordinates in [0, 20)
        for (const b of chunk!.buildings) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x).toBeLessThan(20);
          expect(b.z).toBeGreaterThanOrEqual(0);
          expect(b.z).toBeLessThan(20);
        }

        totalSerializedBuildings += chunk!.buildings.length;
        expect(validateChunkData(chunk!)).toBe(true);
      }

      // Zero data loss: all 200 spawned buildings are represented
      expect(totalSerializedBuildings).toBe(200);
    });

    it('STRESS-MIGRATE-03: Entity migration across boundary followed by deletion synchronizes cleanly to persistence', async () => {
      editor.setMode(AppMode.EDITOR);
      const entity = editor.spawnAsset('prop_tree', new THREE.Vector3(5, 0, 5)); // chunk 0_0
      await editor.saveAllDirtyChunks();

      // Migrate to chunk 5_5
      entity.rootObject.position.set(105, 0, 105);
      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });
      expect(entity.chunkId).toBe('5_5');

      // Now delete entity while in chunk 5_5
      editor.select(entity);
      const deleted = editor.deleteSelected();
      expect(deleted).toBe(true);

      expect(editor.getAllEntities().length).toBe(0);
      expect(editor.getEntitiesByChunk('0_0').length).toBe(0);
      expect(editor.getEntitiesByChunk('5_5').length).toBe(0);

      // Save dirty chunks
      await editor.saveAllDirtyChunks();

      const chunk0 = await storage.loadChunk('0_0');
      const chunk5 = await storage.loadChunk('5_5');

      expect(validateChunkData(chunk0!)).toBe(true);
      expect(validateChunkData(chunk5!)).toBe(true);
      expect(chunk0!.buildings.length).toBe(0);
      expect(chunk5!.buildings.length).toBe(0);
    });
  });
});
