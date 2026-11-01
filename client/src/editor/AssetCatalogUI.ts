import { AssetCatalog, AssetCategory, AssetDefinition } from './AssetCatalog';

export interface AssetCatalogUIOptions {
  onAssetSpawnRequested?: (assetId: string) => void;
  parent?: HTMLElement;
}

/**
 * AssetCatalogUI: Collapsible left panel providing categorized asset browsing,
 * search filtering, and scene instantiation triggers.
 */
export class AssetCatalogUI {
  private readonly catalog: AssetCatalog;
  private readonly rootEl: HTMLElement;
  private readonly spawnCallbacks: Set<(assetId: string) => void> = new Set();

  private activeTab: AssetCategory | 'all' = 'props';
  private searchQuery: string = '';
  private collapsed: boolean = false;
  private isMounted: boolean = false;

  // DOM Elements
  private headerTitleEl!: HTMLElement;
  private collapseBtnEl!: HTMLButtonElement;
  private searchInputEl!: HTMLInputElement;
  private tabContainerEl!: HTMLElement;
  private itemsContainerEl!: HTMLElement;
  private bodyContainerEl!: HTMLElement;

  constructor(catalog: AssetCatalog, options?: AssetCatalogUIOptions) {
    this.catalog = catalog;

    if (options?.onAssetSpawnRequested) {
      this.spawnCallbacks.add(options.onAssetSpawnRequested);
    }

    this.rootEl = this.buildDOM();
    this.injectStyles();

    if (options?.parent) {
      this.mount(options.parent);
    }
  }

  /**
   * Mounts the panel into the DOM.
   */
  public mount(parent?: HTMLElement): void {
    const target = parent || document.body;
    if (!target) return;

    if (this.rootEl.parentElement !== target) {
      target.appendChild(this.rootEl);
    }
    this.isMounted = true;
    this.renderItems();
  }

