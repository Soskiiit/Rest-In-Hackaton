/**
 * LevelEditor.ts
 *
 * Master Orchestrator for Milestone M5:
 * Integrates EditorStateManager, EditorCamera, EditorSelectionManager,
 * AssetCatalog, AssetCatalogUI, PropertyInspector, and ChunkPersistence / Storage.
 * Provides complete interactive level editing workflow, cross-chunk boundary migration,
 * deep GPU disposal, and Go-compatible chunk persistence.
 */

import * as THREE from 'three';
import { AppMode, EditorStateManager } from './EditorState';
import { EditorCamera } from './EditorCamera';
import { PlayerGhostBeacon } from './PlayerGhostBeacon';
import {
  EditorSelectionManager,
  SelectableEntity,
  GizmoMode,
} from './EditorSelectionManager';
import { AssetCatalog } from './AssetCatalog';
import { AssetCatalogUI } from './AssetCatalogUI';
import { PropertyInspector } from './PropertyInspector';
import {
  RawChunkData,
  createEmptyChunk,
  getChunkCoords,
  worldToLocal,
  serializeEntitiesToChunks,
  deserializeChunkToEntities,
} from './ChunkPersistence';
import {
  IChunkStorage,
  CompositeChunkStorage,
} from './ChunkStorage';
import type { PlayerController } from '../engine/PlayerController';
import type { World } from '../engine/World';
import type { HUD } from '../ui/HUD';

export { AppMode, EditorStateManager, EditorSelectionManager, AssetCatalog, AssetCatalogUI, PropertyInspector };
export type { SelectableEntity, GizmoMode, RawChunkData, IChunkStorage };

export interface LevelEditorOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  world?: World;
  stateManager?: EditorStateManager;
  editorCamera?: EditorCamera;
  selectionManager?: EditorSelectionManager;
  assetCatalog?: AssetCatalog;
  catalogUI?: AssetCatalogUI;
  inspector?: PropertyInspector;
  storage?: IChunkStorage;
  ghostBeacon?: PlayerGhostBeacon;
  playerController?: PlayerController;
  hud?: HUD;
  autoInitUI?: boolean;
}

export class LevelEditor {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly domElement: HTMLElement;
  public readonly world?: World;

  public readonly stateManager: EditorStateManager;
  public readonly editorCamera: EditorCamera;
  public readonly selectionManager: EditorSelectionManager;
  public readonly assetCatalog: AssetCatalog;
  public readonly catalogUI: AssetCatalogUI;
  public readonly inspector: PropertyInspector;
  public readonly storage: IChunkStorage;

  public ghostBeacon: PlayerGhostBeacon | null = null;
  public playerController: PlayerController | null = null;
  public hud: HUD | null = null;

  // Track modified chunks and active entities by chunk
  private readonly dirtyChunks: Set<string> = new Set();
  private readonly chunkEntities: Map<string, Set<SelectableEntity>> = new Map();

  // Autosave: persist changes shortly after the user stops editing.
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private isSavingChunks: boolean = false;
  private saveAgainAfterCurrent: boolean = false;
  private changeVersion: number = 0;
  private readonly AUTO_SAVE_DELAY_MS: number = 1200;

  // Top Toolbar / HUD UI References
  private modeToggleBtn: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private dirtyBadgeEl: HTMLElement | null = null;
  private editorStatsEl: HTMLElement | null = null;
  private editorCoordsEl: HTMLElement | null = null;
  private editorSpeedEl: HTMLElement | null = null;

  private isDisposed: boolean = false;
  private modeUnsubscribe: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  // Transition lock & input debouncing to prevent pointer lock conflicts
  private isModeTransitioning: boolean = false;
  private lastModeToggleTime: number = 0;
  private readonly MODE_TOGGLE_DEBOUNCE_MS: number = 250;

