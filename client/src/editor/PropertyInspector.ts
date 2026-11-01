import * as THREE from 'three';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface SelectableEntityLike {
  id: string;
  type?: string;
  assetId?: string;
  rootObject: THREE.Object3D;
  chunkId?: string;
}

export interface PropertyInspectorOptions {
  parent?: HTMLElement;
  onGizmoModeChange?: (mode: GizmoMode) => void;
  onDeleteRequested?: (entity: any) => void;
  onTransformChanged?: (object: THREE.Object3D, property: 'position' | 'rotation' | 'scale') => void;
}

/**
 * PropertyInspector: Collapsible right panel for real-time inspection and manipulation
 * of selected object transforms (position, rotation, scale), gizmo modes, and deletion.
 */
export class PropertyInspector {
  private readonly rootEl: HTMLElement;
  private currentEntity: any | null = null;
  private currentObject: THREE.Object3D | null = null;
  private activeGizmoMode: GizmoMode = 'translate';
  private collapsed: boolean = false;
  private isMounted: boolean = false;

  // Listeners
  private readonly gizmoModeListeners: Set<(mode: GizmoMode) => void> = new Set();
  private readonly deleteListeners: Set<(entity: any) => void> = new Set();
  private readonly transformListeners: Set<(obj: THREE.Object3D, prop: 'position' | 'rotation' | 'scale') => void> = new Set();

  // DOM Elements
  private collapseBtnEl!: HTMLButtonElement;
  private contentContainerEl!: HTMLElement;
  private emptyNoticeEl!: HTMLElement;
  private detailsContainerEl!: HTMLElement;

  // Metadata labels
  private entityIdEl!: HTMLElement;
  private assetNameEl!: HTMLElement;
  private categoryBadgeEl!: HTMLElement;

  // Input Controls
  private posXInput!: HTMLInputElement;
  private posYInput!: HTMLInputElement;
  private posZInput!: HTMLInputElement;
  private rotYInput!: HTMLInputElement;
  private scaleInput!: HTMLInputElement;
  private scaleSlider!: HTMLInputElement;

  // Gizmo Mode Buttons
  private translateBtn!: HTMLButtonElement;
  private rotateBtn!: HTMLButtonElement;
  private scaleBtn!: HTMLButtonElement;

  // Delete Button
  private deleteBtn!: HTMLButtonElement;

  constructor(options?: PropertyInspectorOptions) {
    if (options?.onGizmoModeChange) {
      this.gizmoModeListeners.add(options.onGizmoModeChange);
    }
    if (options?.onDeleteRequested) {
      this.deleteListeners.add(options.onDeleteRequested);
    }
    if (options?.onTransformChanged) {
      this.transformListeners.add(options.onTransformChanged);
    }

    this.rootEl = this.buildDOM();
    this.injectStyles();

    if (options?.parent) {
      this.mount(options.parent);
    }
  }

  /**
   * Mounts the inspector panel to a parent DOM node or document.body.
   */
  public mount(parent?: HTMLElement): void {
    const target = parent || document.body;
    if (!target) return;

    if (this.rootEl.parentElement !== target) {
      target.appendChild(this.rootEl);
    }
    this.isMounted = true;
  }

  /**
   * Unmounts the inspector panel from DOM.
   */
  public unmount(): void {
    if (this.rootEl.parentElement) {
      this.rootEl.parentElement.removeChild(this.rootEl);
    }
    this.isMounted = false;
  }

  public isAttached(): boolean {
    return this.isMounted;
  }

  /**
   * Shows or hides the entire UI panel.
   */
  public setVisible(visible: boolean): void {
    this.rootEl.style.display = visible ? 'flex' : 'none';
  }

