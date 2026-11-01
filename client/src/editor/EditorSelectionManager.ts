/**
 * Rest-In-Hackaton: EditorSelectionManager
 * Object Selection, Raycast Picking, TransformControls & Deletion Subsystem.
 * Conforms to PROJECT.md Interface Contract 3.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { disposeHierarchy } from '../engine/ChunkBuilder';
import { worldToLocal } from './ChunkPersistence';

export { disposeHierarchy };

export interface SelectableEntity {
  id: string;
  type: 'prop' | 'npc' | 'building' | 'item' | 'lantern';
  assetId: string;
  rootObject: THREE.Object3D;
  chunkId: string;
  localPos?: { x: number; y: number; z: number };
  worldPos?: { x: number; y: number; z: number };
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface EditorSelectionManagerOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement?: HTMLElement | null;
  enableHotkeys?: boolean;
  enablePointerSelection?: boolean;
  defaultSnapTranslation?: number;
  defaultSnapRotation?: number;
}

/**
 * Recursively unfreezes matrixAutoUpdate on root and all its descendant children.
 * Crucial Invariant: Static chunk geometry has matrixAutoUpdate = false for render optimization.
 * When editing or selecting an entity, all descendants must have matrixAutoUpdate = true.
 */
export function unfreezeHierarchy(root: THREE.Object3D): void {
  if (!root) return;
  root.matrixAutoUpdate = true;
  root.traverse((child) => {
    child.matrixAutoUpdate = true;
    child.updateMatrix();
  });
}

