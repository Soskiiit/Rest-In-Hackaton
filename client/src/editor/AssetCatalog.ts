import * as THREE from 'three';
import { ChunkBuilder } from '../engine/ChunkBuilder';
import { SCENE_COLORS } from '../engine/colors';

/**
 * Interface Contract 4: Asset Definition for Level Editor.
 */
export interface AssetDefinition {
  id: string;
  name: string;
  category: 'props' | 'npcs' | 'structures' | 'items';
  modelPath?: string;
  createInstance: (pos?: THREE.Vector3) => THREE.Object3D;
  defaultScale?: number;
  metadata?: Record<string, any>;
}

export type AssetCategory = 'props' | 'npcs' | 'structures' | 'items';

/**
 * AssetCatalog: Registry of 3D models and procedural assets for Rest-In-Hackaton Level Editor.
 * Supports props, NPCs, structures, and items with procedural geometry fallbacks
 * and proper level editor metadata tagging.
 */
export class AssetCatalog {
  private readonly assets: Map<string, AssetDefinition> = new Map();

  constructor() {
    this.registerBuiltinAssets();
  }

  /**
   * Registers an asset definition in the catalog.
   */
  public registerAsset(asset: AssetDefinition): void {
    this.assets.set(asset.id, asset);
  }

  /**
   * Retrieves all registered asset definitions.
   */
  public getAssets(): AssetDefinition[] {
    return Array.from(this.assets.values());
  }

  /**
   * Retrieves all assets belonging to a specific category.
   */
  public getAssetsByCategory(cat: string): AssetDefinition[] {
    return this.getAssets().filter((a) => a.category === cat);
  }

  /**
   * Retrieves an asset definition by ID.
   */
  public getAssetById(id: string): AssetDefinition | undefined {
    return this.assets.get(id);
  }

  /**
   * Checks whether an asset ID exists in the catalog.
   */
  public hasAsset(id: string): boolean {
    return this.assets.has(id);
  }

  /**
   * Returns all available unique categories.
   */
  public getCategories(): AssetCategory[] {
    return ['props', 'npcs', 'structures', 'items'];
  }

