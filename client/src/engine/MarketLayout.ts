import * as THREE from 'three';
import { ChunkBuilder, StallType } from './ChunkBuilder';
import { SCENE_COLORS } from './colors';

export interface LayoutStallItem {
  x: number;
  z: number;
  rotY: number;
  type?: StallType;
}

export interface LayoutWallItem {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

/**
 * Custom Street Layout perfectly matching the user's blueprint diagram:
 * - Entrance Street (bottom avenue moving north towards intersection at x=100, z=100)
 * - Crossroads at (100, 100)
 * - West street corridor turning into West Square Plaza
 * - East street corridor turning into East Square Plaza
 * - North street turning into Giant Central Square Plaza (Lao Wang's bazaar)
 * - Continuous brick walls directly behind every row of stalls!
 */
export class MarketLayout {
  /**
   * Generates all stalls matching the user's blueprint layout centered at (100, 100).
   */
  public static getStalls(): LayoutStallItem[] {
    const stalls: LayoutStallItem[] = [];
    const stallTypes: StallType[] = ['tea', 'food', 'jade', 'noodles', 'scrolls', 'herbs', 'weapons', 'general'];
    let typeIdx = 0;

    const addStall = (x: number, z: number, rotY: number) => {
      stalls.push({
        x,
        z,
        rotY,
        type: stallTypes[typeIdx++ % stallTypes.length],
      });
    };

    // -------------------------------------------------------------------------
    // 1. SOUTH ENTRANCE AVENUE (Player walks North towards Z=100)
    // Left row at X=96.2 (facing East towards center: rotY = -Math.PI / 2)
    // Right row at X=103.8 (facing West towards center: rotY = Math.PI / 2)
    // -------------------------------------------------------------------------
    for (let z = 62; z <= 94; z += 3.6) {
      addStall(96.2, z, -Math.PI / 2);
      addStall(103.8, z, Math.PI / 2);
    }

    // -------------------------------------------------------------------------
    // 2. WEST CORRIDOR & WEST SQUARE PLAZA
    // -------------------------------------------------------------------------
    // Corridor between X=72 and X=96
    for (let x = 74; x <= 94; x += 3.6) {
      addStall(x, 103.8, 0); // South row facing North
    }
    for (let x = 74; x <= 92; x += 3.6) {
      addStall(x, 96.2, Math.PI); // North row facing South
    }

    // West Square Plaza (around X=60, Z=100)
    // West vertical wall of stalls (X=50, facing East: rotY = -Math.PI / 2)
    for (let z = 92; z <= 108; z += 3.6) {
      addStall(50.0, z, -Math.PI / 2);
    }
    // North horizontal wall of stalls (Z=90, facing South: rotY = Math.PI)
    for (let x = 53.6; x <= 68.0; x += 3.6) {
      addStall(x, 90.0, Math.PI);
    }
    // South horizontal wall of stalls (Z=110, facing North: rotY = 0)
    for (let x = 53.6; x <= 68.0; x += 3.6) {
      addStall(x, 110.0, 0);
    }

    // -------------------------------------------------------------------------
    // 3. EAST CORRIDOR & EAST SQUARE PLAZA
    // -------------------------------------------------------------------------
    // Corridor between X=104 and X=126
    for (let x = 106; x <= 126; x += 3.6) {
      addStall(x, 103.8, 0); // South row facing North
    }
    for (let x = 108; x <= 126; x += 3.6) {
      addStall(x, 96.2, Math.PI); // North row facing South
    }

    // East Square Plaza (around X=140, Z=100)
    // East vertical wall of stalls (X=150, facing West: rotY = Math.PI / 2)
    for (let z = 92; z <= 108; z += 3.6) {
      addStall(150.0, z, Math.PI / 2);
    }
    // North horizontal wall of stalls (Z=90, facing South: rotY = Math.PI)
    for (let x = 132.0; x <= 146.4; x += 3.6) {
      addStall(x, 90.0, Math.PI);
    }
    // South horizontal wall of stalls (Z=110, facing North: rotY = 0)
    for (let x = 132.0; x <= 146.4; x += 3.6) {
      addStall(x, 110.0, 0);
    }

    // -------------------------------------------------------------------------
    // 4. LARGE NORTH SQUARE PLAZA (Giant Bazaar matching blueprint top)
    // Stalls arranged around perimeter facing inwards
    // -------------------------------------------------------------------------
    // West vertical row (X=82, Z from 108 to 142, facing East: rotY = -Math.PI / 2)
    for (let z = 108; z <= 142; z += 3.6) {
      addStall(82.0, z, -Math.PI / 2);
    }
    // East vertical row (X=118, Z from 108 to 142, facing West: rotY = Math.PI / 2)
    for (let z = 108; z <= 142; z += 3.6) {
      addStall(118.0, z, Math.PI / 2);
    }
    // North top row (Z=144, X from 84 to 116, facing South: rotY = Math.PI)
    for (let x = 85.0; x <= 115.0; x += 3.6) {
      addStall(x, 144.0, Math.PI);
    }

    return stalls;
  }