export class EditorSelectionManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement | null;
  private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();

  private readonly transformControls: TransformControls;
  private boxHelper: THREE.BoxHelper | null = null;

  private selectedEntity: SelectableEntity | null = null;
  private gizmoMode: GizmoMode = 'translate';

  private translationSnap: number | null = null;
  private rotationSnap: number | null = null;
  private scaleSnap: number | null = null;

  private readonly defaultSnapTranslation: number = 0.5;
  private readonly defaultSnapRotation: number = Math.PI / 12; // 15 degrees

  private isDraggingGizmo: boolean = false;
  private enabled: boolean = true;
  private readonly enableHotkeys: boolean;
  private readonly enablePointerSelection: boolean;

  // Selectable entities registry
  private readonly selectableEntities: Map<string, SelectableEntity> = new Map();
  private readonly entityByRootObject: Map<THREE.Object3D, SelectableEntity> = new Map();

  // Event listener callbacks
  private readonly selectionChangedListeners: Set<(entity: SelectableEntity | null, prevEntity?: SelectableEntity | null) => void> = new Set();
  private readonly entityTransformedListeners: Set<(entity: SelectableEntity) => void> = new Set();
  private readonly draggingListeners: Set<(isDragging: boolean) => void> = new Set();
  private readonly entityDeletedListeners: Set<(entity: SelectableEntity) => void> = new Set();

  constructor(
    sceneOrOptions: THREE.Scene | EditorSelectionManagerOptions,
    camera?: THREE.Camera,
    domElement?: HTMLElement | null,
    options?: Partial<EditorSelectionManagerOptions>
  ) {
    let resolvedOptions: EditorSelectionManagerOptions;
    if (sceneOrOptions instanceof THREE.Scene) {
      resolvedOptions = {
        scene: sceneOrOptions,
        camera: camera!,
        domElement: domElement ?? null,
        ...options,
      };
    } else {
      resolvedOptions = sceneOrOptions;
    }

    this.scene = resolvedOptions.scene;
    this.camera = resolvedOptions.camera;
    this.domElement = resolvedOptions.domElement ?? null;
    this.enableHotkeys = resolvedOptions.enableHotkeys ?? true;
    this.enablePointerSelection = resolvedOptions.enablePointerSelection ?? true;
    if (resolvedOptions.defaultSnapTranslation !== undefined) {
      this.defaultSnapTranslation = resolvedOptions.defaultSnapTranslation;
    }
    if (resolvedOptions.defaultSnapRotation !== undefined) {
      this.defaultSnapRotation = resolvedOptions.defaultSnapRotation;
    }

    // Initialize TransformControls
    this.transformControls = new TransformControls(this.camera, this.domElement ?? undefined);
    const helper = this.transformControls.getHelper();
    if (helper) {
      helper.name = 'EditorTransformGizmoHelper';
      this.scene.add(helper);
    }

    this.setupTransformControlsEvents();
    this.attachDomListeners();
  }

  // =========================================================================
  // TransformControls Event Binding
  // =========================================================================

  private setupTransformControlsEvents(): void {
    // 1. Dragging changed notification (e.g. to pause camera flight/look)
    this.transformControls.addEventListener('dragging-changed', (event: any) => {
      const isDragging = Boolean(event.value);
      this.isDraggingGizmo = isDragging;
      for (const listener of this.draggingListeners) {
        try {
          listener(isDragging);
        } catch (err) {
          console.error('[EditorSelectionManager] Error in dragging listener:', err);
        }
      }
    });

    // 2. Change notification (transforms applied to selected entity)
    this.transformControls.addEventListener('change', () => {
      if (!this.selectedEntity) return;

      if (this.boxHelper) {
        this.boxHelper.update();
      }

      this.syncEntityCoordinates(this.selectedEntity);

      for (const listener of this.entityTransformedListeners) {
        try {
          listener(this.selectedEntity);
        } catch (err) {
          console.error('[EditorSelectionManager] Error in entityTransformed listener:', err);
        }
      }
    });
  }

  private syncEntityCoordinates(entity: SelectableEntity): void {
    const root = entity.rootObject;
    const worldPos = new THREE.Vector3();
    root.getWorldPosition(worldPos);
    entity.worldPos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    const { lx, lz } = worldToLocal(worldPos.x, worldPos.z);
    entity.localPos = { x: lx, y: worldPos.y, z: lz };
  }

  // =========================================================================
  // DOM & Hotkey Event Binding
  // =========================================================================

  private attachDomListeners(): void {
    if (this.enablePointerSelection && this.domElement) {
      this.domElement.addEventListener('pointerdown', this.handlePointerDown);
    }

    if (this.enableHotkeys) {
      if (typeof window !== 'undefined') {
        window.addEventListener('keydown', this.handleKeyDown);
      } else if (this.domElement) {
        this.domElement.addEventListener('keydown', this.handleKeyDown as any);
      }
    }
  }

  private detachDomListeners(): void {
    if (this.domElement) {
      this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
      this.domElement.removeEventListener('keydown', this.handleKeyDown as any);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleKeyDown);
    }
  }

  private isInputFocused(event?: KeyboardEvent): boolean {
    if (typeof document === 'undefined') return false;
    const activeEl = document.activeElement as HTMLElement | null;
    const target = event?.target as HTMLElement | null;
    for (const el of [activeEl, target]) {
      if (!el) continue;
      const tag = el.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as any).isContentEditable) {
        return true;
      }
    }
    return false;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;

    if (this.isInputFocused(event)) {
      return;
    }

    // Delete or Backspace -> deleteSelected
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedEntity) {
        if (typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        this.deleteSelected();
      }
      return;
    }

    // Shortcut modes: T (translate), R (rotate), S (scale)
    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 't') {
        this.setGizmoMode('translate');
      } else if (key === 'r') {
        this.setGizmoMode('rotate');
      } else if (key === 's') {
        this.setGizmoMode('scale');
      }
    }
  };

  private handlePointerDown = (event: PointerEvent | MouseEvent): void => {
    if (!this.enabled) return;

    // Left click only (button === 0). Right click is reserved for camera navigation
    if (event.button !== 0) return;

    // If mouse is currently hovering over or interacting with gizmo handle, ignore picking
    if (this.transformControls.axis !== null || this.isDraggingGizmo) {
      return;
    }

    if (!this.domElement) return;

    const rect = typeof this.domElement.getBoundingClientRect === 'function'
      ? this.domElement.getBoundingClientRect()
      : { left: 0, top: 0, width: (this.domElement as any).clientWidth || 800, height: (this.domElement as any).clientHeight || 600 };

    const width = rect.width || (this.domElement as any).clientWidth || 1;
    const height = rect.height || (this.domElement as any).clientHeight || 1;

    const clientX = (event as MouseEvent).clientX ?? 0;
    const clientY = (event as MouseEvent).clientY ?? 0;

    const ndcX = ((clientX - rect.left) / width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / height) * 2 + 1;

    this.raycastSelect(ndcX, ndcY);
  };

  // =========================================================================
  // Entity Registration & Management
  // =========================================================================

  public registerSelectable(entity: SelectableEntity): void {
    if (!entity || !entity.rootObject) return;

    entity.rootObject.userData.isSelectable = true;
    entity.rootObject.userData.selectableEntity = entity;
    entity.rootObject.userData.entityId = entity.id;

    this.selectableEntities.set(entity.id, entity);
    this.entityByRootObject.set(entity.rootObject, entity);
    this.syncEntityCoordinates(entity);
  }

  public registerSelectables(entities: SelectableEntity[]): void {
    for (const entity of entities) {
      this.registerSelectable(entity);
    }
  }

  public unregisterSelectable(idOrObject: string | THREE.Object3D): boolean {
    let id: string | null = null;
    let rootObject: THREE.Object3D | null = null;

    if (typeof idOrObject === 'string') {
      id = idOrObject;
      const entity = this.selectableEntities.get(id);
      rootObject = entity ? entity.rootObject : null;
    } else {
      rootObject = idOrObject;
      const entity = this.entityByRootObject.get(rootObject);
      id = entity ? entity.id : null;
    }

    if (!id && !rootObject) return false;

    if (id) this.selectableEntities.delete(id);
    if (rootObject) {
      this.entityByRootObject.delete(rootObject);
      if (rootObject.userData) {
        delete rootObject.userData.selectableEntity;
        delete rootObject.userData.isSelectable;
      }
    }

    return true;
  }

  public getSelectable(id: string): SelectableEntity | undefined {
    return this.selectableEntities.get(id);
  }

  public getAllSelectables(): SelectableEntity[] {
    return Array.from(this.selectableEntities.values());
  }

  public clearSelectables(): void {
    this.select(null);
    this.selectableEntities.clear();
    this.entityByRootObject.clear();
  }

  // =========================================================================
  // Selection & Highlighting
  // =========================================================================

  public select(entity: SelectableEntity | null): void {
    if (this.selectedEntity === entity) {
      return;
    }

    const prevEntity = this.selectedEntity;
    this.selectedEntity = entity;

    if (entity) {
      // Crucial Invariant: unfreeze matrixAutoUpdate for interactive editing
      unfreezeHierarchy(entity.rootObject);

      // Register if not already known
      if (!this.selectableEntities.has(entity.id)) {
        this.registerSelectable(entity);
      }

      // Attach TransformControls
      this.transformControls.attach(entity.rootObject);

      // Update BoxHelper
      this.updateBoxHelper();

      // Sync coordinate records
      this.syncEntityCoordinates(entity);
    } else {
      // Detach TransformControls
      this.transformControls.detach();

      // Remove BoxHelper
      this.removeBoxHelper();
    }

    // Fire selection change callbacks
    for (const listener of this.selectionChangedListeners) {
      try {
        listener(entity, prevEntity);
      } catch (err) {
        console.error('[EditorSelectionManager] Error in selectionChanged listener:', err);
      }
    }
  }

  public getSelected(): SelectableEntity | null {
    return this.selectedEntity;
  }

  private updateBoxHelper(): void {
    if (this.selectedEntity?.rootObject) {
      if (!this.boxHelper) {
        this.boxHelper = new THREE.BoxHelper(this.selectedEntity.rootObject, 0x00ffff);
        this.boxHelper.name = 'EditorSelectionBoxHelper';
        this.scene.add(this.boxHelper);
      } else {
        this.boxHelper.setFromObject(this.selectedEntity.rootObject);
        this.boxHelper.visible = true;
      }
      this.boxHelper.update();
    } else {
      this.removeBoxHelper();
    }
  }

  private removeBoxHelper(): void {
    if (this.boxHelper) {
      if (this.boxHelper.parent) {
        this.boxHelper.parent.remove(this.boxHelper);
      }
      if (this.boxHelper.geometry) {
        this.boxHelper.geometry.dispose();
      }
      if (this.boxHelper.material) {
        if (Array.isArray(this.boxHelper.material)) {
          this.boxHelper.material.forEach((m) => m.dispose());
        } else {
          this.boxHelper.material.dispose();
        }
      }
      this.boxHelper = null;
    }
  }

  public getBoxHelper(): THREE.BoxHelper | null {
    return this.boxHelper;
  }

  // =========================================================================
  // Raycast Picking & Upward Root Traversal
  // =========================================================================

  private isHelperObject(object: THREE.Object3D): boolean {
    if (object === this.boxHelper) return true;
    const helper = this.transformControls?.getHelper();
    let curr: THREE.Object3D | null = object;
    while (curr) {
      if (curr === this.boxHelper || (helper && curr === helper)) {
        return true;
      }
      curr = curr.parent;
    }
    return false;
  }

  /**
   * Upward traversal resolving any clicked child mesh to its tagged root entity.
   */
  public findSelectableRoot(object: THREE.Object3D | null): SelectableEntity | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      // 1. Explicit rootObject map lookup
      if (this.entityByRootObject.has(current)) {
        return this.entityByRootObject.get(current)!;
      }

      // 2. Attached SelectableEntity userData
      if (current.userData?.selectableEntity) {
        const entity = current.userData.selectableEntity as SelectableEntity;
        this.entityByRootObject.set(current, entity);
        this.selectableEntities.set(entity.id, entity);
        return entity;
      }

      // 3. Entity ID in known pool
      if (current.userData?.entityId && this.selectableEntities.has(current.userData.entityId)) {
        const entity = this.selectableEntities.get(current.userData.entityId)!;
        this.entityByRootObject.set(current, entity);
        return entity;
      }

      // 4. Tagged root object with isSelectable flag
      if (current.userData?.isSelectable) {
        const fallbackEntity: SelectableEntity = {
          id: current.userData.entityId || current.uuid,
          type: current.userData.type || 'prop',
          assetId: current.userData.assetId || current.name || 'unknown',
          rootObject: current,
          chunkId: current.userData.chunkId || '0_0',
          worldPos: { x: current.position.x, y: current.position.y, z: current.position.z },
          localPos: { x: current.position.x, y: current.position.y, z: current.position.z },
        };
        this.registerSelectable(fallbackEntity);
        return fallbackEntity;
      }

      current = current.parent;
    }
    return null;
  }

  /**
   * Performs raycasting against candidate selectable objects.
   * If an entity is hit, selects it and returns it.
   * If empty space or non-selectable mesh is hit, deselects and returns null.
   */
  public raycastSelect(normalizedX: number, normalizedY: number): SelectableEntity | null {
    this.raycaster.setFromCamera(new THREE.Vector2(normalizedX, normalizedY), this.camera);

    // Collect candidate root objects
    const candidateRoots: THREE.Object3D[] = [];
    for (const entity of this.selectableEntities.values()) {
      if (entity.rootObject && entity.rootObject.visible !== false) {
        candidateRoots.push(entity.rootObject);
      }
    }

    // If no explicit registered entities, look for scene objects tagged with isSelectable
    if (candidateRoots.length === 0) {
      this.scene.traverse((child) => {
        if (child.userData?.isSelectable && child.visible !== false) {
          candidateRoots.push(child);
        }
      });
    }

    if (candidateRoots.length === 0) {
      this.select(null);
      return null;
    }

    const intersects = this.raycaster.intersectObjects(candidateRoots, true);

    for (const hit of intersects) {
      if (this.isHelperObject(hit.object)) {
        continue;
      }
      const rootEntity = this.findSelectableRoot(hit.object);
      if (rootEntity) {
        this.select(rootEntity);
        return rootEntity;
      }
    }

    // Clicked empty space or untagged geometry
    this.select(null);
    return null;
  }

  // =========================================================================
  // TransformControls & Gizmo Modes
  // =========================================================================

  public setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.transformControls.setMode(mode);
  }

  public getGizmoMode(): GizmoMode {
    return this.gizmoMode;
  }

  public getTransformControls(): TransformControls {
    return this.transformControls;
  }

  public isDragging(): boolean {
    return this.isDraggingGizmo;
  }

  // =========================================================================
  // Snapping Configuration
  // =========================================================================

  public setTranslationSnap(snap: number | null): void {
    this.translationSnap = snap;
    this.transformControls.setTranslationSnap(snap);
  }

  public getTranslationSnap(): number | null {
    return this.translationSnap;
  }

  public setRotationSnap(snap: number | null): void {
    this.rotationSnap = snap;
    this.transformControls.setRotationSnap(snap);
  }

  public getRotationSnap(): number | null {
    return this.rotationSnap;
  }

  public setScaleSnap(snap: number | null): void {
    this.scaleSnap = snap;
    this.transformControls.setScaleSnap(snap);
  }

  public getScaleSnap(): number | null {
    return this.scaleSnap;
  }

  public toggleTranslationSnap(enabled?: boolean, snapValue = this.defaultSnapTranslation): boolean {
    const shouldEnable = enabled !== undefined ? enabled : this.translationSnap === null;
    this.setTranslationSnap(shouldEnable ? snapValue : null);
    return shouldEnable;
  }

  public toggleRotationSnap(enabled?: boolean, snapValue = this.defaultSnapRotation): boolean {
    const shouldEnable = enabled !== undefined ? enabled : this.rotationSnap === null;
    this.setRotationSnap(shouldEnable ? snapValue : null);
    return shouldEnable;
  }

  public isTranslationSnapEnabled(): boolean {
    return this.translationSnap !== null && this.translationSnap > 0;
  }

  public isRotationSnapEnabled(): boolean {
    return this.rotationSnap !== null && this.rotationSnap > 0;
  }

  // =========================================================================
  // Deletion & Deep GPU Cleanup
  // =========================================================================

  public deleteSelected(): boolean {
    if (!this.selectedEntity) {
      return false;
    }

    const toDelete = this.selectedEntity;

    // 1. Detach gizmo first
    this.transformControls.detach();

    // 2. Remove BoxHelper
    this.removeBoxHelper();

    // 3. Clear current selection and notify
    this.selectedEntity = null;
    for (const listener of this.selectionChangedListeners) {
      try {
        listener(null, toDelete);
      } catch (err) {
        console.error('[EditorSelectionManager] Error in selectionChanged listener on delete:', err);
      }
    }

    // 4. Remove from selectable pool
    this.unregisterSelectable(toDelete.id);

    // 5. Unlink from scene graph and parent
    const root = toDelete.rootObject;
    if (root && root.parent) {
      root.parent.remove(root);
    }

    // 6. Deep GPU disposal (geometries, materials, textures)
    disposeHierarchy(root);

    // 7. Fire deleted listeners
    for (const listener of this.entityDeletedListeners) {
      try {
        listener(toDelete);
      } catch (err) {
        console.error('[EditorSelectionManager] Error in entityDeleted listener:', err);
      }
    }

    return true;
  }

  // =========================================================================
  // Subscription Listeners
  // =========================================================================

  public onSelectionChanged(callback: (entity: SelectableEntity | null, prevEntity?: SelectableEntity | null) => void): () => void {
    this.selectionChangedListeners.add(callback);
    return () => {
      this.selectionChangedListeners.delete(callback);
    };
  }

  public onEntityTransformed(callback: (entity: SelectableEntity) => void): () => void {
    this.entityTransformedListeners.add(callback);
    return () => {
      this.entityTransformedListeners.delete(callback);
    };
  }

  public onDraggingChanged(callback: (isDragging: boolean) => void): () => void {
    this.draggingListeners.add(callback);
    return () => {
      this.draggingListeners.delete(callback);
    };
  }

  public onEntityDeleted(callback: (entity: SelectableEntity) => void): () => void {
    this.entityDeletedListeners.add(callback);
    return () => {
      this.entityDeletedListeners.delete(callback);
    };
  }

  // =========================================================================
  // Lifecycle Management
  // =========================================================================

  public enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.transformControls.enabled = true;
    this.attachDomListeners();
  }

  public disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.transformControls.enabled = false;
    this.detachDomListeners();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public update(): void {
    if (this.boxHelper && this.selectedEntity?.rootObject) {
      this.boxHelper.update();
    }
  }

  public dispose(): void {
    this.disable();
    this.select(null);
    this.removeBoxHelper();

    const helper = this.transformControls?.getHelper();
    if (helper && helper.parent) {
      helper.parent.remove(helper);
    }

    if (typeof (this.transformControls as any)?.dispose === 'function') {
      (this.transformControls as any).dispose();
    }

    this.selectableEntities.clear();
    this.entityByRootObject.clear();
    this.selectionChangedListeners.clear();
    this.entityTransformedListeners.clear();
    this.draggingListeners.clear();
    this.entityDeletedListeners.clear();
  }
}