  /**
   * Unmounts the panel from the DOM.
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
   * Toggles collapsible state of the left panel.
   */
  public toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    if (this.collapsed) {
      this.rootEl.classList.add('collapsed');
      this.collapseBtnEl.textContent = '▶';
      this.collapseBtnEl.title = 'Развернуть каталог';
    } else {
      this.rootEl.classList.remove('collapsed');
      this.collapseBtnEl.textContent = '◀';
      this.collapseBtnEl.title = 'Свернуть каталог';
    }
  }

  public isCollapsed(): boolean {
    return this.collapsed;
  }

  /**
   * Changes the active category tab ('props', 'npcs', 'structures', 'items', 'all').
   */
  public setActiveTab(tab: AssetCategory | 'all'): void {
    this.activeTab = tab;
    this.updateTabButtons();
    this.renderItems();
  }

  public getActiveTab(): AssetCategory | 'all' {
    return this.activeTab;
  }

  /**
   * Updates the search filter query.
   */
  public setSearchQuery(query: string): void {
    this.searchQuery = query.trim().toLowerCase();
    if (this.searchInputEl && this.searchInputEl.value !== query) {
      this.searchInputEl.value = query;
    }
    this.renderItems();
  }

  /**
   * Registers a listener for asset spawn requests.
   */
  public onAssetSpawn(callback: (assetId: string) => void): () => void {
    this.spawnCallbacks.add(callback);
    return () => {
      this.spawnCallbacks.delete(callback);
    };
  }

  /**
   * Triggers spawn request for a given assetId.
   */
  public onAssetSpawnRequested(assetId: string): void {
    for (const cb of this.spawnCallbacks) {
      try {
        cb(assetId);
      } catch (err) {
        console.error('[AssetCatalogUI] Error in spawn callback:', err);
      }
    }
  }

  /**
   * Returns root container element.
   */
  public getElement(): HTMLElement {
    return this.rootEl;
  }

  /**
   * Re-renders catalog items based on active tab and search query.
   */
  public refresh(): void {
    this.renderItems();
  }

  // ==========================================================================
  // DOM Construction
  // ==========================================================================

  private buildDOM(): HTMLElement {
    const root = document.createElement('aside');
    root.id = 'asset-catalog-panel';
    root.className = 'asset-catalog-panel';

    // 1. Header with title and collapse toggle
    const header = document.createElement('div');
    header.className = 'catalog-header';

    this.headerTitleEl = document.createElement('div');
    this.headerTitleEl.className = 'catalog-title';
    this.headerTitleEl.textContent = '📦 Каталог ассетов';

    this.collapseBtnEl = document.createElement('button');
    this.collapseBtnEl.className = 'catalog-collapse-btn';
    this.collapseBtnEl.type = 'button';
    this.collapseBtnEl.textContent = '◀';
    this.collapseBtnEl.title = 'Свернуть каталог';
    this.collapseBtnEl.addEventListener('click', () => this.toggleCollapse());

    header.appendChild(this.headerTitleEl);
    header.appendChild(this.collapseBtnEl);
    root.appendChild(header);

    // Body container (hidden when collapsed)
    this.bodyContainerEl = document.createElement('div');
    this.bodyContainerEl.className = 'catalog-body';

    // 2. Search Box
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'catalog-search-wrapper';

    this.searchInputEl = document.createElement('input');
    this.searchInputEl.type = 'text';
    this.searchInputEl.className = 'catalog-search-input';
    this.searchInputEl.placeholder = '🔍 Поиск ассетов...';
    this.searchInputEl.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.setSearchQuery(target.value);
    });
    searchWrapper.appendChild(this.searchInputEl);
    this.bodyContainerEl.appendChild(searchWrapper);

    // 3. Category Tabs
    this.tabContainerEl = document.createElement('nav');
    this.tabContainerEl.className = 'catalog-tabs';

    const tabs: Array<{ id: AssetCategory; label: string }> = [
      { id: 'props', label: 'Пропсы' },
      { id: 'npcs', label: 'NPC' },
      { id: 'structures', label: 'Постройки' },
      { id: 'items', label: 'Предметы' },
    ];

    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `catalog-tab-btn ${t.id === this.activeTab ? 'active' : ''}`;
      btn.dataset.category = t.id;
      btn.textContent = t.label;
      btn.addEventListener('click', () => this.setActiveTab(t.id));
      this.tabContainerEl.appendChild(btn);
    }
    this.bodyContainerEl.appendChild(this.tabContainerEl);

    // 4. Items List
    this.itemsContainerEl = document.createElement('div');
    this.itemsContainerEl.className = 'catalog-items-container';
    this.bodyContainerEl.appendChild(this.itemsContainerEl);

    root.appendChild(this.bodyContainerEl);

    return root;
  }

  private updateTabButtons(): void {
    if (!this.tabContainerEl) return;
    const buttons = this.tabContainerEl.querySelectorAll<HTMLButtonElement>('.catalog-tab-btn');
    buttons.forEach((btn) => {
      const cat = btn.dataset.category;
      if (cat === this.activeTab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  private renderItems(): void {
    if (!this.itemsContainerEl) return;
    this.itemsContainerEl.innerHTML = '';

    let assets: AssetDefinition[] = [];
    if (this.activeTab === 'all') {
      assets = this.catalog.getAssets();
    } else {
      assets = this.catalog.getAssetsByCategory(this.activeTab);
    }

    if (this.searchQuery) {
      assets = assets.filter(
        (a) =>
          a.name.toLowerCase().includes(this.searchQuery) ||
          a.id.toLowerCase().includes(this.searchQuery) ||
          a.category.toLowerCase().includes(this.searchQuery)
      );
    }

    if (assets.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'catalog-empty-notice';
      emptyNotice.textContent = 'Нет ассетов, соответствующих запросу';
      this.itemsContainerEl.appendChild(emptyNotice);
      return;
    }

    for (const asset of assets) {
      const card = this.createAssetCard(asset);
      this.itemsContainerEl.appendChild(card);
    }
  }

  private createAssetCard(asset: AssetDefinition): HTMLElement {
    const card = document.createElement('div');
    card.className = 'catalog-item-card';
    card.dataset.assetId = asset.id;

    // Header row: Name + Category badge
    const headerRow = document.createElement('div');
    headerRow.className = 'catalog-item-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'catalog-item-name';
    nameEl.textContent = asset.name;
    headerRow.appendChild(nameEl);

    const badge = document.createElement('span');
    badge.className = `catalog-category-badge badge-${asset.category}`;
    badge.textContent = this.getCategoryBadgeText(asset.category);
    headerRow.appendChild(badge);

    card.appendChild(headerRow);

    // Meta row (Model path or procedural tag)
    const metaRow = document.createElement('div');
    metaRow.className = 'catalog-item-meta';
    metaRow.textContent = asset.modelPath ? `Модель: ${asset.modelPath}` : 'Генерация: Procedural';
    card.appendChild(metaRow);

    // Action button: "Добавить в сцену"
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'catalog-add-btn';
    addBtn.textContent = 'Добавить в сцену';
    addBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      this.onAssetSpawnRequested(asset.id);
    });
    card.appendChild(addBtn);

    return card;
  }

  private getCategoryBadgeText(cat: AssetCategory): string {
    switch (cat) {
      case 'props':
        return 'Пропс';
      case 'npcs':
        return 'NPC';
      case 'structures':
        return 'Постройка';
      case 'items':
        return 'Предмет';
      default:
        return cat;
    }
  }

  private injectStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById('asset-catalog-ui-styles')) return;

    const style = document.createElement('style');
    style.id = 'asset-catalog-ui-styles';
    style.textContent = `
      .asset-catalog-panel {
        position: fixed;
        top: 60px;
        left: 16px;
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

      .asset-catalog-panel.collapsed {
        width: 44px;
        overflow: hidden;
      }

      .asset-catalog-panel.collapsed .catalog-body {
        display: none;
      }

      .asset-catalog-panel.collapsed .catalog-title {
        display: none;
      }

      .catalog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(22, 14, 38, 0.95);
        border-bottom: 1px solid rgba(0, 243, 255, 0.2);
        border-top-left-radius: 7px;
        border-top-right-radius: 7px;
      }

      .catalog-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.5px;
        color: #00f3ff;
        text-shadow: 0 0 8px rgba(0, 243, 255, 0.4);
      }

      .catalog-collapse-btn {
        background: transparent;
        border: 1px solid rgba(0, 243, 255, 0.3);
        color: #00f3ff;
        border-radius: 4px;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 12px;
        transition: background 0.15s, border-color 0.15s;
      }

      .catalog-collapse-btn:hover {
        background: rgba(0, 243, 255, 0.15);
        border-color: #00f3ff;
      }

      .catalog-body {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex: 1;
      }

      .catalog-search-wrapper {
        padding: 10px 12px 6px 12px;
      }

      .catalog-search-input {
        width: 100%;
        background: rgba(26, 18, 44, 0.85);
        border: 1px solid rgba(0, 243, 255, 0.25);
        border-radius: 4px;
        padding: 7px 10px;
        color: #ffffff;
        font-size: 12px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      .catalog-search-input:focus {
        border-color: #00f3ff;
        box-shadow: 0 0 8px rgba(0, 243, 255, 0.3);
      }

      .catalog-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 4px;
        padding: 6px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .catalog-tab-btn {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #9aa8be;
        padding: 6px 4px;
        font-size: 11px;
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        transition: all 0.15s ease;
      }

      .catalog-tab-btn:hover {
        background: rgba(0, 243, 255, 0.08);
        color: #f0f6fc;
      }

      .catalog-tab-btn.active {
        background: rgba(0, 243, 255, 0.2);
        border-color: #00f3ff;
        color: #00f3ff;
        font-weight: 600;
        box-shadow: 0 0 6px rgba(0, 243, 255, 0.3);
      }

      .catalog-items-container {
        padding: 8px 12px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: calc(100vh - 240px);
      }

      .catalog-item-card {
        background: rgba(22, 16, 38, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        padding: 9px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        transition: border-color 0.15s, background 0.15s;
      }

      .catalog-item-card:hover {
        border-color: rgba(0, 243, 255, 0.4);
        background: rgba(28, 20, 48, 0.85);
      }

      .catalog-item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .catalog-item-name {
        font-size: 12px;
        font-weight: 600;
        color: #ffffff;
      }

      .catalog-category-badge {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .badge-props { background: rgba(0, 255, 136, 0.18); color: #00ff88; border: 1px solid rgba(0, 255, 136, 0.4); }
      .badge-npcs { background: rgba(192, 132, 252, 0.18); color: #c084fc; border: 1px solid rgba(192, 132, 252, 0.4); }
      .badge-structures { background: rgba(255, 170, 0, 0.18); color: #ffaa00; border: 1px solid rgba(255, 170, 0, 0.4); }
      .badge-items { background: rgba(0, 243, 255, 0.18); color: #00f3ff; border: 1px solid rgba(0, 243, 255, 0.4); }

      .catalog-item-meta {
        font-size: 10px;
        color: #667284;
        font-family: monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .catalog-add-btn {
        background: linear-gradient(135deg, rgba(0, 243, 255, 0.15), rgba(0, 255, 136, 0.15));
        border: 1px solid rgba(0, 243, 255, 0.4);
        color: #00f3ff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
        text-align: center;
      }

      .catalog-add-btn:hover {
        background: linear-gradient(135deg, rgba(0, 243, 255, 0.35), rgba(0, 255, 136, 0.35));
        border-color: #00f3ff;
        color: #ffffff;
        box-shadow: 0 0 10px rgba(0, 243, 255, 0.35);
      }

      .catalog-empty-notice {
        padding: 16px 8px;
        font-size: 12px;
        color: #9aa8be;
        text-align: center;
        font-style: italic;
      }
    `;

    if (document.head) {
      document.head.appendChild(style);
    }
  }
}
