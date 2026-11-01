/**
 * Rest-In-Hackaton: Automated Test Suite for EditorSelectionManager
 * Milestone M2: Object Selection, Raycast Picking, TransformControls & Deletion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  EditorSelectionManager,
  SelectableEntity,
  unfreezeHierarchy,
  disposeHierarchy,
} from '../src/editor/EditorSelectionManager';

// Lightweight Mock DOM for testing headless events
class MockDomElement {
  public listeners: Record<string, Function[]> = {};
  public style: Record<string, string> = { touchAction: 'auto' };
  public clientWidth: number = 800;
  public clientHeight: number = 600;
  public ownerDocument: any = null;

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
}

class MockDocument {
  public activeElement: any = null;
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

class MockWindow {
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

describe('EditorSelectionManager (Milestone M2)', () => {
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let domElement: MockDomElement;
  let selectionManager: EditorSelectionManager;

  let origDoc: any;
  let origWin: any;
  let mockDoc: MockDocument;
  let mockWin: MockWindow;

  beforeEach(() => {
    origDoc = (globalThis as any).document;
    origWin = (globalThis as any).window;

    mockDoc = new MockDocument();
    mockWin = new MockWindow();
    (globalThis as any).document = mockDoc;
    (globalThis as any).window = mockWin;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
    // Camera positioned at (0, 0, 10) looking directly down -Z at origin (0, 0, 0)
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    domElement = new MockDomElement();
    domElement.ownerDocument = mockDoc;

    selectionManager = new EditorSelectionManager({
      scene,
      camera,
      domElement: domElement as unknown as HTMLElement,
      enableHotkeys: true,
      enablePointerSelection: true,
    });
  });

  afterEach(() => {
    selectionManager.dispose();
    scene.clear();

    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Raycast Selection & Upward Root Traversal
  // =========================================================================
  describe('Raycast Picking & Hierarchy Traversal', () => {
    it('should select tagged entity when raycasting hits a nested child mesh', () => {
      // Compound entity: Group root -> Child mesh
      const rootGroup = new THREE.Group();
      rootGroup.name = 'MarketStall_Root';
      rootGroup.position.set(0, 0, 0);

      const boxGeo = new THREE.BoxGeometry(2, 2, 2);
      const boxMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      const childMesh = new THREE.Mesh(boxGeo, boxMat);
      childMesh.name = 'TableMesh';
      rootGroup.add(childMesh);

      scene.add(rootGroup);
      rootGroup.updateMatrixWorld(true);

      const entity: SelectableEntity = {
        id: 'stall_1',
        type: 'building',
        assetId: 'stall_tea',
        rootObject: rootGroup,
        chunkId: '5_5',
      };

      selectionManager.registerSelectable(entity);

      // Raycast straight at center: NDC (0, 0)
      const selected = selectionManager.raycastSelect(0, 0);

      expect(selected).not.toBeNull();
      expect(selected?.id).toBe('stall_1');
      expect(selectionManager.getSelected()?.id).toBe('stall_1');
    });

    it('should resolve upward traversal across multiple hierarchy levels', () => {
      // Multi-tier hierarchy: Root Group -> Subgroup -> Child Mesh
      const root = new THREE.Group();
      const subGroup = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      subGroup.add(mesh);
      root.add(subGroup);

      const entity: SelectableEntity = {
        id: 'compound_npc',
        type: 'npc',
        assetId: 'vendor_chen',
        rootObject: root,
        chunkId: '5_5',
      };

      selectionManager.registerSelectable(entity);

      const resolved = selectionManager.findSelectableRoot(mesh);
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe('compound_npc');
      expect(resolved?.rootObject).toBe(root);
    });

    it('should select an object when clicking off-center or in empty gap within its bounding volume', () => {
      // Hollow archway object: left pillar at x = -1, right pillar at x = 1, empty space at center (0, 0)
      const archGroup = new THREE.Group();
      const pLeft = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 0.2), new THREE.MeshBasicMaterial());
      pLeft.position.set(-1, 0, 0);
      const pRight = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 0.2), new THREE.MeshBasicMaterial());
      pRight.position.set(1, 0, 0);
      archGroup.add(pLeft, pRight);

      scene.add(archGroup);
      archGroup.updateMatrixWorld(true);

      const archEntity: SelectableEntity = {
        id: 'hollow_arch',
        type: 'prop',
        assetId: 'arch',
        rootObject: archGroup,
        chunkId: '0_0',
      };
      selectionManager.registerSelectable(archEntity);

      // Raycast straight at NDC (0, 0), which is right in the center gap of the arch where no mesh exists!
      const selected = selectionManager.raycastSelect(0, 0);

      expect(selected).not.toBeNull();
      expect(selected?.id).toBe('hollow_arch');
      expect(selectionManager.getSelected()?.id).toBe('hollow_arch');
    });

    it('should ignore background meshes and deselect when background is clicked', () => {
      // 1. Tagged selectable entity at (0, 0, 0)
      const rootEntity = new THREE.Group();
      rootEntity.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      scene.add(rootEntity);
      rootEntity.updateMatrixWorld(true);

      const entity: SelectableEntity = {
        id: 'prop_barrel',
        type: 'prop',
        assetId: 'barrel',
        rootObject: rootEntity,
        chunkId: '5_5',
      };
      selectionManager.registerSelectable(entity);

      // Select it first
      selectionManager.select(entity);
      expect(selectionManager.getSelected()?.id).toBe('prop_barrel');

      // 2. Untagged background floor mesh placed at (20, 0, 0)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial());
      floor.position.set(20, 0, 0);
      scene.add(floor);
      floor.updateMatrixWorld(true);

      // Raycast away from selectable entity (e.g., raycast at NDC 0.8, 0.8 where entity is not located)
      const hit = selectionManager.raycastSelect(0.8, 0.8);
      expect(hit).toBeNull();
      expect(selectionManager.getSelected()).toBeNull();
    });

    it('should ignore TransformControls gizmo and BoxHelper during raycast picking', () => {
      const root = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      scene.add(root);
      root.updateMatrixWorld(true);

      const entity: SelectableEntity = {
        id: 'box_item',
        type: 'item',
        assetId: 'health_potion',
        rootObject: root,
        chunkId: '1_1',
      };
      selectionManager.registerSelectable(entity);
      selectionManager.select(entity);

      const boxHelper = selectionManager.getBoxHelper();
      expect(boxHelper).not.toBeNull();

      // Raycasting directly at center where BoxHelper lines and gizmo also overlap
      const hit = selectionManager.raycastSelect(0, 0);
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe('box_item');
    });

    it('should pick the closest entity when multiple selectable objects align along ray', () => {
      // Front entity at z = 2
      const frontMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      frontMesh.position.set(0, 0, 2);
      scene.add(frontMesh);
      frontMesh.updateMatrixWorld(true);

      const frontEntity: SelectableEntity = {
        id: 'front',
        type: 'prop',
        assetId: 'bush',
        rootObject: frontMesh,
        chunkId: '0_0',
      };
      selectionManager.registerSelectable(frontEntity);

      // Back entity at z = -2
      const backMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      backMesh.position.set(0, 0, -2);
      scene.add(backMesh);
      backMesh.updateMatrixWorld(true);

      const backEntity: SelectableEntity = {
        id: 'back',
        type: 'prop',
        assetId: 'tree',
        rootObject: backMesh,
        chunkId: '0_0',
      };
      selectionManager.registerSelectable(backEntity);

      const selected = selectionManager.raycastSelect(0, 0);
      expect(selected?.id).toBe('front');
    });
  });

  // =========================================================================
  // 2. Highlighting & BoxHelper Lifecycle
  // =========================================================================
  describe('Visual Highlighting via BoxHelper', () => {
    it('should create BoxHelper on selection and remove it on deselection', () => {
      const obj = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      scene.add(obj);

      const entity: SelectableEntity = {
        id: 'lantern_1',
        type: 'lantern',
        assetId: 'hanging_lantern',
        rootObject: obj,
        chunkId: '3_3',
      };

      expect(selectionManager.getBoxHelper()).toBeNull();

      selectionManager.select(entity);
      const helper = selectionManager.getBoxHelper();
      expect(helper).not.toBeNull();
      expect(helper?.parent).toBe(scene);

      // Deselect
      selectionManager.select(null);
      expect(selectionManager.getBoxHelper()).toBeNull();
      expect(scene.getObjectByName('EditorSelectionBoxHelper')).toBeUndefined();
    });

    it('should update BoxHelper geometry when update() is invoked', () => {
      const obj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      scene.add(obj);

      const entity: SelectableEntity = {
        id: 'test_obj',
        type: 'prop',
        assetId: 'pot',
        rootObject: obj,
        chunkId: '0_0',
      };

      selectionManager.select(entity);
      const helper = selectionManager.getBoxHelper()!;
      const updateSpy = vi.spyOn(helper, 'update');

      obj.position.set(10, 5, 2);
      selectionManager.update();

      expect(updateSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Crucial Invariant: Dynamic Matrix Unfreezing
  // =========================================================================
  describe('Crucial Invariant: Matrix Auto-Update Unfreezing', () => {
    it('should unfreeze matrixAutoUpdate recursively on selection of frozen entities', () => {
      const root = new THREE.Group();
      const child1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      const child2 = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
      root.add(child1);
      root.add(child2);

      // Simulate static chunk geometry matrix freezing
      root.matrixAutoUpdate = false;
      child1.matrixAutoUpdate = false;
      child2.matrixAutoUpdate = false;

      const entity: SelectableEntity = {
        id: 'frozen_stall',
        type: 'building',
        assetId: 'stall_weapon',
        rootObject: root,
        chunkId: '2_2',
      };

      selectionManager.select(entity);

      expect(root.matrixAutoUpdate).toBe(true);
      expect(child1.matrixAutoUpdate).toBe(true);
      expect(child2.matrixAutoUpdate).toBe(true);
    });

    it('unfreezeHierarchy utility function sets matrixAutoUpdate on standalone objects', () => {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh();
      group.add(mesh);
      group.matrixAutoUpdate = false;
      mesh.matrixAutoUpdate = false;

      unfreezeHierarchy(group);

      expect(group.matrixAutoUpdate).toBe(true);
      expect(mesh.matrixAutoUpdate).toBe(true);
    });
  });

  // =========================================================================
  // 4. TransformControls & Gizmo Modes
  // =========================================================================
  describe('TransformControls & Gizmo Modes', () => {
    it('should initialize with helper added to scene and translate as default mode', () => {
      const helper = selectionManager.getTransformControls().getHelper();
      expect(helper).toBeDefined();
      expect(helper.parent).toBe(scene);
      expect(selectionManager.getGizmoMode()).toBe('translate');
    });

    it('should support switching between translate, rotate, and scale modes', () => {
      selectionManager.setGizmoMode('rotate');
      expect(selectionManager.getGizmoMode()).toBe('rotate');
      expect(selectionManager.getTransformControls().getMode()).toBe('rotate');

      selectionManager.setGizmoMode('scale');
      expect(selectionManager.getGizmoMode()).toBe('scale');
      expect(selectionManager.getTransformControls().getMode()).toBe('scale');

      selectionManager.setGizmoMode('translate');
      expect(selectionManager.getGizmoMode()).toBe('translate');
      expect(selectionManager.getTransformControls().getMode()).toBe('translate');
    });

    it('should switch gizmo mode via keyboard hotkeys (T, R, S)', () => {
      const win = mockWin;

      // Dispatch 'r' key -> rotate
      win.dispatchEvent({ type: 'keydown', key: 'r' });
      expect(selectionManager.getGizmoMode()).toBe('rotate');

      // Dispatch 's' key -> scale
      win.dispatchEvent({ type: 'keydown', key: 's' });
      expect(selectionManager.getGizmoMode()).toBe('scale');

      // Dispatch 't' key -> translate
      win.dispatchEvent({ type: 'keydown', key: 't' });
      expect(selectionManager.getGizmoMode()).toBe('translate');
    });

    it('should ignore mode hotkeys when an input or textarea element has focus', () => {
      mockDoc.activeElement = { tagName: 'INPUT' };

      selectionManager.setGizmoMode('translate');
      mockWin.dispatchEvent({ type: 'keydown', key: 'r' });

      // Should remain 'translate'
      expect(selectionManager.getGizmoMode()).toBe('translate');
    });
  });

  // =========================================================================
  // 5. Snapping Configuration
  // =========================================================================
  describe('Snapping Configuration', () => {
    it('should configure translation and rotation snapping with default toggles', () => {
      expect(selectionManager.isTranslationSnapEnabled()).toBe(false);
      expect(selectionManager.isRotationSnapEnabled()).toBe(false);

      // Toggle translation snap ON (default: 0.5m)
      const transOn = selectionManager.toggleTranslationSnap();
      expect(transOn).toBe(true);
      expect(selectionManager.isTranslationSnapEnabled()).toBe(true);
      expect(selectionManager.getTranslationSnap()).toBe(0.5);

      // Toggle translation snap OFF
      const transOff = selectionManager.toggleTranslationSnap();
      expect(transOff).toBe(false);
      expect(selectionManager.isTranslationSnapEnabled()).toBe(false);
      expect(selectionManager.getTranslationSnap()).toBeNull();

      // Toggle rotation snap ON (default: Math.PI / 12 = 15 deg)
      const rotOn = selectionManager.toggleRotationSnap();
      expect(rotOn).toBe(true);
      expect(selectionManager.isRotationSnapEnabled()).toBe(true);
      expect(selectionManager.getRotationSnap()).toBeCloseTo(Math.PI / 12);

      // Toggle rotation snap OFF
      const rotOff = selectionManager.toggleRotationSnap();
      expect(rotOff).toBe(false);
      expect(selectionManager.isRotationSnapEnabled()).toBe(false);
      expect(selectionManager.getRotationSnap()).toBeNull();
    });

    it('should allow custom snap values for translation, rotation, and scale', () => {
      selectionManager.setTranslationSnap(1.5);
      expect(selectionManager.getTranslationSnap()).toBe(1.5);

      selectionManager.setRotationSnap(Math.PI / 4); // 45 deg
      expect(selectionManager.getRotationSnap()).toBeCloseTo(Math.PI / 4);

      selectionManager.setScaleSnap(0.25);
      expect(selectionManager.getScaleSnap()).toBe(0.25);
    });
  });

  // =========================================================================
  // 6. Dragging Changed Event & Camera Controller Hook
  // =========================================================================
  describe('Dragging Changed Event (Camera Look Pause)', () => {
    it('should notify registered listeners when gizmo dragging starts and ends', () => {
      const draggingHistory: boolean[] = [];
      const unsubscribe = selectionManager.onDraggingChanged((isDragging) => {
        draggingHistory.push(isDragging);
      });

      const controls = selectionManager.getTransformControls();

      // Simulate gizmo drag start
      controls.dispatchEvent({ type: 'dragging-changed', value: true });
      expect(selectionManager.isDragging()).toBe(true);

      // Simulate gizmo drag end
      controls.dispatchEvent({ type: 'dragging-changed', value: false });
      expect(selectionManager.isDragging()).toBe(false);

      expect(draggingHistory).toEqual([true, false]);

      // Unsubscribe
      unsubscribe();
      controls.dispatchEvent({ type: 'dragging-changed', value: true });
      expect(draggingHistory.length).toBe(2);
    });
  });

  // =========================================================================
  // 7. Transform Change Event & Coordinate Sync
  // =========================================================================
  describe('Transform Change Event & Coordinate Sync', () => {
    it('should fire onEntityTransformed and update entity local/world positions', () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      mesh.position.set(0, 0, 0);
      scene.add(mesh);

      const entity: SelectableEntity = {
        id: 'bench',
        type: 'prop',
        assetId: 'wooden_bench',
        rootObject: mesh,
        chunkId: '1_1',
      };
      selectionManager.select(entity);

      let transformedEntity: SelectableEntity | null = null;
      selectionManager.onEntityTransformed((ent) => {
        transformedEntity = ent;
      });

      // Modify position and dispatch change event on TransformControls
      mesh.position.set(5.5, 1.0, -3.2);
      mesh.updateMatrixWorld(true);

      selectionManager.getTransformControls().dispatchEvent({ type: 'change' });

      expect(transformedEntity).not.toBeNull();
      const entResult = transformedEntity as unknown as SelectableEntity;
      expect(entResult.localPos?.x).toBeCloseTo(5.5);
      expect(entResult.localPos?.y).toBeCloseTo(1.0);
      expect(entResult.localPos?.z).toBeCloseTo(-3.2);
      expect(entResult.worldPos?.x).toBeCloseTo(5.5);
      expect(entResult.worldPos?.y).toBeCloseTo(1.0);
      expect(entResult.worldPos?.z).toBeCloseTo(-3.2);
    });
  });

  // =========================================================================
  // 8. Deletion & Deep GPU Disposal
  // =========================================================================
  describe('Deletion & Deep GPU Memory Disposal', () => {
    it('should delete selected entity, unparent from scene, and dispose GPU resources deeply', () => {
      const geo = new THREE.BoxGeometry(2, 2, 2);
      const texture = new THREE.Texture();
      const mat = new THREE.MeshStandardMaterial({ map: texture });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);

      const geoDisposeSpy = vi.spyOn(geo, 'dispose');
      const matDisposeSpy = vi.spyOn(mat, 'dispose');
      const texDisposeSpy = vi.spyOn(texture, 'dispose');

      const entity: SelectableEntity = {
        id: 'stall_to_delete',
        type: 'building',
        assetId: 'stall_tea',
        rootObject: mesh,
        chunkId: '4_4',
      };

      selectionManager.select(entity);
      expect(selectionManager.getSelected()).toBe(entity);

      let deletedEntity: SelectableEntity | null = null;
      selectionManager.onEntityDeleted((ent) => {
        deletedEntity = ent;
      });

      const result = selectionManager.deleteSelected();

      expect(result).toBe(true);
      expect(deletedEntity).toBe(entity);
      expect(selectionManager.getSelected()).toBeNull();
      expect(mesh.parent).toBeNull();
      expect(selectionManager.getSelectable('stall_to_delete')).toBeUndefined();
      expect(selectionManager.getBoxHelper()).toBeNull();

      // Deep GPU disposal assertions
      expect(geoDisposeSpy).toHaveBeenCalled();
      expect(matDisposeSpy).toHaveBeenCalled();
      expect(texDisposeSpy).toHaveBeenCalled();
    });

    it('should return false when calling deleteSelected() with nothing selected', () => {
      selectionManager.select(null);
      const res = selectionManager.deleteSelected();
      expect(res).toBe(false);
    });

    it('disposeHierarchy utility function disposes geometries and materials recursively', () => {
      const geo = new THREE.BoxGeometry();
      const mat = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(geo, mat);
      const geoSpy = vi.spyOn(geo, 'dispose');
      const matSpy = vi.spyOn(mat, 'dispose');

      disposeHierarchy(mesh);

      expect(geoSpy).toHaveBeenCalled();
      expect(matSpy).toHaveBeenCalled();
    });

    it('should delete selected entity via Delete and Backspace hotkeys', () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      scene.add(mesh);

      const entity: SelectableEntity = {
        id: 'hotkey_del',
        type: 'prop',
        assetId: 'barrel',
        rootObject: mesh,
        chunkId: '0_0',
      };
      selectionManager.select(entity);

      // Trigger 'Delete' key
      let preventDefaultCalled = false;
      mockWin.dispatchEvent({
        type: 'keydown',
        key: 'Delete',
        preventDefault: () => {
          preventDefaultCalled = true;
        },
      });

      expect(preventDefaultCalled).toBe(true);
      expect(selectionManager.getSelected()).toBeNull();
      expect(mesh.parent).toBeNull();
    });

    it('should NOT delete entity via hotkey when user is typing in an active input', () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      scene.add(mesh);

      const entity: SelectableEntity = {
        id: 'guarded_del',
        type: 'prop',
        assetId: 'barrel',
        rootObject: mesh,
        chunkId: '0_0',
      };
      selectionManager.select(entity);

      mockDoc.activeElement = { tagName: 'INPUT' };

      let preventDefaultCalled = false;
      mockWin.dispatchEvent({
        type: 'keydown',
        key: 'Backspace',
        preventDefault: () => {
          preventDefaultCalled = true;
        },
      });

      expect(preventDefaultCalled).toBe(false);
      expect(selectionManager.getSelected()).toBe(entity);
      expect(mesh.parent).toBe(scene);
    });
  });

  // =========================================================================
  // 9. Selection Change Callback Lifecycle
  // =========================================================================
  describe('Selection Change Callbacks', () => {
    it('should emit onSelectionChanged when selecting, switching, and deselecting', () => {
      const meshA = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      const meshB = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      scene.add(meshA);
      scene.add(meshB);

      const entityA: SelectableEntity = {
        id: 'A',
        type: 'prop',
        assetId: 'a',
        rootObject: meshA,
        chunkId: '0_0',
      };
      const entityB: SelectableEntity = {
        id: 'B',
        type: 'prop',
        assetId: 'b',
        rootObject: meshB,
        chunkId: '0_0',
      };

      const history: Array<{ current: string | null; prev: string | null }> = [];
      selectionManager.onSelectionChanged((curr, prev) => {
        history.push({
          current: curr ? curr.id : null,
          prev: prev ? prev.id : null,
        });
      });

      selectionManager.select(entityA);
      selectionManager.select(entityB);
      selectionManager.select(null);

      expect(history).toEqual([
        { current: 'A', prev: null },
        { current: 'B', prev: 'A' },
        { current: null, prev: 'B' },
      ]);
    });
  });

  // =========================================================================
  // 10. Pointer Down DOM Selection
  // =========================================================================
  describe('Pointer Down DOM Selection', () => {
    it('should trigger raycast on left pointerdown and select object', () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      mesh.position.set(0, 0, 0);
      scene.add(mesh);
      mesh.updateMatrixWorld(true);

      const entity: SelectableEntity = {
        id: 'pointer_entity',
        type: 'prop',
        assetId: 'tree',
        rootObject: mesh,
        chunkId: '0_0',
      };
      selectionManager.registerSelectable(entity);

      // Simulate left click at center of dom element (clientX = 400, clientY = 300 on 800x600 element)
      // ndc: ((400-0)/800)*2 - 1 = 0, -(((300-0)/600)*2 - 1) = 0
      domElement.dispatchEvent({
        type: 'pointerdown',
        button: 0,
        clientX: 400,
        clientY: 300,
      });

      expect(selectionManager.getSelected()?.id).toBe('pointer_entity');
    });

    it('should ignore right-click pointerdown events', () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      mesh.position.set(0, 0, 0);
      scene.add(mesh);
      mesh.updateMatrixWorld(true);

      const entity: SelectableEntity = {
        id: 'pointer_entity2',
        type: 'prop',
        assetId: 'tree',
        rootObject: mesh,
        chunkId: '0_0',
      };
      selectionManager.registerSelectable(entity);

      // Right click: button 2
      domElement.dispatchEvent({
        type: 'pointerdown',
        button: 2,
        clientX: 400,
        clientY: 300,
      });

      expect(selectionManager.getSelected()).toBeNull();
    });
  });
});
