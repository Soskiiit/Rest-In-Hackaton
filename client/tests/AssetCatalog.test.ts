/**
 * Milestone M3 Test Suite: Asset Catalog, Catalog UI Panel, and Property Inspector
 * Target File: client/tests/AssetCatalog.test.ts
 *
 * Verifies:
 * 1. Asset Catalog Registry completeness, categories, and query lookups.
 * 2. 3D Asset Spawning and proper level editor metadata tagging.
 * 3. Asset Catalog UI DOM panel rendering, tab switching, search filtering, and spawn callbacks.
 * 4. Property Inspector DOM panel data binding, transform controls (X/Y/Z, RotY, Scale), gizmo modes, and deletion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssetCatalog, AssetDefinition } from '../src/editor/AssetCatalog';
import { AssetCatalogUI } from '../src/editor/AssetCatalogUI';
import { PropertyInspector, SelectableEntityLike } from '../src/editor/PropertyInspector';

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
  public children: MockDomElement[] = [];
  public classList: MockClassList;
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public listeners: Record<string, Function[]> = {};

  // Input & Button properties
  public type: string = '';
  public value: string = '';
  public placeholder: string = '';
  public title: string = '';
  public step: string = '';
  public min: string = '';
  public max: string = '';

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
    this.children.push(child);
    return child;
  }

  public removeChild<T extends MockDomElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
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
      return this.hasAttribute(attr);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  private hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
}

class MockDocument {
  public head: MockDomElement = new MockDomElement('head', 'HEAD');
  public body: MockDomElement = new MockDomElement('body', 'BODY');
  public activeElement: MockDomElement | null = null;

  public createElement(tag: string): MockDomElement {
    return new MockDomElement('', tag);
  }

  public getElementById(id: string): MockDomElement | null {
    if (this.body.id === id) return this.body;
    return this.body.querySelector(`#${id}`);
  }
}

// Global DOM setup
let mockDoc: MockDocument;
const originalDoc = (global as any).document;

function setupMockDOM(): void {
  mockDoc = new MockDocument();
  (global as any).document = mockDoc;
  (global as any).window = { document: mockDoc };
}

function teardownMockDOM(): void {
  if (originalDoc) {
    (global as any).document = originalDoc;
  } else {
    delete (global as any).document;
    delete (global as any).window;
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('AssetCatalog Registry', () => {
  let catalog: AssetCatalog;

  beforeEach(() => {
    catalog = new AssetCatalog();
  });

  it('should initialize and register all required categories and assets', () => {
    const assets = catalog.getAssets();
    expect(assets.length).toBeGreaterThanOrEqual(20);

    const categories = catalog.getCategories();
    expect(categories).toEqual(['props', 'npcs', 'structures', 'items']);
  });

  it('should contain all required props from models and procedural generators', () => {
    const props = catalog.getAssetsByCategory('props');
    const ids = props.map((p) => p.id);

    expect(ids).toContain('prop_tree');
    expect(ids).toContain('prop_bush');
    expect(ids).toContain('prop_chicken');
    expect(ids).toContain('prop_arch');
    expect(ids).toContain('prop_path');
    expect(ids).toContain('prop_crate');
    expect(ids).toContain('prop_barrel');
  });

  it('should contain all required NPCs with spawn metadata', () => {
    const npcs = catalog.getAssetsByCategory('npcs');
    const ids = npcs.map((n) => n.id);

    expect(ids).toContain('npc_lao_wang');
    expect(ids).toContain('npc_chef_chen');
    expect(ids).toContain('npc_guard_zhang');
    expect(ids).toContain('npc_vendor');
    expect(ids).toContain('npc_citizen');

    // Verify NPC metadata
    const laoWang = catalog.getAssetById('npc_lao_wang');
    expect(laoWang).toBeDefined();
    expect(laoWang?.metadata?.npc_id).toBe('lao_wang');
    expect(laoWang?.metadata?.dialogue_ref).toBe('lao_wang');
    expect(laoWang?.metadata?.kind).toBe('merchant');

    const chefChen = catalog.getAssetById('npc_chef_chen');
    expect(chefChen?.metadata?.npc_id).toBe('chef_chen');
    expect(chefChen?.metadata?.kind).toBe('chef');

    const guardZhang = catalog.getAssetById('npc_guard_zhang');
    expect(guardZhang?.metadata?.npc_id).toBe('guard_zhang');
    expect(guardZhang?.metadata?.kind).toBe('guard');
  });

  it('should contain 8 market stall variants and structures', () => {
    const structures = catalog.getAssetsByCategory('structures');
    const ids = structures.map((s) => s.id);

    // 8 market stall merchandise variants
    expect(ids).toContain('structure_stall_tea');
    expect(ids).toContain('structure_stall_food');
    expect(ids).toContain('structure_stall_jade');
    expect(ids).toContain('structure_stall_noodles');
    expect(ids).toContain('structure_stall_scrolls');
    expect(ids).toContain('structure_stall_herbs');
    expect(ids).toContain('structure_stall_weapons');
    expect(ids).toContain('structure_stall_general');

    // Red Lantern, Brick Wall, Pavilion
    expect(ids).toContain('structure_lantern_red');
    expect(ids).toContain('structure_brick_wall');
    expect(ids).toContain('structure_pavilion');
  });

  it('should contain all required quest/market items', () => {
    const items = catalog.getAssetsByCategory('items');
    const ids = items.map((i) => i.id);

    expect(ids).toContain('item_teapot');
    expect(ids).toContain('item_jade_amulet');
    expect(ids).toContain('item_noodles');
    expect(ids).toContain('item_ticket');

    const teapot = catalog.getAssetById('item_teapot');
    expect(teapot?.metadata?.item_id).toBe('teapot');
    expect(teapot?.metadata?.word_id).toBe('word_teapot');
  });

  it('should support custom asset registration and lookup', () => {
    const customAsset: AssetDefinition = {
      id: 'custom_statue',
      name: 'Custom Dragon Statue',
      category: 'structures',
      createInstance: () => new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)),
    };

    catalog.registerAsset(customAsset);
    expect(catalog.hasAsset('custom_statue')).toBe(true);
    expect(catalog.getAssetById('custom_statue')).toBe(customAsset);
    expect(catalog.getAssetsByCategory('structures')).toContain(customAsset);
  });
});

describe('Asset Spawning & Object Instantiation', () => {
  let catalog: AssetCatalog;

  beforeEach(() => {
    catalog = new AssetCatalog();
  });

  it('should spawn a prop with correct position and level editor userData tags', () => {
    const spawnPos = new THREE.Vector3(45.5, 0.0, 78.2);
    const obj = catalog.spawnAsset('prop_tree', spawnPos);

    expect(obj).toBeInstanceOf(THREE.Object3D);
    expect(obj.position.x).toBeCloseTo(45.5);
    expect(obj.position.y).toBeCloseTo(0.0);
    expect(obj.position.z).toBeCloseTo(78.2);

    expect(obj.userData.isSelectable).toBe(true);
    expect(obj.userData.assetId).toBe('prop_tree');
    expect(obj.userData.entityType).toBe('props');
    expect(typeof obj.userData.id).toBe('string');
    expect(obj.userData.id.length).toBeGreaterThan(0);
    expect(obj.matrixAutoUpdate).toBe(true);
  });

  it('should spawn an NPC with attached NPC metadata in userData', () => {
    const spawnPos = new THREE.Vector3(100.0, 0.0, 124.0);
    const obj = catalog.spawnAsset('npc_lao_wang', spawnPos);

    expect(obj.userData.isSelectable).toBe(true);
    expect(obj.userData.assetId).toBe('npc_lao_wang');
    expect(obj.userData.entityType).toBe('npcs');
    expect(obj.userData.npc_id).toBe('lao_wang');
    expect(obj.userData.dialogue_ref).toBe('lao_wang');
    expect(obj.userData.kind).toBe('merchant');
  });

  it('should spawn a market stall structure with meshes and children', () => {
    const spawnPos = new THREE.Vector3(10, 0, 20);
    const stallObj = catalog.spawnAsset('structure_stall_tea', spawnPos);

    expect(stallObj.children.length).toBeGreaterThan(0);
    expect(stallObj.userData.entityType).toBe('structures');
    expect(stallObj.userData.stallType).toBe('tea');
  });

  it('should spawn red lantern containing a point light', () => {
    const spawnPos = new THREE.Vector3(12, 3, 14);
    const lantern = catalog.spawnAsset('structure_lantern_red', spawnPos);

    let foundLight = false;
    lantern.traverse((child) => {
      if ((child as any).isLight || (child as any).isPointLight) {
        foundLight = true;
      }
    });

    expect(foundLight).toBe(true);
    expect(lantern.userData.entityType).toBe('structures');
  });

  it('should apply defaultScale when specified on asset definition', () => {
    const chicken = catalog.spawnAsset('prop_chicken', new THREE.Vector3(0, 0, 0));
    expect(chicken.scale.x).toBeCloseTo(0.6);
    expect(chicken.scale.y).toBeCloseTo(0.6);
    expect(chicken.scale.z).toBeCloseTo(0.6);
  });

  it('should throw an informative error when trying to spawn an unknown asset', () => {
    expect(() => {
      catalog.spawnAsset('non_existent_asset_xyz', new THREE.Vector3(0, 0, 0));
    }).toThrowError(/Cannot spawn unknown asset/);
  });
});

describe('AssetCatalogUI Component', () => {
  let catalog: AssetCatalog;
  let ui: AssetCatalogUI;

  beforeEach(() => {
    setupMockDOM();
    catalog = new AssetCatalog();
  });

  afterEach(() => {
    if (ui) ui.unmount();
    teardownMockDOM();
  });

  it('should build and mount left panel with header, search, tabs, and item list', () => {
    ui = new AssetCatalogUI(catalog);
    ui.mount(mockDoc.body as any);

    const panel = mockDoc.body.querySelector('#asset-catalog-panel');
    expect(panel).not.toBeNull();

    const title = panel?.querySelector('.catalog-title');
    expect(title?.textContent).toContain('Каталог ассетов');

    const search = panel?.querySelector('.catalog-search-input');
    expect(search).not.toBeNull();

    const tabs = panel?.querySelectorAll('.catalog-tab-btn');
    expect(tabs?.length).toBe(4);
  });

  it('should switch tabs and filter rendered assets accordingly', () => {
    ui = new AssetCatalogUI(catalog);
    ui.mount(mockDoc.body as any);

    // Initial tab is 'props'
    expect(ui.getActiveTab()).toBe('props');

    // Switch to NPCs
    ui.setActiveTab('npcs');
    expect(ui.getActiveTab()).toBe('npcs');

    const itemCards = mockDoc.body.querySelectorAll('.catalog-item-card');
    expect(itemCards.length).toBe(5); // 5 NPCs registered

    // Switch to Structures
    ui.setActiveTab('structures');
    expect(ui.getActiveTab()).toBe('structures');
    const structureCards = mockDoc.body.querySelectorAll('.catalog-item-card');
    expect(structureCards.length).toBeGreaterThanOrEqual(10);
  });

  it('should filter items via search query', () => {
    ui = new AssetCatalogUI(catalog);
    ui.mount(mockDoc.body as any);

    ui.setActiveTab('npcs');
    ui.setSearchQuery('Шеф');

    const filteredCards = mockDoc.body.querySelectorAll('.catalog-item-card');
    expect(filteredCards.length).toBe(1);
    expect(filteredCards[0].textContent).toContain('Шеф Чэнь');

    // Nonexistent query shows empty notice
    ui.setSearchQuery('несуществующий_объект');
    const emptyNotice = mockDoc.body.querySelector('.catalog-empty-notice');
    expect(emptyNotice).not.toBeNull();
  });

  it('should trigger onAssetSpawnRequested callback when clicking Add button', () => {
    const spawnSpy = vi.fn();
    ui = new AssetCatalogUI(catalog, { onAssetSpawnRequested: spawnSpy });
    ui.mount(mockDoc.body as any);

    ui.setActiveTab('props');
    const addBtns = mockDoc.body.querySelectorAll('.catalog-add-btn');
    expect(addBtns.length).toBeGreaterThan(0);

    // Click first button (tree)
    addBtns[0].click();
    expect(spawnSpy).toHaveBeenCalledWith('prop_tree');
  });

  it('should toggle collapse state when collapse button is clicked', () => {
    ui = new AssetCatalogUI(catalog);
    ui.mount(mockDoc.body as any);

    const collapseBtn = mockDoc.body.querySelector('.catalog-collapse-btn');
    expect(collapseBtn).not.toBeNull();

    expect(ui.isCollapsed()).toBe(false);
    collapseBtn?.click();
    expect(ui.isCollapsed()).toBe(true);

    collapseBtn?.click();
    expect(ui.isCollapsed()).toBe(false);
  });
});

describe('PropertyInspector Component', () => {
  let inspector: PropertyInspector;

  beforeEach(() => {
    setupMockDOM();
  });

  afterEach(() => {
    if (inspector) inspector.unmount();
    teardownMockDOM();
  });

  it('should display empty placeholder when no entity is bound', () => {
    inspector = new PropertyInspector();
    inspector.mount(mockDoc.body as any);

    const emptyNotice = mockDoc.body.querySelector('.inspector-empty-notice');
    expect(emptyNotice).not.toBeNull();
    expect(emptyNotice?.style.display).not.toBe('none');

    const details = mockDoc.body.querySelector('.inspector-details');
    expect(details?.style.display).toBe('none');
  });

  it('should bind SelectableEntity and populate metadata and transform values', () => {
    inspector = new PropertyInspector();
    inspector.mount(mockDoc.body as any);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(12.5, 3.2, -8.7);
    mesh.rotation.y = Math.PI / 2; // 90 degrees
    mesh.scale.set(2.0, 2.0, 2.0);

    const entity: SelectableEntityLike = {
      id: 'entity_99',
      assetId: 'prop_crate',
      type: 'prop',
      rootObject: mesh,
    };

    inspector.bindEntity(entity);

    const details = mockDoc.body.querySelector('.inspector-details');
    expect(details?.style.display).toBe('flex');

    const idEl = mockDoc.body.querySelector('.inspector-entity-id');
    expect(idEl?.textContent).toBe('entity_99');

    const nameEl = mockDoc.body.querySelector('.inspector-asset-name');
    expect(nameEl?.textContent).toBe('prop_crate');

    // Transform inputs
    const numInputs = mockDoc.body.querySelectorAll('.inspector-number-input');
    // X, Y, Z, RotY, Scale
    expect(numInputs[0].value).toBe('12.50');
    expect(numInputs[1].value).toBe('3.20');
    expect(numInputs[2].value).toBe('-8.70');
    expect(numInputs[3].value).toBe('90.0');
    expect(numInputs[4].value).toBe('2.00');
  });

  it('should update entity transform when user modifies numeric inputs', () => {
    const transformSpy = vi.fn();
    inspector = new PropertyInspector({ onTransformChanged: transformSpy });
    inspector.mount(mockDoc.body as any);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(0, 0, 0);

    inspector.bindEntity({
      id: 'obj_1',
      rootObject: mesh,
      type: 'prop',
    });

    const numInputs = mockDoc.body.querySelectorAll('.inspector-number-input');
    const posXInput = numInputs[0];
    const posYInput = numInputs[1];
    const posZInput = numInputs[2];
    const rotYInput = numInputs[3];
    const scaleInput = numInputs[4];

    // Change X
    posXInput.value = '25.4';
    posXInput.dispatchEvent({ type: 'change' });
    expect(mesh.position.x).toBeCloseTo(25.4);
    expect(transformSpy).toHaveBeenCalledWith(mesh, 'position');

    // Change Y
    posYInput.value = '5.0';
    posYInput.dispatchEvent({ type: 'change' });
    expect(mesh.position.y).toBeCloseTo(5.0);

    // Change Z
    posZInput.value = '42.1';
    posZInput.dispatchEvent({ type: 'change' });
    expect(mesh.position.z).toBeCloseTo(42.1);

    // Change RotY (180 degrees -> Math.PI)
    rotYInput.value = '180';
    rotYInput.dispatchEvent({ type: 'change' });
    expect(mesh.rotation.y).toBeCloseTo(Math.PI);
    expect(transformSpy).toHaveBeenCalledWith(mesh, 'rotation');

    // Change Scale
    scaleInput.value = '3.5';
    scaleInput.dispatchEvent({ type: 'change' });
    expect(mesh.scale.x).toBeCloseTo(3.5);
    expect(mesh.scale.y).toBeCloseTo(3.5);
    expect(mesh.scale.z).toBeCloseTo(3.5);
    expect(transformSpy).toHaveBeenCalledWith(mesh, 'scale');
  });

  it('should switch gizmo modes and notify listeners', () => {
    const modeSpy = vi.fn();
    inspector = new PropertyInspector({ onGizmoModeChange: modeSpy });
    inspector.mount(mockDoc.body as any);

    const gizmoButtons = mockDoc.body.querySelectorAll('.inspector-gizmo-btn');
    expect(gizmoButtons.length).toBe(3);

    // Click Rotate (R)
    gizmoButtons[1].click();
    expect(inspector.getGizmoMode()).toBe('rotate');
    expect(modeSpy).toHaveBeenCalledWith('rotate');

    // Click Scale (S)
    gizmoButtons[2].click();
    expect(inspector.getGizmoMode()).toBe('scale');
    expect(modeSpy).toHaveBeenCalledWith('scale');

    // Click Translate (T)
    gizmoButtons[0].click();
    expect(inspector.getGizmoMode()).toBe('translate');
    expect(modeSpy).toHaveBeenCalledWith('translate');
  });

  it('should trigger delete request when delete button is clicked', () => {
    const deleteSpy = vi.fn();
    inspector = new PropertyInspector({ onDeleteRequested: deleteSpy });
    inspector.mount(mockDoc.body as any);

    const testEntity = {
      id: 'item_to_delete',
      rootObject: new THREE.Mesh(),
      type: 'item',
    };

    inspector.bindEntity(testEntity);

    const deleteBtn = mockDoc.body.querySelector('.inspector-delete-btn');
    expect(deleteBtn).not.toBeNull();

    deleteBtn?.click();
    expect(deleteSpy).toHaveBeenCalledWith(testEntity);
  });

  it('should reset to empty placeholder when bindEntity(null) is called', () => {
    inspector = new PropertyInspector();
    inspector.mount(mockDoc.body as any);

    inspector.bindEntity({
      id: 'entity_temp',
      rootObject: new THREE.Mesh(),
      type: 'prop',
    });

    expect(inspector.getBoundEntity()).not.toBeNull();

    inspector.bindEntity(null);
    expect(inspector.getBoundEntity()).toBeNull();

    const emptyNotice = mockDoc.body.querySelector('.inspector-empty-notice');
    expect(emptyNotice?.style.display).toBe('block');

    const details = mockDoc.body.querySelector('.inspector-details');
    expect(details?.style.display).toBe('none');
  });
});

// ============================================================================
// Market GLB models (carts on wheels and empty stalls)
// ============================================================================

describe('Market GLB models', () => {
  const MARKET_IDS = ['market_cart_jianbing', 'market_cart_tanghulu', 'market_stall_pavilion', 'market_stall_awning'];

  it('registers carts and empty stalls as structures backed by existing GLB files', () => {
    const catalog = new AssetCatalog();
    for (const id of MARKET_IDS) {
      const asset = catalog.getAssetById(id);
      expect(asset?.category).toBe('structures');
      expect(asset?.modelPath).toMatch(/^\/models\/market\/[a-z_]+\.glb$/);
      expect(existsSync(fileURLToPath(new URL('../public' + asset!.modelPath, import.meta.url)))).toBe(true);
    }
  });

  it('spawns a selectable placeholder synchronously when no browser is available', () => {
    const catalog = new AssetCatalog();
    for (const id of MARKET_IDS) {
      const obj = catalog.spawnAsset(id, new THREE.Vector3(10, 0, 20));
      expect(obj.userData.isSelectable).toBe(true);
      expect(obj.userData.assetId).toBe(id);
      expect(obj.position.toArray()).toEqual([10, 0, 20]);
      const box = new THREE.Box3().setFromObject(obj);
      expect(box.min.y).toBeCloseTo(0);
      expect(box.max.y).toBeGreaterThan(2);
    }
  });
});