  /**
   * Generates solid brick building walls positioned directly behind each row of stalls.
   */
  /**
   * Generates solid brick building walls forming the closed building blocks directly behind the stalls:
   * 1. Top North Building Wall (yellow rectangle across top, buttressed directly to North Plaza stalls at Z=146.5)
   * 2. West Building Outer Wall (yellow rectangle along left, buttressed directly to West Plaza stalls at X=47.5)
   * 3. East Building Outer Wall (yellow rectangle along right, buttressed directly to East Plaza stalls at X=152.5)
   * 4. South-West Building Outer Wall (yellow rectangle at bottom-left, buttressed to South Avenue at Z=60)
   * 5. South-East Building Outer Wall (yellow rectangle at bottom-right, buttressed to South Avenue at Z=60)
   * Plus all the inner building walls directly behind the corridor stalls, perfectly enclosing the corridors!
   */
  public static getWalls(): LayoutWallItem[] {
    const wallH = 8.5;
    return [
      // =======================================================================
      // 1. SOUTH ENTRANCE AVENUE WALLS (Flanking the South street corridor)
      // Left (West) wall at X=93.5, Z from 60 to 95 (length: 35m)
      { x: 93.5, z: 77.5, width: 4.0, depth: 35.0, height: wallH },
      // Right (East) wall at X=106.5, Z from 60 to 95 (length: 35m)
      { x: 106.5, z: 77.5, width: 4.0, depth: 35.0, height: wallH },

      // =======================================================================
      // 2. WEST CORRIDOR & WEST PLAZA (Closed Building Facades)
      // South corridor wall: Z=106.0, X from 71 to 93.5
      { x: 82.25, z: 106.0, width: 22.5, depth: 4.0, height: wallH },
      // North corridor wall: Z=94.0, X from 71 to 81
      { x: 76.0, z: 94.0, width: 10.0, depth: 4.0, height: wallH },

      // West Plaza interior building walls:
      // East opening perimeter segment: X=71, Z from 106 to 112.5
      { x: 71.0, z: 109.25, width: 4.0, depth: 6.5, height: wallH },
      // East opening perimeter segment: X=71, Z from 87.5 to 94
      { x: 71.0, z: 90.75, width: 4.0, depth: 6.5, height: wallH },
      // South Plaza wall: Z=112.5, X from 47.5 to 71
      { x: 59.25, z: 112.5, width: 23.5, depth: 4.0, height: wallH },
      // North Plaza wall: Z=87.5, X from 47.5 to 71
      { x: 59.25, z: 87.5, width: 23.5, depth: 4.0, height: wallH },

      // =======================================================================
      // 3. EAST CORRIDOR & EAST PLAZA (Closed Building Facades)
      // South corridor wall: Z=106.0, X from 106.5 to 129
      { x: 117.75, z: 106.0, width: 22.5, depth: 4.0, height: wallH },
      // North corridor wall: Z=94.0, X from 119 to 129
      { x: 124.0, z: 94.0, width: 10.0, depth: 4.0, height: wallH },

      // East Plaza interior building walls:
      // West opening perimeter segment: X=129, Z from 106 to 112.5
      { x: 129.0, z: 109.25, width: 4.0, depth: 6.5, height: wallH },
      // West opening perimeter segment: X=129, Z from 87.5 to 94
      { x: 129.0, z: 90.75, width: 4.0, depth: 6.5, height: wallH },
      // South Plaza wall: Z=112.5, X from 129 to 152.5
      { x: 140.75, z: 112.5, width: 23.5, depth: 4.0, height: wallH },
      // North Plaza wall: Z=87.5, X from 129 to 152.5
      { x: 140.75, z: 87.5, width: 23.5, depth: 4.0, height: wallH },

      // =======================================================================
      // 4. LARGE NORTH PLAZA WALLS (Enclosing the North Square Bazaar)
      // West Plaza interior wall: X=79.5, Z from 94 to 146.5 (length: 52.5m)
      { x: 79.5, z: 120.25, width: 4.0, depth: 52.5, height: wallH },
      // East Plaza interior wall: X=120.5, Z from 94 to 146.5 (length: 52.5m)
      { x: 120.5, z: 120.25, width: 4.0, depth: 52.5, height: wallH },

      // =======================================================================
      // 5. EXTERNAL BUILDING WALLS (The 4 Yellow Rectangles on the Blueprint)
      // Flush and buttressed to form the outer perimeter of the buildings!

      // TOP NORTH OUTER WALL (Yellow rectangle at top, flush with north stalls at Z=146.5)
      // Spans from West Outer Wall (X=47.5) to East Outer Wall (X=152.5), width = 109m
      { x: 100.0, z: 146.5, width: 109.0, depth: 4.0, height: wallH },

      // LEFT WEST OUTER WALL (Yellow rectangle on left, flush with West Plaza stalls at X=47.5)
      // Spans from North Wall (Z=146.5) to South Wall (Z=60.0), depth = 90.5m
      { x: 47.5, z: 103.25, width: 4.0, depth: 90.5, height: wallH },

      // RIGHT EAST OUTER WALL (Yellow rectangle on right, flush with East Plaza stalls at X=152.5)
      // Spans from North Wall (Z=146.5) to South Wall (Z=60.0), depth = 90.5m
      { x: 152.5, z: 103.25, width: 4.0, depth: 90.5, height: wallH },

      // BOTTOM SOUTH-WEST WALL (Yellow rectangle at bottom-left, flush with entrance at Z=60.0)
      // Spans from West Outer Wall (X=47.5) to South Avenue (X=93.5), width = 50m
      { x: 70.5, z: 60.0, width: 50.0, depth: 4.0, height: wallH },

      // BOTTOM SOUTH-EAST WALL (Yellow rectangle at bottom-right, flush with entrance at Z=60.0)
      // Spans from South Avenue (X=106.5) to East Outer Wall (X=152.5), width = 50m
      { x: 129.5, z: 60.0, width: 50.0, depth: 4.0, height: wallH },
    ];
  }