  constructor(options: LevelEditorOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.world = options.world;

    this.playerController = options.playerController ?? null;
    this.hud = options.hud ?? null;

    // Subsystems: use provided or initialize default instances
    this.stateManager = options.stateManager ?? new EditorStateManager(AppMode.GAME);

    this.editorCamera =
      options.editorCamera ??
      new EditorCamera(this.camera, this.domElement, {
        baseMoveSpeed: 15.0,
        shiftMultiplier: 2.5,
        altMultiplier: 0.3,
        wheelStep: 1.15,
      });

    this.selectionManager =
      options.selectionManager ??
      new EditorSelectionManager(this.scene, this.camera, this.domElement, {
        enableHotkeys: true,
        enablePointerSelection: true,
      });

    this.assetCatalog = options.assetCatalog ?? new AssetCatalog();
    this.catalogUI = options.catalogUI ?? new AssetCatalogUI(this.assetCatalog);
    this.inspector = options.inspector ?? new PropertyInspector();
    this.storage = options.storage ?? new CompositeChunkStorage();

    if (options.ghostBeacon) {
      this.ghostBeacon = options.ghostBeacon;
    } else if (this.scene) {
      this.ghostBeacon = new PlayerGhostBeacon(this.scene);
    }

    // Connect subsystem events and wire workflow
    this.setupSubsystemEvents();

    if (options.autoInitUI !== false) {
      this.initUI();
    }

    // Initial mode state synchronization
    this.syncModeState(this.stateManager.getMode());
  }

  // =========================================================================
  // Subsystem Event Wiring
  // =========================================================================