  /**
   * Toggles collapsible state of the right panel.
   */
  public toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    if (this.collapsed) {
      this.rootEl.classList.add('collapsed');
      this.collapseBtnEl.textContent = '◀';
      this.collapseBtnEl.title = 'Развернуть инспектор';
    } else {
      this.rootEl.classList.remove('collapsed');
      this.collapseBtnEl.textContent = '▶';
      this.collapseBtnEl.title = 'Свернуть инспектор';
    }
  }

  public isCollapsed(): boolean {
    return this.collapsed;
  }

  /**
   * Binds an entity (SelectableEntity or THREE.Object3D) to the inspector.
   * If null, displays the "no selection" placeholder.
   */
  public bindEntity(entity: any | null): void {
    this.currentEntity = entity;

    if (!entity) {
      this.currentObject = null;
      this.emptyNoticeEl.style.display = 'block';
      this.detailsContainerEl.style.display = 'none';
      return;
    }

    // Resolve THREE.Object3D
    let obj: THREE.Object3D | null = null;
    if (entity.rootObject instanceof THREE.Object3D) {
      obj = entity.rootObject;
    } else if (entity instanceof THREE.Object3D) {
      obj = entity;
    } else if (entity.rootObject) {
      obj = entity.rootObject;
    }

    this.currentObject = obj;

    // Resolve metadata
    const id = entity.id || obj?.userData?.id || obj?.name || 'unknown';
    const name = entity.assetId || obj?.userData?.name || obj?.userData?.assetId || obj?.name || 'Unnamed Object';
    const category = entity.type || obj?.userData?.entityType || 'prop';

    this.entityIdEl.textContent = id;
    this.assetNameEl.textContent = name;
    this.categoryBadgeEl.textContent = this.formatCategory(category);
    this.categoryBadgeEl.className = `inspector-badge badge-${category}`;

    this.emptyNoticeEl.style.display = 'none';
    this.detailsContainerEl.style.display = 'flex';

    this.updateFromEntity();
  }

  /**
   * Returns currently bound entity.
   */
  public getBoundEntity(): any | null {
    return this.currentEntity;
  }

  /**
   * Synchronizes input fields from the current entity's transform in real-time.
   */
  public updateFromEntity(): void {
    if (!this.currentObject) return;

    const pos = this.currentObject.position;
    const rot = this.currentObject.rotation;
    const scale = this.currentObject.scale;

    // Position
    if (document.activeElement !== this.posXInput) {
      this.posXInput.value = pos.x.toFixed(2);
    }
    if (document.activeElement !== this.posYInput) {
      this.posYInput.value = pos.y.toFixed(2);
    }
    if (document.activeElement !== this.posZInput) {
      this.posZInput.value = pos.z.toFixed(2);
    }

    // Rotation Y (displayed in degrees)
    if (document.activeElement !== this.rotYInput) {
      const deg = (rot.y * 180) / Math.PI;
      this.rotYInput.value = deg.toFixed(1);
    }

    // Scale (average/uniform scale)
    if (document.activeElement !== this.scaleInput && document.activeElement !== this.scaleSlider) {
      const avgScale = (scale.x + scale.y + scale.z) / 3;
      this.scaleInput.value = avgScale.toFixed(2);
      this.scaleSlider.value = avgScale.toFixed(2);
    }
  }

  /**
   * Sets active gizmo mode ('translate' | 'rotate' | 'scale').
   */
  public setGizmoMode(mode: GizmoMode): void {
    this.activeGizmoMode = mode;

    this.translateBtn.classList.toggle('active', mode === 'translate');
    this.rotateBtn.classList.toggle('active', mode === 'rotate');
    this.scaleBtn.classList.toggle('active', mode === 'scale');

    for (const listener of this.gizmoModeListeners) {
      try {
        listener(mode);
      } catch (err) {
        console.error('[PropertyInspector] Error in gizmo mode listener:', err);
      }
    }
  }

  public getGizmoMode(): GizmoMode {
    return this.activeGizmoMode;
  }

  /**
   * Registers callback for gizmo mode change.
   */
  public onGizmoModeChange(callback: (mode: GizmoMode) => void): () => void {
    this.gizmoModeListeners.add(callback);
    return () => this.gizmoModeListeners.delete(callback);
  }

  /**
   * Registers callback for delete request.
   */
  public onDeleteRequested(callback: (entity: any) => void): () => void {
    this.deleteListeners.add(callback);
    return () => this.deleteListeners.delete(callback);
  }

  /**
   * Registers callback for transform modifications.
   */
  public onTransformChanged(callback: (obj: THREE.Object3D, prop: 'position' | 'rotation' | 'scale') => void): () => void {
    this.transformListeners.add(callback);
    return () => this.transformListeners.delete(callback);
  }

  /**
   * Returns root container element.
   */
  public getElement(): HTMLElement {
    return this.rootEl;
  }

  // ==========================================================================
  // DOM Construction
  // ==========================================================================

  private buildDOM(): HTMLElement {
    const root = document.createElement('aside');
    root.id = 'property-inspector-panel';
    root.className = 'property-inspector-panel';

    // 1. Header
    const header = document.createElement('div');
    header.className = 'inspector-header';

    const title = document.createElement('div');
    title.className = 'inspector-title';
    title.textContent = '⚙️ Свойства объекта';

    this.collapseBtnEl = document.createElement('button');
    this.collapseBtnEl.type = 'button';
    this.collapseBtnEl.className = 'inspector-collapse-btn';
    this.collapseBtnEl.textContent = '▶';
    this.collapseBtnEl.title = 'Свернуть инспектор';
    this.collapseBtnEl.addEventListener('click', () => this.toggleCollapse());

    header.appendChild(title);
    header.appendChild(this.collapseBtnEl);
    root.appendChild(header);

    // 2. Content container
    this.contentContainerEl = document.createElement('div');
    this.contentContainerEl.className = 'inspector-content';

    // Gizmo Mode Switcher toolbar
    const gizmoToolbar = document.createElement('div');
    gizmoToolbar.className = 'inspector-gizmo-toolbar';

    this.translateBtn = this.createButton('Перемещение (T)', 'translate', () => this.setGizmoMode('translate'));
    this.translateBtn.classList.add('active');
    this.rotateBtn = this.createButton('Вращение (R)', 'rotate', () => this.setGizmoMode('rotate'));
    this.scaleBtn = this.createButton('Масштаб (S)', 'scale', () => this.setGizmoMode('scale'));

    gizmoToolbar.appendChild(this.translateBtn);
    gizmoToolbar.appendChild(this.rotateBtn);
    gizmoToolbar.appendChild(this.scaleBtn);
    this.contentContainerEl.appendChild(gizmoToolbar);

    // Empty state placeholder
    this.emptyNoticeEl = document.createElement('div');
    this.emptyNoticeEl.className = 'inspector-empty-notice';
    this.emptyNoticeEl.innerHTML = `
      <div class="empty-icon">🎯</div>
      <div class="empty-text">Объект не выбран</div>
      <div class="empty-subtext">Кликните по объекту в сцене для редактирования</div>
    `;
    this.contentContainerEl.appendChild(this.emptyNoticeEl);

    // Details container (shown when entity bound)
    this.detailsContainerEl = document.createElement('div');
    this.detailsContainerEl.className = 'inspector-details';
    this.detailsContainerEl.style.display = 'none';

    // Metadata card
    const metaCard = document.createElement('div');
    metaCard.className = 'inspector-meta-card';

    const headerLine = document.createElement('div');
    headerLine.className = 'inspector-meta-header';

    this.assetNameEl = document.createElement('div');
    this.assetNameEl.className = 'inspector-asset-name';
    this.assetNameEl.textContent = 'Asset Name';

    this.categoryBadgeEl = document.createElement('span');
    this.categoryBadgeEl.className = 'inspector-badge';
    this.categoryBadgeEl.textContent = 'PROP';

    headerLine.appendChild(this.assetNameEl);
    headerLine.appendChild(this.categoryBadgeEl);
    metaCard.appendChild(headerLine);

    const idLine = document.createElement('div');
    idLine.className = 'inspector-entity-id-row';
    idLine.innerHTML = '<span class="label">ID:</span> ';
    this.entityIdEl = document.createElement('span');
    this.entityIdEl.className = 'inspector-entity-id';
    this.entityIdEl.textContent = '-';
    idLine.appendChild(this.entityIdEl);
    metaCard.appendChild(idLine);

    this.detailsContainerEl.appendChild(metaCard);

    // Transform Section: Position
    const posSection = document.createElement('div');
    posSection.className = 'inspector-section';
    const posTitle = document.createElement('div');
    posTitle.className = 'section-title';
    posTitle.textContent = 'Позиция (X, Y, Z)';
    posSection.appendChild(posTitle);

    const posRow = document.createElement('div');
    posRow.className = 'inspector-axis-row';

    this.posXInput = this.createNumberInput('X', (val) => {
      if (this.currentObject) {
        this.currentObject.position.x = val;
        this.notifyTransformChange('position');
      }
    });
    this.posYInput = this.createNumberInput('Y', (val) => {
      if (this.currentObject) {
        this.currentObject.position.y = val;
        this.notifyTransformChange('position');
      }
    });
    this.posZInput = this.createNumberInput('Z', (val) => {
      if (this.currentObject) {
        this.currentObject.position.z = val;
        this.notifyTransformChange('position');
      }
    });

    posRow.appendChild(this.wrapInputWithLabel('X', this.posXInput));
    posRow.appendChild(this.wrapInputWithLabel('Y', this.posYInput));
    posRow.appendChild(this.wrapInputWithLabel('Z', this.posZInput));
    posSection.appendChild(posRow);
    this.detailsContainerEl.appendChild(posSection);

    // Transform Section: Rotation
    const rotSection = document.createElement('div');
    rotSection.className = 'inspector-section';
    const rotTitle = document.createElement('div');
    rotTitle.className = 'section-title';
    rotTitle.textContent = 'Поворот Y (Yaw, градусы)';
    rotSection.appendChild(rotTitle);

    const rotRow = document.createElement('div');
    rotRow.className = 'inspector-axis-row single-axis';

    this.rotYInput = this.createNumberInput('RotY', (val) => {
      if (this.currentObject) {
        this.currentObject.rotation.y = (val * Math.PI) / 180;
        this.notifyTransformChange('rotation');
      }
    }, 1.0);

    rotRow.appendChild(this.wrapInputWithLabel('Y°', this.rotYInput));
    rotSection.appendChild(rotRow);
    this.detailsContainerEl.appendChild(rotSection);

    // Transform Section: Scale
    const scaleSection = document.createElement('div');
    scaleSection.className = 'inspector-section';
    const scaleTitle = document.createElement('div');
    scaleTitle.className = 'section-title';
    scaleTitle.textContent = 'Масштаб (Scale)';
    scaleSection.appendChild(scaleTitle);

    const scaleRow = document.createElement('div');
    scaleRow.className = 'inspector-scale-row';

    this.scaleInput = this.createNumberInput('Scale', (val) => {
      if (this.currentObject && val > 0.001) {
        this.currentObject.scale.set(val, val, val);
        this.scaleSlider.value = String(val);
        this.notifyTransformChange('scale');
      }
    }, 0.1, 0.05);

    this.scaleSlider = document.createElement('input');
    this.scaleSlider.type = 'range';
    this.scaleSlider.className = 'inspector-slider';
    this.scaleSlider.min = '0.1';
    this.scaleSlider.max = '5.0';
    this.scaleSlider.step = '0.05';
    this.scaleSlider.value = '1.0';
    this.scaleSlider.addEventListener('input', () => {
      const val = parseFloat(this.scaleSlider.value);
      if (this.currentObject && !isNaN(val)) {
        this.currentObject.scale.set(val, val, val);
        this.scaleInput.value = val.toFixed(2);
        this.notifyTransformChange('scale');
      }
    });

    scaleRow.appendChild(this.scaleSlider);
    scaleRow.appendChild(this.scaleInput);
    scaleSection.appendChild(scaleRow);
    this.detailsContainerEl.appendChild(scaleSection);

    // Delete Button
    this.deleteBtn = document.createElement('button');
    this.deleteBtn.type = 'button';
    this.deleteBtn.className = 'inspector-delete-btn';
    this.deleteBtn.innerHTML = '🗑️ Удалить объект';
    this.deleteBtn.addEventListener('click', () => {
      if (this.currentEntity) {
        for (const listener of this.deleteListeners) {
          try {
            listener(this.currentEntity);
          } catch (err) {
            console.error('[PropertyInspector] Error in delete listener:', err);
          }
        }
      }
    });
    this.detailsContainerEl.appendChild(this.deleteBtn);

    this.contentContainerEl.appendChild(this.detailsContainerEl);
    root.appendChild(this.contentContainerEl);

    return root;
  }

  private createButton(text: string, _className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inspector-gizmo-btn';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private createNumberInput(
    _axis: string,
    onValueChange: (val: number) => void,
    step: number = 0.1,
    min?: number
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'inspector-number-input';
    input.step = String(step);
    if (min !== undefined) {
      input.min = String(min);
    }
    input.value = '0.0';

    const commitChange = () => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) {
        onValueChange(val);
      }
    };

    input.addEventListener('change', commitChange);
    input.addEventListener('input', commitChange);

    return input;
  }

  private wrapInputWithLabel(label: string, input: HTMLInputElement): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-input-wrapper';

    const lbl = document.createElement('span');
    lbl.className = 'inspector-input-label';
    lbl.textContent = label;

    wrapper.appendChild(lbl);
    wrapper.appendChild(input);
    return wrapper;
  }

  private notifyTransformChange(prop: 'position' | 'rotation' | 'scale'): void {
    if (!this.currentObject) return;
    this.currentObject.updateMatrixWorld(true);

    for (const listener of this.transformListeners) {
      try {
        listener(this.currentObject, prop);
      } catch (err) {
        console.error('[PropertyInspector] Error in transform listener:', err);
      }
    }
  }

  private formatCategory(category: string): string {
    switch (category) {
      case 'props':
      case 'prop':
        return 'ПРОПС';
      case 'npcs':
      case 'npc':
        return 'NPC';
      case 'structures':
      case 'building':
      case 'structure':
        return 'ПОСТРОЙКА';
      case 'items':
      case 'item':
        return 'ПРЕДМЕТ';
      case 'lantern':
        return 'ФОНАРЬ';
      default:
        return category.toUpperCase();
    }
  }

  private injectStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById('property-inspector-styles')) return;

    const style = document.createElement('style');
    style.id = 'property-inspector-styles';
    style.textContent = `
      .property-inspector-panel {
        position: fixed;
        top: 60px;
        right: 16px;
        width: 320px;
        max-height: calc(100vh - 80px);
        background: rgba(13, 9, 23, 0.92);
        border: 1px solid rgba(0, 243, 255, 0.35);
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.65), 0 0 12px rgba(0, 243, 255, 0.15);
        display: flex;
        flex-direction: column;
        color: #f0f6fc;
        font-family: 'Inter', system-ui, sans-serif;
        z-index: 80;
        backdrop-filter: blur(8px);
        transition: width 0.25s ease, transform 0.25s ease;
        user-select: none;
      }

      .property-inspector-panel.collapsed {
        width: 44px;
        overflow: hidden;
      }

      .property-inspector-panel.collapsed .inspector-content {
        display: none;
      }

      .property-inspector-panel.collapsed .inspector-title {
        display: none;
      }

      .inspector-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(22, 14, 38, 0.95);
        border-bottom: 1px solid rgba(0, 243, 255, 0.2);
        border-top-left-radius: 7px;
        border-top-right-radius: 7px;
      }

      .inspector-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.5px;
        color: #00f3ff;
        text-shadow: 0 0 8px rgba(0, 243, 255, 0.4);
      }

      .inspector-collapse-btn {
        background: transparent;
        border: 1px solid rgba(0, 243, 255, 0.3);
        color: #00f3ff;
        border-radius: 4px;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 12px;
        transition: background 0.15s, border-color 0.15s;
      }

      .inspector-collapse-btn:hover {
        background: rgba(0, 243, 255, 0.15);
        border-color: #00f3ff;
      }

      .inspector-content {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        padding: 12px;
        gap: 12px;
      }

      .inspector-gizmo-toolbar {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }

      .inspector-gizmo-btn {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #9aa8be;
        padding: 7px 4px;
        font-size: 10px;
        font-weight: 600;
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        transition: all 0.15s ease;
      }

      .inspector-gizmo-btn:hover {
        background: rgba(0, 243, 255, 0.08);
        color: #f0f6fc;
      }

      .inspector-gizmo-btn.active {
        background: rgba(0, 243, 255, 0.2);
        border-color: #00f3ff;
        color: #00f3ff;
        box-shadow: 0 0 8px rgba(0, 243, 255, 0.3);
      }

      .inspector-empty-notice {
        padding: 28px 12px;
        text-align: center;
        background: rgba(22, 16, 38, 0.5);
        border: 1px dashed rgba(255, 255, 255, 0.15);
        border-radius: 6px;
      }

      .inspector-empty-notice .empty-icon {
        font-size: 24px;
        margin-bottom: 8px;
      }

      .inspector-empty-notice .empty-text {
        font-size: 13px;
        font-weight: 600;
        color: #f0f6fc;
        margin-bottom: 4px;
      }

      .inspector-empty-notice .empty-subtext {
        font-size: 11px;
        color: #667284;
      }

      .inspector-details {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .inspector-meta-card {
        background: rgba(22, 16, 38, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .inspector-meta-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .inspector-asset-name {
        font-size: 13px;
        font-weight: 700;
        color: #ffffff;
      }

      .inspector-badge {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 700;
        text-transform: uppercase;
        background: rgba(0, 243, 255, 0.18);
        color: #00f3ff;
        border: 1px solid rgba(0, 243, 255, 0.4);
      }

      .inspector-badge.badge-prop, .inspector-badge.badge-props {
        background: rgba(0, 255, 136, 0.18);
        color: #00ff88;
        border-color: rgba(0, 255, 136, 0.4);
      }
      .inspector-badge.badge-npc, .inspector-badge.badge-npcs {
        background: rgba(192, 132, 252, 0.18);
        color: #c084fc;
        border-color: rgba(192, 132, 252, 0.4);
      }
      .inspector-badge.badge-structure, .inspector-badge.badge-structures, .inspector-badge.badge-building {
        background: rgba(255, 170, 0, 0.18);
        color: #ffaa00;
        border-color: rgba(255, 170, 0, 0.4);
      }
      .inspector-badge.badge-item, .inspector-badge.badge-items {
        background: rgba(0, 243, 255, 0.18);
        color: #00f3ff;
        border-color: rgba(0, 243, 255, 0.4);
      }

      .inspector-entity-id-row {
        font-size: 11px;
        color: #9aa8be;
        font-family: monospace;
      }

      .inspector-entity-id {
        color: #00f3ff;
      }

      .inspector-section {
        background: rgba(22, 16, 38, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .section-title {
        font-size: 11px;
        font-weight: 600;
        color: #9aa8be;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .inspector-axis-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }

      .inspector-axis-row.single-axis {
        grid-template-columns: 1fr;
      }

      .inspector-input-wrapper {
        display: flex;
        align-items: center;
        background: rgba(10, 6, 18, 0.85);
        border: 1px solid rgba(0, 243, 255, 0.25);
        border-radius: 4px;
        padding: 0 6px;
      }

      .inspector-input-label {
        font-size: 11px;
        font-weight: 700;
        color: #00f3ff;
        margin-right: 4px;
        min-width: 14px;
      }

      .inspector-number-input {
        width: 100%;
        background: transparent;
        border: none;
        color: #ffffff;
        font-family: monospace;
        font-size: 12px;
        padding: 6px 0;
        outline: none;
      }

      .inspector-scale-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .inspector-slider {
        flex: 1;
        accent-color: #00f3ff;
        cursor: pointer;
      }

      .inspector-delete-btn {
        background: linear-gradient(135deg, rgba(255, 51, 68, 0.18), rgba(200, 20, 40, 0.28));
        border: 1px solid rgba(255, 51, 68, 0.5);
        color: #ff3344;
        padding: 9px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.15s ease;
        text-align: center;
        margin-top: 4px;
      }

      .inspector-delete-btn:hover {
        background: linear-gradient(135deg, rgba(255, 51, 68, 0.4), rgba(200, 20, 40, 0.5));
        border-color: #ff3344;
        color: #ffffff;
        box-shadow: 0 0 12px rgba(255, 51, 68, 0.45);
      }
    `;

    if (document.head) {
      document.head.appendChild(style);
    }
  }
}