  /**
   * Spawns an instance of the asset at the specified world position.
   * Tags the root object with level editor metadata (selectable, assetId, entityType, id).
   */
  public spawnAsset(assetId: string, worldPosition: THREE.Vector3): THREE.Object3D {
    const assetDef = this.assets.get(assetId);
    if (!assetDef) {
      throw new Error(`[AssetCatalog] Cannot spawn unknown asset: ${assetId}`);
    }

    const instance = assetDef.createInstance(worldPosition);
    instance.position.copy(worldPosition);

    if (assetDef.defaultScale !== undefined && assetDef.defaultScale !== 1.0) {
      instance.scale.setScalar(assetDef.defaultScale);
    }

    const entityId = `${assetId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    instance.userData = {
      ...instance.userData,
      isSelectable: true,
      assetId: assetDef.id,
      entityType: assetDef.category,
      id: entityId,
      name: assetDef.name,
      ...(assetDef.metadata || {}),
    };

    instance.name = `${assetDef.name} (${entityId})`;
    instance.matrixAutoUpdate = true;

    return instance;
  }

  // ==========================================================================
  // Builtin Asset Registry
  // ==========================================================================

  private registerBuiltinAssets(): void {
    // ------------------------------------------------------------------------
    // 1. PROPS
    // ------------------------------------------------------------------------

    // Tree
    this.registerAsset({
      id: 'prop_tree',
      name: 'Дерево (Tree)',
      category: 'props',
      modelPath: '/models/tree.glb',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralTree(),
    });

    // Bush
    this.registerAsset({
      id: 'prop_bush',
      name: 'Куст (Bush)',
      category: 'props',
      modelPath: '/models/bush.glb',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralBush(),
    });

    // Chicken
    this.registerAsset({
      id: 'prop_chicken',
      name: 'Курица (Chicken)',
      category: 'props',
      modelPath: '/models/chicken.glb',
      defaultScale: 0.6,
      createInstance: () => this.createProceduralChicken(),
    });

    // Arch
    this.registerAsset({
      id: 'prop_arch',
      name: 'Ворота Пайфанг (Arch)',
      category: 'props',
      modelPath: '/models/arch.obj',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralArch(),
    });

    // Path
    this.registerAsset({
      id: 'prop_path',
      name: 'Каменная плитка (Path)',
      category: 'props',
      modelPath: '/models/path_straight.glb',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralPath(),
    });

    // Crate
    this.registerAsset({
      id: 'prop_crate',
      name: 'Деревянный ящик (Crate)',
      category: 'props',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralCrate(),
    });

    // Barrel
    this.registerAsset({
      id: 'prop_barrel',
      name: 'Бочка (Barrel)',
      category: 'props',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralBarrel(),
    });

    // ------------------------------------------------------------------------
    // 2. NPCs
    // ------------------------------------------------------------------------

    // Lao Wang
    this.registerAsset({
      id: 'npc_lao_wang',
      name: 'Лао Ван (Lao Wang)',
      category: 'npcs',
      modelPath: '/models/lao_wang.glb',
      defaultScale: 1.0,
      metadata: {
        npc_id: 'lao_wang',
        dialogue_ref: 'lao_wang',
        kind: 'merchant',
        price: 800,
        price_floor: 120,
      },
      createInstance: () => this.createProceduralNPC('lao_wang', 0x8a2be2, 0xd4af37),
    });

    // Chef Chen
    this.registerAsset({
      id: 'npc_chef_chen',
      name: 'Шеф Чэнь (Chef Chen)',
      category: 'npcs',
      modelPath: '/models/chef_chen.glb',
      defaultScale: 1.0,
      metadata: {
        npc_id: 'chef_chen',
        dialogue_ref: 'chef_chen',
        kind: 'chef',
        price: 150,
        price_floor: 40,
      },
      createInstance: () => this.createProceduralNPC('chef_chen', 0xffffff, 0xdc143c),
    });

    // Guard Zhang
    this.registerAsset({
      id: 'npc_guard_zhang',
      name: 'Охранник Чжан (Guard Zhang)',
      category: 'npcs',
      modelPath: '/models/npc_man.glb',
      defaultScale: 1.0,
      metadata: {
        npc_id: 'guard_zhang',
        dialogue_ref: 'guard_zhang',
        kind: 'guard',
        price: 0,
        price_floor: 0,
      },
      createInstance: () => this.createProceduralNPC('guard_zhang', 0x1f2937, 0x3b82f6),
    });

    // Generic Vendor
    this.registerAsset({
      id: 'npc_vendor',
      name: 'Торговец (Generic Vendor)',
      category: 'npcs',
      modelPath: '/models/npc_vendor.glb',
      defaultScale: 1.0,
      metadata: {
        npc_id: 'generic_vendor',
        dialogue_ref: 'generic_vendor',
        kind: 'merchant',
      },
      createInstance: () => this.createProceduralNPC('generic_vendor', 0xb45309, 0xf59e0b),
    });

    // Town Citizen
    this.registerAsset({
      id: 'npc_citizen',
      name: 'Горожанин (Town Citizen)',
      category: 'npcs',
      modelPath: '/models/npc_man.glb',
      defaultScale: 1.0,
      metadata: {
        npc_id: 'town_citizen',
        dialogue_ref: 'town_citizen',
        kind: 'citizen',
      },
      createInstance: () => this.createProceduralNPC('town_citizen', 0x059669, 0x10b981),
    });

    // ------------------------------------------------------------------------
    // 3. STRUCTURES
    // ------------------------------------------------------------------------

    // Market Stall variants (8 variants from ChunkBuilder.ts)
    const stallTypes = [
      { id: 'structure_stall_tea', name: 'Лавка: Чай (Tea Stall)', type: 'tea' },
      { id: 'structure_stall_food', name: 'Лавка: Еда (Food Stall)', type: 'food' },
      { id: 'structure_stall_jade', name: 'Лавка: Нефрит (Jade Stall)', type: 'jade' },
      { id: 'structure_stall_noodles', name: 'Лавка: Лапша (Noodles Stall)', type: 'noodles' },
      { id: 'structure_stall_scrolls', name: 'Лавка: Свитки (Scrolls Stall)', type: 'scrolls' },
      { id: 'structure_stall_herbs', name: 'Лавка: Травы (Herbs Stall)', type: 'herbs' },
      { id: 'structure_stall_weapons', name: 'Лавка: Оружие (Weapons Stall)', type: 'weapons' },
      { id: 'structure_stall_general', name: 'Лавка: Общая (General Stall)', type: 'general' },
    ] as const;

    for (const stall of stallTypes) {
      this.registerAsset({
        id: stall.id,
        name: stall.name,
        category: 'structures',
        defaultScale: 1.0,
        metadata: { stallType: stall.type },
        createInstance: () => {
          const s = ChunkBuilder.buildStall(
            {
              x: 0,
              z: 0,
              stallType: stall.type,
              hasLantern: true,
            },
            undefined,
            true
          );
          s.position.set(0, 0, 0);
          return s;
        },
      });
    }

    // Red Lantern with PointLight
    this.registerAsset({
      id: 'structure_lantern_red',
      name: 'Красный фонарь (Red Lantern)',
      category: 'structures',
      defaultScale: 1.0,
      createInstance: () => {
        const lantern = ChunkBuilder.buildLantern(
          {
            x: 0,
            y: 0,
            z: 0,
            color: 0xff3b14,
            intensity: 1.6,
            distance: 14,
          },
          undefined,
          true
        );
        lantern.position.set(0, 0, 0);
        return lantern;
      },
    });

    // Brick Wall
    this.registerAsset({
      id: 'structure_brick_wall',
      name: 'Кирпичная стена (Brick Wall)',
      category: 'structures',
      defaultScale: 1.0,
      createInstance: () => this.createProceduralBrickWall(),
    });

    // Pavilion
    this.registerAsset({
      id: 'structure_pavilion',
      name: 'Павильон (Pavilion)',
      category: 'structures',
      defaultScale: 1.0,
      createInstance: () => {
        const p = ChunkBuilder.buildLaoWangLandmark(undefined, false);
        p.position.set(0, 0, 0);
        return p;
      },
    });

    // ------------------------------------------------------------------------
    // 4. ITEMS
    // ------------------------------------------------------------------------

    // Antique Teapot
    this.registerAsset({
      id: 'item_teapot',
      name: 'Антикварный чайник (Teapot)',
      category: 'items',
      modelPath: '/models/props_teapot.glb',
      defaultScale: 1.0,
      metadata: { item_id: 'teapot', word_id: 'word_teapot' },
      createInstance: () => this.createProceduralTeapot(),
    });

    // Jade Amulet
    this.registerAsset({
      id: 'item_jade_amulet',
      name: 'Нефритовый амулет (Jade Amulet)',
      category: 'items',
      defaultScale: 1.0,
      metadata: { item_id: 'jade_amulet', word_id: 'word_jade' },
      createInstance: () => this.createProceduralJadeAmulet(),
    });

    // Hot Noodles
    this.registerAsset({
      id: 'item_noodles',
      name: 'Горячая лапша (Hot Noodles)',
      category: 'items',
      modelPath: '/models/props_takeout.glb',
      defaultScale: 1.0,
      metadata: { item_id: 'noodles', word_id: 'word_noodles' },
      createInstance: () => this.createProceduralNoodles(),
    });

    // Subway Ticket
    this.registerAsset({
      id: 'item_ticket',
      name: 'Билет на метро (Subway Ticket)',
      category: 'items',
      defaultScale: 1.0,
      metadata: { item_id: 'ticket', word_id: 'word_ticket' },
      createInstance: () => this.createProceduralTicket(),
    });
  }

  // ==========================================================================
  // Procedural Geometries for Props, NPCs, Structures, Items
  // ==========================================================================

  private createProceduralTree(): THREE.Group {
    const group = new THREE.Group();

    // Trunk
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.35, 2.4, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a2e18, roughness: 0.9 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.2;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    // Foliage (stacked cones / spheres)
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x2e6f40,
      roughness: 0.8,
    });
    const layers = [
      { y: 2.2, r: 1.4, h: 1.5 },
      { y: 3.1, r: 1.1, h: 1.4 },
      { y: 3.9, r: 0.7, h: 1.2 },
    ];
    for (const l of layers) {
      const coneGeo = new THREE.ConeGeometry(l.r, l.h, 7);
      const cone = new THREE.Mesh(coneGeo, leafMat);
      cone.position.y = l.y;
      cone.castShadow = true;
      cone.receiveShadow = true;
      group.add(cone);
    }

    return group;
  }

  private createProceduralBush(): THREE.Group {
    const group = new THREE.Group();
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2d6a4f, roughness: 0.85 });

    const spheres = [
      { x: 0, y: 0.45, z: 0, r: 0.5 },
      { x: -0.3, y: 0.35, z: 0.2, r: 0.4 },
      { x: 0.3, y: 0.38, z: -0.15, r: 0.42 },
      { x: 0.1, y: 0.5, z: -0.25, r: 0.35 },
    ];
    for (const s of spheres) {
      const geo = new THREE.DodecahedronGeometry(s.r, 1);
      const m = new THREE.Mesh(geo, leafMat);
      m.position.set(s.x, s.y, s.z);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    return group;
  }

  private createProceduralChicken(): THREE.Group {
    const group = new THREE.Group();

    // Body
    const bodyGeo = new THREE.SphereGeometry(0.22, 10, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf4f1de, roughness: 0.7 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.set(0, 0.22, 0);
    body.scale.set(1.0, 0.9, 1.25);
    group.add(body);

    // Head
    const headGeo = new THREE.SphereGeometry(0.12, 8, 8);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.set(0, 0.38, 0.18);
    group.add(head);

    // Beak
    const beakGeo = new THREE.ConeGeometry(0.04, 0.1, 6);
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xffb703 });
    const beak = new THREE.Mesh(beakGeo, beakMat);
    beak.position.set(0, 0.37, 0.3);
    beak.rotation.x = Math.PI / 2;
    group.add(beak);

    // Red Comb
    const combGeo = new THREE.BoxGeometry(0.03, 0.08, 0.1);
    const combMat = new THREE.MeshStandardMaterial({ color: 0xd90429 });
    const comb = new THREE.Mesh(combGeo, combMat);
    comb.position.set(0, 0.5, 0.16);
    group.add(comb);

    return group;
  }

  private createProceduralArch(): THREE.Group {
    const group = new THREE.Group();
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8b0000, roughness: 0.5 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.7, roughness: 0.3 });

    // Left and right pillars
    const pGeo = new THREE.CylinderGeometry(0.18, 0.2, 3.6, 12);
    const pLeft = new THREE.Mesh(pGeo, pillarMat);
    pLeft.position.set(-1.8, 1.8, 0);
    const pRight = new THREE.Mesh(pGeo, pillarMat);
    pRight.position.set(1.8, 1.8, 0);
    group.add(pLeft, pRight);

    // Crossbar
    const barGeo = new THREE.BoxGeometry(4.2, 0.28, 0.3);
    const bar = new THREE.Mesh(barGeo, pillarMat);
    bar.position.set(0, 3.2, 0);
    group.add(bar);

    // Pagoda roof eave
    const roofGeo = new THREE.BoxGeometry(4.8, 0.18, 0.8);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.6 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 3.48, 0);
    group.add(roof);

    // Gold Plaque
    const plaqueGeo = new THREE.BoxGeometry(1.2, 0.45, 0.04);
    const plaque = new THREE.Mesh(plaqueGeo, goldMat);
    plaque.position.set(0, 2.75, 0.16);
    group.add(plaque);

    return group;
  }

  private createProceduralPath(): THREE.Group {
    const group = new THREE.Group();
    const slabGeo = new THREE.BoxGeometry(2.0, 0.08, 2.0);
    const slabMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.stoneTileLightColor || 0x4a4a52,
      roughness: 0.85,
    });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.y = 0.04;
    slab.receiveShadow = true;
    group.add(slab);
    return group;
  }

  private createProceduralCrate(): THREE.Group {
    const group = new THREE.Group();
    const crateGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.8 });
    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.y = 0.4;
    crate.castShadow = true;
    crate.receiveShadow = true;
    crate.userData = { isObstacle: true };
    group.add(crate);

    // Corner bands
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x332211, metalness: 0.5, roughness: 0.6 });
    const bandGeo = new THREE.BoxGeometry(0.82, 0.08, 0.82);
    const bTop = new THREE.Mesh(bandGeo, bandMat);
    bTop.position.y = 0.7;
    const bBot = new THREE.Mesh(bandGeo, bandMat);
    bBot.position.y = 0.1;
    group.add(bTop, bBot);

    return group;
  }

  private createProceduralBarrel(): THREE.Group {
    const group = new THREE.Group();
    const barrelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.95, 14);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.75 });
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.y = 0.475;
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    barrel.userData = { isObstacle: true };
    group.add(barrel);

    // Metal Rings
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.7, roughness: 0.4 });
    const ringGeo = new THREE.CylinderGeometry(0.395, 0.395, 0.04, 14);
    const r1 = new THREE.Mesh(ringGeo, ringMat);
    r1.position.y = 0.2;
    const r2 = new THREE.Mesh(ringGeo, ringMat);
    r2.position.y = 0.75;
    group.add(r1, r2);

    return group;
  }

  private createProceduralNPC(id: string, robeColor: number, accentColor: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `npc_${id}_marker`;

    // Robe / Body
    const bodyGeo = new THREE.CylinderGeometry(0.24, 0.35, 1.25, 12);
    const bodyMat = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.6 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.625;
    body.castShadow = true;
    group.add(body);

    // Head
    const headGeo = new THREE.SphereGeometry(0.18, 12, 10);
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf5d0b0, roughness: 0.7 });
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.4;
    head.castShadow = true;
    group.add(head);

    // Hat / Accent
    const hatGeo = new THREE.ConeGeometry(0.26, 0.2, 12);
    const hatMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.5 });
    const hat = new THREE.Mesh(hatGeo, hatMat);
    hat.position.y = 1.62;
    group.add(hat);

    // Base marker ring for editor visibility
    const ringGeo = new THREE.RingGeometry(0.4, 0.5, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00f3ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);

    return group;
  }

  private createProceduralBrickWall(): THREE.Group {
    const group = new THREE.Group();
    const wallGeo = new THREE.BoxGeometry(4.0, 3.0, 0.6);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x3d2b27,
      roughness: 0.9,
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 1.5;
    wall.castShadow = true;
    wall.receiveShadow = true;
    wall.userData = { isWall: true };
    group.add(wall);

    // Roof Eave
    const eaveGeo = new THREE.BoxGeometry(4.3, 0.2, 0.9);
    const eaveMat = new THREE.MeshStandardMaterial({ color: 0x1f2429, roughness: 0.6 });
    const eave = new THREE.Mesh(eaveGeo, eaveMat);
    eave.position.y = 3.05;
    group.add(eave);

    return group;
  }

  private createProceduralTeapot(): THREE.Group {
    const group = new THREE.Group();

    // Body
    const bodyGeo = new THREE.SphereGeometry(0.2, 14, 12);
    const clayMat = new THREE.MeshStandardMaterial({
      color: 0x5a1805, // Yixing purple clay
      roughness: 0.35,
      metalness: 0.15,
    });
    const body = new THREE.Mesh(bodyGeo, clayMat);
    body.position.y = 0.18;
    body.scale.set(1.0, 0.85, 1.0);
    group.add(body);

    // Lid & brass finial
    const lidGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.04, 12);
    const lid = new THREE.Mesh(lidGeo, clayMat);
    lid.position.y = 0.33;
    group.add(lid);

    const finialGeo = new THREE.SphereGeometry(0.03, 8, 8);
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.2 });
    const finial = new THREE.Mesh(finialGeo, goldMat);
    finial.position.y = 0.37;
    group.add(finial);

    // Handle
    const handleGeo = new THREE.TorusGeometry(0.12, 0.022, 8, 14, Math.PI);
    const handle = new THREE.Mesh(handleGeo, clayMat);
    handle.position.set(-0.16, 0.21, 0);
    handle.rotation.z = Math.PI / 2;
    group.add(handle);

    // Spout
    const spoutGeo = new THREE.CylinderGeometry(0.025, 0.04, 0.14, 8);
    const spout = new THREE.Mesh(spoutGeo, clayMat);
    spout.position.set(0.15, 0.22, 0);
    spout.rotation.z = -Math.PI / 3.5;
    group.add(spout);

    return group;
  }

  private createProceduralJadeAmulet(): THREE.Group {
    const group = new THREE.Group();

    // Jade Ring / Disc (Bi disc)
    const discGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.035, 24);
    const jadeMat = new THREE.MeshStandardMaterial({
      color: 0x2ec4b6, // Imperial green jade
      roughness: 0.15,
      metalness: 0.1,
      transparent: true,
      opacity: 0.92,
    });
    const disc = new THREE.Mesh(discGeo, jadeMat);
    disc.position.y = 0.2;
    disc.rotation.x = Math.PI / 4;
    group.add(disc);

    // Gold silk ribbon cord
    const cordGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8);
    const cordMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.4 });
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.set(0, 0.36, -0.05);
    group.add(cord);

    return group;
  }

  private createProceduralNoodles(): THREE.Group {
    const group = new THREE.Group();

    // Ceramic Bowl
    const bowlGeo = new THREE.CylinderGeometry(0.24, 0.14, 0.16, 16);
    const bowlMat = new THREE.MeshStandardMaterial({ color: 0x0f2a4a, roughness: 0.2 });
    const bowl = new THREE.Mesh(bowlGeo, bowlMat);
    bowl.position.y = 0.08;
    group.add(bowl);

    // Noodles broth surface
    const brothGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.02, 16);
    const brothMat = new THREE.MeshStandardMaterial({ color: 0x8a3311, roughness: 0.3 });
    const broth = new THREE.Mesh(brothGeo, brothMat);
    broth.position.y = 0.15;
    group.add(broth);

    // Pair of chopsticks
    const chopMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.6 });
    const chopGeo = new THREE.CylinderGeometry(0.008, 0.012, 0.36, 6);
    const c1 = new THREE.Mesh(chopGeo, chopMat);
    c1.position.set(-0.06, 0.22, 0.06);
    c1.rotation.set(0.2, 0.3, 0.4);
    const c2 = new THREE.Mesh(chopGeo, chopMat);
    c2.position.set(-0.04, 0.22, 0.08);
    c2.rotation.set(0.2, 0.3, 0.4);
    group.add(c1, c2);

    return group;
  }

  private createProceduralTicket(): THREE.Group {
    const group = new THREE.Group();

    // Transit Card / Subway Ticket
    const cardGeo = new THREE.BoxGeometry(0.28, 0.01, 0.18);
    const cardMat = new THREE.MeshStandardMaterial({
      color: 0x00f3ff, // Shenzhen Metro neon cyan
      metalness: 0.2,
      roughness: 0.4,
    });
    const card = new THREE.Mesh(cardGeo, cardMat);
    card.position.y = 0.01;
    group.add(card);

    // Chip / Stripe
    const chipGeo = new THREE.BoxGeometry(0.07, 0.012, 0.05);
    const chipMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.3 });
    const chip = new THREE.Mesh(chipGeo, chipMat);
    chip.position.set(-0.06, 0.011, 0);
    group.add(chip);

    return group;
  }
}