  private setupSubsystemEvents(): void {
    // 1. Editor mode listener
    this.modeUnsubscribe = this.stateManager.addListener((targetMode: AppMode, prevMode?: AppMode) => {
      this.handleModeChanged(targetMode, prevMode);
    });

    // 2. Camera <-> Gizmo dragging decoupling: pause camera freelook while dragging gizmo
    this.selectionManager.onDraggingChanged((isDragging: boolean) => {
      this.editorCamera.setLookPaused(isDragging);
    });

    // 3. Selection manager <-> Property inspector binding
    this.selectionManager.onSelectionChanged((entity: SelectableEntity | null) => {
      this.inspector.bindEntity(entity);
    });

    // 4. TransformControls change <-> Live inspector updates & cross-chunk boundary migration
    this.selectionManager.onEntityTransformed((entity: SelectableEntity) => {
      this.inspector.updateFromEntity();
      this.handleEntityMoved(entity);
    });

    // 5. Deletion notification
    this.selectionManager.onEntityDeleted((entity: SelectableEntity) => {
      this.handleEntityDeleted(entity);
    });

    // 6. Asset catalog spawn requests
    this.catalogUI.onAssetSpawn((assetId: string) => {
      this.spawnAsset(assetId);
    });

    // 7. Property inspector transform changes (numeric inputs live editing)
    this.inspector.onTransformChanged((object: THREE.Object3D) => {
      this.selectionManager.update();
      const entity = this.selectionManager.getSelected();
      if (entity && entity.rootObject === object) {
        this.handleEntityMoved(entity);
      }
    });

    // 8. Property inspector gizmo mode switcher
    this.inspector.onGizmoModeChange((mode: GizmoMode) => {
      this.selectionManager.setGizmoMode(mode);
    });

    // 9. Property inspector delete request button
    this.inspector.onDeleteRequested(() => {
      this.deleteSelected();
    });

    // 10. Focus target provider for framing camera on selected entity (key 'F')
    this.editorCamera.setFocusTargetProvider(() => {
      const selected = this.selectionManager.getSelected();
      if (selected && selected.rootObject) {
        return {
          position: selected.rootObject.position.clone(),
          distance: 6.0,
        };
      }
      return null;
    });

    // 11. Global keyboard shortcuts (Ctrl+S / Cmd+S save, F2 toggle)
    if (typeof window !== 'undefined') {
      this.keydownHandler = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          if (this.isEditor()) {
            e.preventDefault();
            void this.saveAllDirtyChunks();
          }
        } else if (e.key === 'F2' || e.code === 'F2') {
          e.preventDefault();
          if (e.repeat) return; // Prevent key repeat storm when held down
          const now = Date.now();
          if (now - this.lastModeToggleTime < this.MODE_TOGGLE_DEBOUNCE_MS) {
            return; // Debounce rapid key presses
          }
          this.lastModeToggleTime = now;
          this.toggleMode();
        }
      };
      window.addEventListener('keydown', this.keydownHandler);
    }
  }

  // =========================================================================
  // UI & HUD Toolbar Integration
  // =========================================================================

  public initUI(): void {
    if (typeof document === 'undefined') return;

    // Mount catalog and inspector panels into body if not already mounted
    if (!this.catalogUI.isAttached()) {
      this.catalogUI.mount(document.body);
    }
    if (!this.inspector.isAttached()) {
      this.inspector.mount(document.body);
    }

    // Locate HUD header or container
    const hudHeader = document.querySelector('#hud .hud-header');

    // 1. Mode Toggle Button
    this.modeToggleBtn = document.getElementById('mode-toggle-btn');
    if (!this.modeToggleBtn && hudHeader) {
      const btn = document.createElement('button');
      btn.id = 'mode-toggle-btn';
      btn.className = 'cyber-mode-btn';
      btn.type = 'button';
      btn.title = 'Переключить режим (F2)';
      btn.innerHTML = `<span id="mode-toggle-icon" class="mode-icon">🎮</span> <span id="mode-toggle-text">Play Mode</span> <span class="mode-hotkey">[F2]</span>`;
      const statusEl = document.getElementById('hud-status');
      if (statusEl && statusEl.parentNode === hudHeader) {
        hudHeader.insertBefore(btn, statusEl);
      } else {
        hudHeader.appendChild(btn);
      }
      this.modeToggleBtn = btn;
    }

    if (this.modeToggleBtn) {
      this.modeToggleBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (now - this.lastModeToggleTime < this.MODE_TOGGLE_DEBOUNCE_MS) {
          return;
        }
        this.lastModeToggleTime = now;
        this.toggleMode();
      };
    }

    // 2. Save Chunks Button with Dirty Counter Badge
    this.saveBtn = document.getElementById('save-chunks-btn') as HTMLButtonElement | null;
    if (!this.saveBtn && hudHeader) {
      const btn = document.createElement('button');
      btn.id = 'save-chunks-btn';
      btn.className = 'cyber-save-btn hidden';
      btn.type = 'button';
      btn.title = 'Сохранить изменения чанков (Ctrl+S)';
      btn.innerHTML = `<span class="save-icon">💾</span> <span class="save-text">Сохранить чанки</span> <span id="editor-dirty-badge" class="dirty-badge">0</span>`;
      hudHeader.appendChild(btn);
      this.saveBtn = btn;
    }

    if (this.saveBtn) {
      this.saveBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.saveAllDirtyChunks();
      };
    }

    this.dirtyBadgeEl = document.getElementById('editor-dirty-badge');

    // 3. Editor Telemetry Stats in HUD
    this.editorStatsEl = document.getElementById('hud-editor-stats');
    if (!this.editorStatsEl) {
      const hudBody = document.querySelector('#hud .hud-body');
      if (hudBody) {
        const stats = document.createElement('div');
        stats.id = 'hud-editor-stats';
        stats.className = 'hidden';
        stats.innerHTML = `
          <div class="hud-row">
            <span class="hud-label">РЕЖИМ:</span>
            <span id="hud-editor-badge" class="badge-editor">РЕДАКТОР УРОВНЕЙ</span>
          </div>
          <div class="hud-row">
            <span class="hud-label">КАМЕРА (X, Y, Z):</span>
            <span id="hud-editor-coords" class="hud-val neon-cyan-val">(100.0, 15.0, 100.0)</span>
          </div>
          <div class="hud-row">
            <span class="hud-label">СКОРОСТЬ:</span>
            <span id="hud-editor-speed" class="hud-val neon-amber-val">15.0 m/s</span>
          </div>
          <div class="hud-row hud-editor-hints">
            <span class="editor-hint-text">WASD: полет | Q/E: высота | ПКМ: обзор | Колесо: скорость | T/R/S: гизмо</span>
          </div>
        `;
        hudBody.appendChild(stats);
        this.editorStatsEl = stats;
      }
    }

    this.editorCoordsEl = document.getElementById('hud-editor-coords');
    this.editorSpeedEl = document.getElementById('hud-editor-speed');

    this.updateDirtyUI();
  }

  // =========================================================================
  // Mode Lifecycle & Switching
  // =========================================================================

  public getMode(): AppMode {
    return this.stateManager.getMode();
  }

  public isEditor(): boolean {
    return this.stateManager.isEditor();
  }

  public isGame(): boolean {
    return this.stateManager.isGame();
  }

  public setMode(mode: AppMode): boolean {
    if (this.isModeTransitioning) {
      console.warn('[LevelEditor] setMode rejected: transition already in progress.');
      return false;
    }
    this.isModeTransitioning = true;
    try {
      return this.stateManager.setMode(mode);
    } finally {
      this.isModeTransitioning = false;
    }
  }

  public toggleMode(): AppMode {
    if (this.isModeTransitioning) {
      console.warn('[LevelEditor] toggleMode rejected: transition already in progress.');
      return this.stateManager.getMode();
    }
    this.isModeTransitioning = true;
    try {
      return this.stateManager.toggleMode();
    } finally {
      this.isModeTransitioning = false;
    }
  }

  private handleModeChanged(targetMode: AppMode, _prevMode?: AppMode): void {
    this.syncModeState(targetMode);
  }

  private syncModeState(mode: AppMode): void {
    const isEditor = mode === AppMode.EDITOR;

    if (isEditor) {
      // 1. Lock character controller and exit pointer lock safely
      if (this.playerController) {
        this.playerController.setLocked(true);
      }
      if (typeof document !== 'undefined' && document.pointerLockElement && document.exitPointerLock) {
        try {
          document.exitPointerLock();
        } catch {
          // Ignore
        }
      }

      // 2. Hide gameplay elements
      if (typeof document !== 'undefined') {
        const blocker = document.getElementById('blocker');
        if (blocker) blocker.style.display = 'none';
        const crosshair = document.getElementById('crosshair');
        if (crosshair) crosshair.classList.add('hidden');
        const prompt = document.getElementById('interaction-prompt');
        if (prompt) prompt.classList.add('hidden');
      }

      // 3. Spawn ghost beacon at player position
      if (this.ghostBeacon && this.playerController) {
        const playerPos = this.playerController.getPosition();
        const playerYaw = this.playerController.getRotationY();
        this.ghostBeacon.spawn(playerPos, playerYaw);
      }

      // 4. Enable free fly camera
      this.editorCamera.enable();

      // 5. Enable selection manager
      this.selectionManager.enable();

      // 6. Show editor UI panels
      this.catalogUI.setVisible(true);
      this.inspector.setVisible(true);

      // 7. Show top toolbar editor buttons and stats
      if (this.saveBtn) {
        this.saveBtn.classList.remove('hidden');
      }
      if (this.editorStatsEl) {
        this.editorStatsEl.classList.remove('hidden');
      }

      // 8. Update mode button label and styling
      this.updateModeButtonUI(true);

      // 9. Toast feedback
      this.showToast('🛠️ Режим редактора уровней включен (F2)');
    } else {
      // Returning to GAME mode
      // 1. Deselect any active entity and disable selection manager
      this.selectionManager.select(null);
      this.selectionManager.disable();

      // 2. Disable free fly camera
      this.editorCamera.setLookPaused(false);
      this.editorCamera.disable();

      // 3. Remove ghost beacon
      if (this.ghostBeacon) {
        this.ghostBeacon.remove();
      }

      // 4. Restore camera to player and unlock player controller
      if (this.playerController) {
        this.playerController.resetCameraToPlayer?.();
        this.playerController.setLocked(false);
      }

      // 5. Hide editor panels
      this.catalogUI.setVisible(false);
      this.inspector.setVisible(false);

      // 6. Hide save button and editor stats
      if (this.saveBtn) {
        this.saveBtn.classList.add('hidden');
      }
      if (this.editorStatsEl) {
        this.editorStatsEl.classList.add('hidden');
      }

      // 7. Restore gameplay crosshair
      if (typeof document !== 'undefined') {
        const crosshair = document.getElementById('crosshair');
        if (crosshair) crosshair.classList.remove('hidden');
      }

      // 8. Update mode button label
      this.updateModeButtonUI(false);

      // 9. Toast feedback
      this.showToast('🎮 Игровой режим активирован (F2)');
    }
  }

  private updateModeButtonUI(isEditor: boolean): void {
    if (!this.modeToggleBtn) return;

    if (isEditor) {
      this.modeToggleBtn.classList.add('mode-editor-active');
      this.modeToggleBtn.innerHTML = `<span id="mode-toggle-icon" class="mode-icon">🛠️</span> <span id="mode-toggle-text">Level Editor</span> <span class="mode-hotkey">[F2]</span>`;
    } else {
      this.modeToggleBtn.classList.remove('mode-editor-active');
      this.modeToggleBtn.innerHTML = `<span id="mode-toggle-icon" class="mode-icon">🎮</span> <span id="mode-toggle-text">Play Mode</span> <span class="mode-hotkey">[F2]</span>`;
    }
  }

  // =========================================================================
  // Frame Update Loop
  // =========================================================================

  public update(delta: number): void {
    if (!this.isEditor()) {
      return;
    }

    this.editorCamera.update(delta);

    if (this.ghostBeacon) {
      this.ghostBeacon.update(delta);
    }

    this.selectionManager.update();

    const camPos = this.editorCamera.getPosition();

    if (this.editorCoordsEl) {
      this.editorCoordsEl.textContent = `(${camPos.x.toFixed(1)}, ${camPos.y.toFixed(1)}, ${camPos.z.toFixed(1)})`;
    }
    if (this.editorSpeedEl) {
      this.editorSpeedEl.textContent = `${this.editorCamera.getSpeed().toFixed(1)} m/s`;
    }
  }

  // =========================================================================
  // Asset Spawning & Placement
  // =========================================================================

  /**
   * Spawns an asset from the catalog into the 3D scene.
   * If worldPosition is not specified, projects a point 5m in front of camera.
   * Immediately registers as SelectableEntity, attaches BoxHelper and TransformControls,
   * and marks the host chunk as dirty.
   */
  public spawnAsset(assetId: string, worldPosition?: THREE.Vector3): SelectableEntity {
    let spawnPos: THREE.Vector3;

    if (worldPosition) {
      const clampedX = Math.max(0, Math.min(200, worldPosition.x));
      const clampedZ = Math.max(0, Math.min(200, worldPosition.z));
      spawnPos = new THREE.Vector3(clampedX, worldPosition.y, clampedZ);
    } else {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 0.001) {
        forward.set(0, 0, -1);
      } else {
        forward.normalize();
      }

      spawnPos = this.camera.position.clone().add(forward.multiplyScalar(5.0));
      // Ground plane clamp
      spawnPos.y = Math.max(0, spawnPos.y);
      spawnPos.x = Math.max(0.5, Math.min(199.5, spawnPos.x));
      spawnPos.z = Math.max(0.5, Math.min(199.5, spawnPos.z));
    }

    const rootObject = this.assetCatalog.spawnAsset(assetId, spawnPos);
    this.scene.add(rootObject);

    const { chunkId } = getChunkCoords(spawnPos.x, spawnPos.z);
    const { lx, lz } = worldToLocal(spawnPos.x, spawnPos.z);
    const assetDef = this.assetCatalog.getAssetById(assetId);

    const entityId =
      rootObject.userData.id || `${assetId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    rootObject.userData.id = entityId;
    rootObject.userData.chunkId = chunkId;

    const entity: SelectableEntity = {
      id: entityId,
      type: (rootObject.userData.entityType as any) || assetDef?.category || 'prop',
      assetId,
      rootObject,
      chunkId,
      worldPos: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
      localPos: { x: lx, y: spawnPos.y, z: lz },
    };

    this.registerEntity(entity);
    this.selectionManager.select(entity);
    this.markChunkDirty(chunkId);

    return entity;
  }

  // =========================================================================
  // Entity Registration & Spatial Partitioning
  // =========================================================================

  public registerEntity(entity: SelectableEntity): void {
    this.selectionManager.registerSelectable(entity);
    this.invalidateCollisionCache();

    if (!this.chunkEntities.has(entity.chunkId)) {
      this.chunkEntities.set(entity.chunkId, new Set());
    }
    this.chunkEntities.get(entity.chunkId)!.add(entity);
  }

  public unregisterEntity(entity: SelectableEntity): void {
    this.selectionManager.unregisterSelectable(entity.id);
    this.chunkEntities.get(entity.chunkId)?.delete(entity);
    this.invalidateCollisionCache();
  }

  /**
   * Drops the cached wall/obstacle bounding boxes so the player controller
   * picks up scene changes (deleted, moved or spawned editor objects) on the
   * next frame instead of colliding with invisible stale boxes.
   */
  private invalidateCollisionCache(): void {
    this.world?.invalidateWallBoundingBoxesCache();
  }

  public getAllEntities(): SelectableEntity[] {
    return this.selectionManager.getAllSelectables();
  }

  public getEntitiesByChunk(chunkId: string): SelectableEntity[] {
    const set = this.chunkEntities.get(chunkId);
    return set ? Array.from(set) : [];
  }

  // =========================================================================
  // Transformation & Cross-Chunk Boundary Migration
  // =========================================================================

  private handleEntityMoved(entity: SelectableEntity): void {
    const pos = entity.rootObject.position;
    const wx = pos.x;
    const wy = pos.y;
    const wz = pos.z;

    const oldChunkId = entity.chunkId;
    const { chunkId: newChunkId } = getChunkCoords(wx, wz);
    const { lx, lz } = worldToLocal(wx, wz);

    entity.worldPos = { x: wx, y: wy, z: wz };
    entity.localPos = { x: lx, y: wy, z: lz };
    entity.rootObject.userData.chunkId = newChunkId;
    this.invalidateCollisionCache();

    // Mark previous chunk dirty
    this.markChunkDirty(oldChunkId);

    // Cross-chunk boundary migration
    if (oldChunkId !== newChunkId) {
      this.chunkEntities.get(oldChunkId)?.delete(entity);

      if (!this.chunkEntities.has(newChunkId)) {
        this.chunkEntities.set(newChunkId, new Set());
      }
      this.chunkEntities.get(newChunkId)!.add(entity);

      entity.chunkId = newChunkId;
      this.markChunkDirty(newChunkId);
    }
  }

  // =========================================================================
  // Deletion & Deep GPU Disposal
  // =========================================================================

  public deleteSelected(): boolean {
    return this.selectionManager.deleteSelected();
  }

  private handleEntityDeleted(entity: SelectableEntity): void {
    this.chunkEntities.get(entity.chunkId)?.delete(entity);
    this.invalidateCollisionCache();
    this.markChunkDirty(entity.chunkId);
    this.inspector.bindEntity(null);
  }

  // =========================================================================
  // Selection Proxy
  // =========================================================================

  public select(entity: SelectableEntity | null): void {
    this.selectionManager.select(entity);
  }

  public getSelected(): SelectableEntity | null {
    return this.selectionManager.getSelected();
  }

  // =========================================================================
  // Dirty State Management & UI Feedback
  // =========================================================================

  public markChunkDirty(chunkId: string): void {
    this.dirtyChunks.add(chunkId);
    this.changeVersion++;
    this.updateDirtyUI();
    this.scheduleAutoSave();
  }

  /**
   * Debounced autosave: waits until the user stops transforming/deleting objects,
   * then writes every dirty chunk to storage without requiring Ctrl+S.
   */
  private scheduleAutoSave(): void {
    if (this.isDisposed) return;

    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
    }

    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.autoSaveDirtyChunks();
    }, this.AUTO_SAVE_DELAY_MS);
  }

  private async autoSaveDirtyChunks(): Promise<void> {
    if (this.isDisposed || this.dirtyChunks.size === 0) return;
    await this.saveAllDirtyChunks(true);
    if (this.saveAgainAfterCurrent) {
      this.saveAgainAfterCurrent = false;
      this.scheduleAutoSave();
    }
  }

  public isChunkDirty(chunkId: string): boolean {
    return this.dirtyChunks.has(chunkId);
  }

  public getDirtyChunks(): string[] {
    return Array.from(this.dirtyChunks).sort();
  }

  public getDirtyCount(): number {
    return this.dirtyChunks.size;
  }

  public clearDirtyState(): void {
    this.dirtyChunks.clear();
    this.updateDirtyUI();
  }

  private updateDirtyUI(): void {
    const count = this.dirtyChunks.size;

    if (this.dirtyBadgeEl) {
      this.dirtyBadgeEl.textContent = String(count);
      if (count > 0) {
        this.dirtyBadgeEl.classList.add('has-dirty');
      } else {
        this.dirtyBadgeEl.classList.remove('has-dirty');
      }
    }

    if (this.saveBtn) {
      this.saveBtn.title = `Сохранить ${count} измененных чанков (Ctrl+S)`;
    }
  }

  // =========================================================================
  // Persistence: Save & Startup Reload
  // =========================================================================

  /**
   * Saves all modified chunks to storage (Vite connect middleware /api/editor/chunks and localStorage).
   * Generates strict Go-compatible RawChunkData with non-null arrays.
   *
   * @param silent When true (autosave), skips success toasts and avoids clearing
   *               chunks that were modified again while the save was in flight.
   */
  public async saveAllDirtyChunks(silent: boolean = false): Promise<number> {
    if (this.dirtyChunks.size === 0) {
      if (!silent) {
        this.showToast('ℹ️ Нет изменений чанков для сохранения');
      }
      return 0;
    }

    if (this.isSavingChunks) {
      // A second change arrived while saving: persist it after the current write.
      this.saveAgainAfterCurrent = true;
      return 0;
    }

    this.isSavingChunks = true;
    const versionAtStart = this.changeVersion;
    const savedIds = Array.from(this.dirtyChunks);

    try {
      const allSelectables = this.selectionManager.getAllSelectables();
      const serializedMap = serializeEntitiesToChunks(allSelectables);

      const dirtyMap = new Map<string, RawChunkData>();
      for (const chunkId of savedIds) {
        if (serializedMap.has(chunkId)) {
          dirtyMap.set(chunkId, serializedMap.get(chunkId)!);
        } else {
          // Chunk had all objects removed/migrated
          dirtyMap.set(chunkId, createEmptyChunk(chunkId));
        }
      }

      const savedCount = await this.storage.saveAllDirtyChunks(dirtyMap);

      // Only clear the chunks if nothing changed during the async write.
      // Otherwise keep them dirty so the follow-up autosave persists the new state.
      if (this.changeVersion === versionAtStart) {
        for (const id of savedIds) {
          this.dirtyChunks.delete(id);
        }
        this.updateDirtyUI();
      } else {
        this.saveAgainAfterCurrent = true;
      }

      if (!silent) {
        this.showToast('✅ Изменения чанков сохранены на диск!');
      }

      return savedCount;
    } finally {
      this.isSavingChunks = false;
      if (this.saveAgainAfterCurrent) {
        this.saveAgainAfterCurrent = false;
        this.scheduleAutoSave();
      }
    }
  }

  /**
   * Alias for saveAllDirtyChunks.
   */
  public async save(): Promise<number> {
    return this.saveAllDirtyChunks();
  }

  /**
   * Loads chunk data from storage and reconstructs 3D entities in the scene.
   */
  public async loadStoredChunk(chunkId: string): Promise<SelectableEntity[]> {
    const chunkData = await this.storage.loadChunk(chunkId);
    if (!chunkData) {
      return [];
    }
    return this.reconstructEntitiesFromChunk(chunkData);
  }

  /**
   * Loads all stored chunks into the editor scene, populating edited entities.
   */
  public async loadAllStoredChunks(): Promise<number> {
    try {
      const chunkIds = await this.storage.listChunks();
      let loaded = 0;
      for (const chunkId of chunkIds) {
        const entities = await this.loadStoredChunk(chunkId);
        if (entities.length > 0) {
          loaded++;
        }
      }
      return loaded;
    } catch (err) {
      console.warn('[LevelEditor] loadAllStoredChunks error:', err);
      return 0;
    }
  }

  /**
   * Reconstructs 3D scene entities from Go-compatible RawChunkData.
   */
  public reconstructEntitiesFromChunk(chunkData: RawChunkData): SelectableEntity[] {
    const deserialized = deserializeChunkToEntities(chunkData);
    const result: SelectableEntity[] = [];

    for (const d of deserialized) {
      // Check if entity is already registered
      if (this.selectionManager.getSelectable(d.id)) {
        continue;
      }

      const assetId = this.resolveAssetIdForEntity(d);
      const worldPos = new THREE.Vector3(d.worldX, d.worldY, d.worldZ);

      let rootObject: THREE.Object3D;
      try {
        rootObject = this.assetCatalog.spawnAsset(assetId, worldPos);
      } catch {
        // Fallback to crate if unknown
        rootObject = this.assetCatalog.spawnAsset('prop_crate', worldPos);
      }

      rootObject.userData.id = d.id;
      rootObject.userData.chunkId = chunkData.chunk_id;
      rootObject.userData.isSelectable = true;
      this.scene.add(rootObject);

      const entity: SelectableEntity = {
        id: d.id,
        type: d.type as any,
        assetId,
        rootObject,
        chunkId: chunkData.chunk_id,
        worldPos: { x: d.worldX, y: d.worldY, z: d.worldZ },
        localPos: { x: d.localX, y: d.localY, z: d.localZ },
      };

      this.registerEntity(entity);
      result.push(entity);
    }

    return result;
  }

  /**
   * Maps deserialized entity properties to catalog asset ID.
   */
  private resolveAssetIdForEntity(entity: any): string {
    const assetId = entity.assetId || entity.subType || entity.type;

    if (this.assetCatalog.hasAsset(assetId)) {
      return assetId;
    }

    if (entity.type === 'npc') {
      const npcId = entity.npc_id || entity.npcId || assetId;
      if (npcId === 'lao_wang') return 'npc_lao_wang';
      if (npcId === 'chef_chen') return 'npc_chef_chen';
      if (npcId === 'guard_zhang') return 'npc_guard_zhang';
      return 'npc_vendor';
    }

    if (entity.type === 'lantern') {
      return 'structure_lantern_red';
    }

    if (entity.type === 'item') {
      const itemId = entity.item_id || entity.itemId || assetId;
      if (itemId === 'teapot') return 'item_teapot';
      if (itemId === 'jade_amulet') return 'item_jade_amulet';
      if (itemId === 'noodles') return 'item_noodles';
      if (itemId === 'ticket') return 'item_ticket';
      return 'item_teapot';
    }

    if (entity.type === 'building') {
      const bType = entity.subType || entity.buildingType || assetId;
      const stallAssetId = `structure_stall_${bType}`;
      if (this.assetCatalog.hasAsset(stallAssetId)) {
        return stallAssetId;
      }
      if (bType === 'brick_wall') return 'structure_brick_wall';
      if (bType === 'pavilion') return 'structure_pavilion';
      return 'structure_stall_general';
    }

    if (entity.type === 'sign') {
      return 'structure_brick_wall';
    }

    return 'prop_crate';
  }

  // =========================================================================
  // Notification Toast Helper
  // =========================================================================

  public showToast(message: string, durationMs: number = 3000): void {
    if (this.hud && typeof this.hud.showToast === 'function') {
      this.hud.showToast(message, durationMs);
      return;
    }

    if (typeof document !== 'undefined') {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }

      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      container.appendChild(toast);

      setTimeout(() => {
        if (toast.parentElement) {
          toast.parentElement.removeChild(toast);
        }
      }, durationMs);
    }
  }

  // =========================================================================
  // Subsystem Accessors
  // =========================================================================

  public getStateManager(): EditorStateManager {
    return this.stateManager;
  }

  public getEditorCamera(): EditorCamera {
    return this.editorCamera;
  }

  public getSelectionManager(): EditorSelectionManager {
    return this.selectionManager;
  }

  public getAssetCatalog(): AssetCatalog {
    return this.assetCatalog;
  }

  public getAssetCatalogUI(): AssetCatalogUI {
    return this.catalogUI;
  }

  public getPropertyInspector(): PropertyInspector {
    return this.inspector;
  }

  public getStorage(): IChunkStorage {
    return this.storage;
  }

  public getGhostBeacon(): PlayerGhostBeacon | null {
    return this.ghostBeacon;
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  // =========================================================================
  // Lifecycle Disposal
  // =========================================================================

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    if (this.modeUnsubscribe) {
      this.modeUnsubscribe();
      this.modeUnsubscribe = null;
    }

    if (this.keydownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    this.selectionManager.dispose();
    this.editorCamera.dispose();
    this.catalogUI.unmount();
    this.inspector.unmount();

    if (this.ghostBeacon) {
      this.ghostBeacon.remove();
    }

    this.dirtyChunks.clear();
    this.chunkEntities.clear();
  }
}
