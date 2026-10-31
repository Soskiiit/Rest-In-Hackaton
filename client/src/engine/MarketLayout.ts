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
  public static getWalls(): LayoutWallItem[] {
    const wallH = 8.5;
    return [
      // 1. South Entrance Avenue walls
      { x: 92.5, z: 78.0, width: 5.0, depth: 36.0, height: wallH }, // behind west stalls
      { x: 107.5, z: 78.0, width: 5.0, depth: 36.0, height: wallH }, // behind east stalls

      // 2. West corridor walls
      { x: 84.0, z: 107.5, width: 24.0, depth: 5.0, height: wallH }, // south corridor wall
      { x: 83.0, z: 92.5, width: 22.0, depth: 5.0, height: wallH },  // north corridor wall

      // West Plaza perimeter walls
      { x: 46.5, z: 100.0, width: 5.0, depth: 24.0, height: wallH }, // west exterior wall
      { x: 60.0, z: 86.5, width: 26.0, depth: 5.0, height: wallH },  // north exterior wall
      { x: 60.0, z: 113.5, width: 26.0, depth: 5.0, height: wallH }, // south exterior wall

      // 3. East corridor walls
      { x: 116.0, z: 107.5, width: 24.0, depth: 5.0, height: wallH }, // south corridor wall
      { x: 117.0, z: 92.5, width: 22.0, depth: 5.0, height: wallH },  // north corridor wall

      // East Plaza perimeter walls
      { x: 153.5, z: 100.0, width: 5.0, depth: 24.0, height: wallH }, // east exterior wall
      { x: 140.0, z: 86.5, width: 26.0, depth: 5.0, height: wallH },  // north exterior wall
      { x: 140.0, z: 113.5, width: 26.0, depth: 5.0, height: wallH }, // south exterior wall

      // 4. Large North Plaza perimeter walls
      { x: 78.5, z: 125.0, width: 5.0, depth: 38.0, height: wallH },  // west plaza wall
      { x: 121.5, z: 125.0, width: 5.0, depth: 38.0, height: wallH }, // east plaza wall
      { x: 100.0, z: 147.5, width: 44.0, depth: 5.0, height: wallH }, // north back wall

      // 5. Outer Perimeter Fortress Walls (matching user diagram yellow rectangles)
      // North outer wall across top (Z=180, X from 20 to 180)
      { x: 100.0, z: 180.0, width: 164.0, depth: 4.0, height: wallH },
      // West outer wall (X=20, Z from 22 to 180)
      { x: 20.0, z: 101.0, width: 4.0, depth: 160.0, height: wallH },
      // East outer wall (X=180, Z from 22 to 180)
      { x: 180.0, z: 101.0, width: 4.0, depth: 160.0, height: wallH },
      // South-West outer wall with entrance gate gap (Z=22, X from 20 to 95)
      { x: 57.5, z: 22.0, width: 75.0, depth: 4.0, height: wallH },
      // South-East outer wall with entrance gate gap (Z=22, X from 105 to 180)
      { x: 142.5, z: 22.0, width: 75.0, depth: 4.0, height: wallH },
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