  /**
   * Constructs the complete layout group with all stalls, brick walls, and eaves.
   */
  public static buildLayoutGroup(): THREE.Group {
    const root = new THREE.Group();
    root.name = 'custom_market_layout';

    const wallMat = new THREE.MeshStandardMaterial({
      color: SCENE_COLORS.wallBrickColor,
      roughness: 0.85,
    });

    const roofTileMat = new THREE.MeshStandardMaterial({
      color: 0x3d3a45,
      roughness: 0.5,
    });

    // 1. Build Walls
    const walls = this.getWalls();
    for (const w of walls) {
      const wallGeo = new THREE.BoxGeometry(w.width, w.height, w.depth);
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(w.x, w.height / 2, w.z);
      wall.receiveShadow = true;
      wall.castShadow = true;
      wall.userData = { isWall: true };
      root.add(wall);

      // Add roof eave
      const eaveGeo = new THREE.BoxGeometry(w.width + 0.6, 0.25, w.depth + 0.6);
      const eave = new THREE.Mesh(eaveGeo, roofTileMat);
      eave.position.set(w.x, w.height, w.z);
      root.add(eave);
    }

    // 2. Build Stalls
    const stalls = this.getStalls();
    for (const s of stalls) {
      const stallMesh = ChunkBuilder.buildStall(
        {
          x: s.x,
          z: s.z,
          rotationY: s.rotY,
          stallType: s.type ?? 'general',
          canopyColor: SCENE_COLORS.tentRoofColor,
          hasLantern: true,
        },
        undefined,
        false
      );
      root.add(stallMesh);
    }

    // 3. Central Lao Wang Pavilion Landmark Stall at pink square in North Plaza (x=100, z=124)
    const centralPavilion = ChunkBuilder.buildLaoWangLandmark();
    // Central pavilion faces South towards player entering the north plaza
    centralPavilion.position.set(100.0, 0, 124.0);
    centralPavilion.rotation.y = 0;
    root.add(centralPavilion);

    return root;
  }
}
