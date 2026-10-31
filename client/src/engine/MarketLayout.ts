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
   * Stalls are placed along the corridors and plazas facing inwards into the walkway,
   * with space behind them for vendor NPCs.
   */
  public static getStalls(): LayoutStallItem[] {
    const stalls: LayoutStallItem[] = [];
    const stallTypes: StallType[] = ['tea', 'food', 'jade', 'noodles', 'scrolls', 'herbs', 'weapons', 'general'];
    let typeIdx = 0;

    const addStall = (x: number, z: number, rotY: number) => {
      // Exclude any stalls near the central crossroads walkway (around x=96..106, z=102..107)
      if (
        (Math.abs(x - 96.0) < 3.5 && Math.abs(z - 104.5) < 3.5) ||
        (Math.abs(x - 104.5) < 3.5 && Math.abs(z - 96.0) < 3.5) ||
        (x >= 92.0 && x <= 108.0 && z >= 93.0 && z <= 107.0)
      ) {
        return;
      }

      stalls.push({
        x,
        z,
        rotY,
        type: stallTypes[typeIdx++ % stallTypes.length],
      });
    };

    // -------------------------------------------------------------------------
    // 1. SOUTH ENTRANCE AVENUE (Player walks North towards Z=100)
    // Left row at X=96.0 (facing East towards center: rotY = -Math.PI / 2)
    // Right row at X=104.0 (facing West towards center: rotY = Math.PI / 2)
    // Ends at z=91.5 so it leaves the entrance to West/East side corridors completely open!
    // -------------------------------------------------------------------------
    for (let z = 62; z <= 91.5; z += 3.6) {
      addStall(96.0, z, -Math.PI / 2);
      addStall(104.0, z, Math.PI / 2);
    }

    // -------------------------------------------------------------------------
    // 2. WEST CORRIDOR & WEST SQUARE PLAZA
    // -------------------------------------------------------------------------
    // West Corridor (along North & South walls, wide unobstructed walkway along Z=100)
    // South row (Z=104.5) stops at x=91.0 to leave the crossroads corner completely open
    for (let x = 74; x <= 91.0; x += 3.6) {
      addStall(x, 104.5, 0); // South row facing North
    }
    // North row (Z=95.5) stops at x=78.5 to not jut out into the passage
    for (let x = 74; x <= 78.5; x += 3.6) {
      addStall(x, 95.5, Math.PI); // North row facing South
    }

    // West Square Plaza (around X=60, Z=100)
    // Stalls strictly along walls:
    // West wall: X=50, facing East
    for (let z = 92; z <= 108; z += 3.6) {
      addStall(50.0, z, -Math.PI / 2);
    }
    // North wall of West Plaza (Z=90, facing South)
    for (let x = 53.6; x <= 68.0; x += 3.6) {
      addStall(x, 89.5, Math.PI);
    }
    // South wall of West Plaza (Z=110, facing North)
    for (let x = 53.6; x <= 68.0; x += 3.6) {
      addStall(x, 110.5, 0);
    }

    // -------------------------------------------------------------------------
    // 3. EAST CORRIDOR & EAST SQUARE PLAZA
    // -------------------------------------------------------------------------
    // East Corridor (along North & South walls, wide unobstructed walkway along Z=100)
    // South row (Z=104.5) starts at x=109.0 so it doesn't obstruct the crossroads corner
    for (let x = 109.0; x <= 126; x += 3.6) {
      addStall(x, 104.5, 0); // South row facing North
    }
    // North row (Z=95.5) starts at x=121.5 so it doesn't jut out into the passage
    for (let x = 121.5; x <= 126; x += 3.6) {
      addStall(x, 95.5, Math.PI); // North row facing South
    }

    // East Square Plaza (around X=140, Z=100)
    // Stalls strictly along walls:
    // East wall: X=150, facing West
    for (let z = 92; z <= 108; z += 3.6) {
      addStall(150.0, z, Math.PI / 2);
    }
    // North wall of East Plaza (Z=90, facing South)
    for (let x = 132.0; x <= 146.4; x += 3.6) {
      addStall(x, 89.5, Math.PI);
    }
    // South wall of East Plaza (Z=110, facing North)
    for (let x = 132.0; x <= 146.4; x += 3.6) {
      addStall(x, 110.5, 0);
    }

    // -------------------------------------------------------------------------
    // 4. LARGE NORTH SQUARE PLAZA (Giant Bazaar matching blueprint top)
    // Stalls arranged around perimeter facing inwards
    // -------------------------------------------------------------------------
    // West vertical row (X=82, Z from 106 to 142, facing East: rotY = -Math.PI / 2)
    for (let z = 106; z <= 142; z += 3.6) {
      addStall(82.0, z, -Math.PI / 2);
    }
    // East vertical row (X=118, Z from 106 to 142, facing West: rotY = Math.PI / 2)
    for (let z = 106; z <= 142; z += 3.6) {
      addStall(118.0, z, Math.PI / 2);
    }
    // North top row (Z=144, facing South: rotY = Math.PI)
    // Left side stalls along North wall (X from 85.0 to 97.0)
    for (let x = 85.0; x <= 97.0; x += 3.6) {
      addStall(x, 144.0, Math.PI);
    }
    // Right side stalls along North wall (X from 106.0 to 115.0)
    // Clears the central walkthrough aisle at x=100..105 so nothing blocks the path
    for (let x = 106.5; x <= 115.0; x += 3.6) {
      addStall(x, 144.0, Math.PI);
    }

    return stalls;
  }

  /**
   * Generates solid brick building walls forming the outer perimeter of the buildings
   * with a comfortable passage behind every stall row where NPCs stand:
   *
   * South Avenue: Stalls at X=96 and X=104 -> Walls at X=93.5 and X=106.5 (2.5m gap for NPC)
   * West Corridor: Stalls at Z=104 and Z=96 -> Walls at Z=106.5 and Z=93.5 (2.5m gap for NPC)
   * East Corridor: Stalls at Z=104 and Z=96 -> Walls at Z=106.5 and Z=93.5 (2.5m gap for NPC)
   * West Plaza: Outer walls at X=47.5, Z=87.5, Z=112.5 (2.5m gap for NPC)
   * East Plaza: Outer walls at X=152.5, Z=87.5, Z=112.5 (2.5m gap for NPC)
   * North Plaza: Outer walls at X=79.5, X=120.5, Z=146.5 (2.5m gap for NPC)
   * Top/Side Outer Yellow Walls: Buttressed into complete closed buildings!
   */
  public static getWalls(): LayoutWallItem[] {
    const wallH = 8.5;
    return [
      // =======================================================================
      // 1. SOUTH ENTRANCE AVENUE WALLS (Behind the stalls at X=96.0 & X=104.0)
      // Left (West) wall at X=93.5, Z from 60 to 93.5
      { x: 93.5, z: 76.75, width: 3.0, depth: 33.5, height: wallH },
      // Right (East) wall at X=106.5, Z from 60 to 93.5
      { x: 106.5, z: 76.75, width: 3.0, depth: 33.5, height: wallH },

      // =======================================================================
      // 2. WEST CORRIDOR & WEST PLAZA INTERIOR WALLS
      // South corridor wall behind stalls: Z=106.5, X from 71.0 to 93.5
      { x: 82.25, z: 106.5, width: 22.5, depth: 3.0, height: wallH },
      // North corridor wall behind stalls: Z=93.5, X from 71.0 to 79.5
      { x: 75.25, z: 93.5, width: 8.5, depth: 3.0, height: wallH },

      // West Plaza interior walls behind perimeter stalls (at X=50, Z=90, Z=110):
      // South wall of West Plaza (Z=112.5, X from 47.5 to 71.0)
      { x: 59.25, z: 112.5, width: 23.5, depth: 3.0, height: wallH },
      // North wall of West Plaza (Z=87.5, X from 47.5 to 71.0)
      { x: 59.25, z: 87.5, width: 23.5, depth: 3.0, height: wallH },

      // =======================================================================
      // 3. EAST CORRIDOR & EAST PLAZA INTERIOR WALLS
      // South corridor wall behind stalls: Z=106.5, X from 106.5 to 129.0
      { x: 117.75, z: 106.5, width: 22.5, depth: 3.0, height: wallH },
      // North corridor wall behind stalls: Z=93.5, X from 120.5 to 129.0
      { x: 124.75, z: 93.5, width: 8.5, depth: 3.0, height: wallH },

      // East Plaza interior walls behind perimeter stalls (at X=150, Z=90, Z=110):
      // South wall of East Plaza (Z=112.5, X from 129.0 to 152.5)
      { x: 140.75, z: 112.5, width: 23.5, depth: 3.0, height: wallH },
      // North wall of East Plaza (Z=87.5, X from 129.0 to 152.5)
      { x: 140.75, z: 87.5, width: 23.5, depth: 3.0, height: wallH },

      // =======================================================================
      // 4. LARGE NORTH PLAZA WALLS (Behind stalls at X=82.0, X=118.0, Z=144.0)
      // West Plaza interior wall: X=79.5, Z from 93.5 to 146.5 (length: 53.0m)
      { x: 79.5, z: 120.0, width: 3.0, depth: 53.0, height: wallH },
      // East Plaza interior wall: X=120.5, Z from 93.5 to 146.5 (length: 53.0m)
      { x: 120.5, z: 120.0, width: 3.0, depth: 53.0, height: wallH },

      // =======================================================================
      // 5. EXTERNAL BUILDING WALLS (The Yellow Outer Enclosing Rectangles)
      // Forming the outer boundary of the market building blocks!

      // TOP NORTH OUTER WALL (Behind North Plaza stalls at Z=144 -> wall at Z=146.5)
      // Spans across the entire top from X=47.5 to X=152.5 (width: 108m)
      { x: 100.0, z: 146.5, width: 108.0, depth: 3.0, height: wallH },

      // WEST OUTER WALL (Behind West Plaza stalls at X=50 -> wall at X=47.5)
      // Spans from Z=60.0 to Z=146.5 (depth: 89.5m)
      { x: 47.5, z: 103.25, width: 3.0, depth: 89.5, height: wallH },

      // EAST OUTER WALL (Behind East Plaza stalls at X=150 -> wall at X=152.5)
      // Spans from Z=60.0 to Z=146.5 (depth: 89.5m)
      { x: 152.5, z: 103.25, width: 3.0, depth: 89.5, height: wallH },

      // BOTTOM SOUTH-WEST WALL (At entrance line Z=60.0)
      // Spans from West Outer Wall (X=47.5) to South Avenue (X=93.5) (width: 49m)
      { x: 70.5, z: 60.0, width: 49.0, depth: 3.0, height: wallH },

      // BOTTOM SOUTH-EAST WALL (At entrance line Z=60.0)
      // Spans from South Avenue (X=106.5) to East Outer Wall (X=152.5) (width: 49m)
      { x: 129.5, z: 60.0, width: 49.0, depth: 3.0, height: wallH },
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

    // 4. Overhead wires with hanging lanterns stretched from wall to wall across corridors and plazas
    const overheadStringsGroup = this.buildOverheadLanternStrings();
    root.add(overheadStringsGroup);

    return root;
  }

  /**
   * Builds overhead suspension wires/strings stretched from wall to wall
   * with glowing Chinese paper lanterns hanging above the player's head.
   */
  public static buildOverheadLanternStrings(): THREE.Group {
    const overheadGroup = new THREE.Group();
    overheadGroup.name = 'overhead_lantern_strings';

    const wireMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const wireRadius = 0.018;
    // Walls height is 8.5m, roof eave is at 8.5m; anchor wires directly near the top wall edge
    const wireAnchorHeight = 8.1;

    // Helper to create a curved catenary/sagging wire with hanging lanterns
    const addWireWithLanterns = (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      lanternCount: number,
      hasLight: boolean = false
    ) => {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const span = Math.hypot(dx, dz);

      // Sag depth scales proportionally with span: ~1.2m sag for ~13m corridors, up to ~2.2m for ~40m plaza
      const maxSag = Math.min(2.4, Math.max(1.1, span * 0.075));

      // Build a smooth curved catenary tube for the hanging wire
      const curveSegments = 24;
      const curvePoints: THREE.Vector3[] = [];
      for (let s = 0; s <= curveSegments; s++) {
        const u = s / curveSegments;
        const px = x1 + dx * u;
        const pz = z1 + dz * u;
        // Parabolic / catenary sag curve: 0 at walls (u=0, u=1), dips at u=0.5
        const sag = 4 * maxSag * u * (1 - u);
        const py = wireAnchorHeight - sag;
        curvePoints.push(new THREE.Vector3(px, py, pz));
      }

      const curve = new THREE.CatmullRomCurve3(curvePoints);
      const wireGeo = new THREE.TubeGeometry(curve, 24, wireRadius, 6, false);
      const wireMesh = new THREE.Mesh(wireGeo, wireMat);
      overheadGroup.add(wireMesh);

      // Hang lanterns along this sagging wire
      for (let i = 1; i <= lanternCount; i++) {
        const t = i / (lanternCount + 1);
        const lx = x1 + dx * t;
        const lz = z1 + dz * t;
        const sag = 4 * maxSag * t * (1 - t);
        const wireYAtPoint = wireAnchorHeight - sag;

        // Lantern hangs directly below the sagging wire via its suspension cord
        const lanternY = wireYAtPoint - 0.42;

        const lantern = ChunkBuilder.buildLantern(
          {
            x: lx,
            y: lanternY,
            z: lz,
            color: SCENE_COLORS.lanternBodyColor,
            intensity: 1.2,
            distance: 10,
          },
          undefined,
          hasLight && i % 2 === 1 // Selectively attach point lights to save GPU budget
        );
        overheadGroup.add(lantern);
      }
    };

    // -------------------------------------------------------------------------
    // 1. SOUTH ENTRANCE AVENUE: Wires stretching West-East from Wall (X=93.5) to Wall (X=106.5)
    // -------------------------------------------------------------------------
    for (let z = 65; z <= 95; z += 6.0) {
      addWireWithLanterns(93.5, z, 106.5, z, 3, z % 12 === 5);
    }

    // -------------------------------------------------------------------------
    // 2. WEST CORRIDOR: Wires stretching North-South from Wall (Z=93.5) to Wall (Z=106.5)
    // -------------------------------------------------------------------------
    for (let x = 75; x <= 93; x += 6.0) {
      addWireWithLanterns(x, 93.5, x, 106.5, 3, x % 12 === 3);
    }

    // -------------------------------------------------------------------------
    // 3. WEST SQUARE PLAZA: Wires stretching North-South from Wall (Z=87.5) to Wall (Z=112.5)
    // -------------------------------------------------------------------------
    for (let x = 52; x <= 68; x += 5.5) {
      addWireWithLanterns(x, 87.5, x, 112.5, 5, x === 63);
    }

    // -------------------------------------------------------------------------
    // 4. EAST CORRIDOR: Wires stretching North-South from Wall (Z=93.5) to Wall (Z=106.5)
    // -------------------------------------------------------------------------
    for (let x = 107; x <= 125; x += 6.0) {
      addWireWithLanterns(x, 93.5, x, 106.5, 3, x % 12 === 5);
    }

    // -------------------------------------------------------------------------
    // 5. EAST SQUARE PLAZA: Wires stretching North-South from Wall (Z=87.5) to Wall (Z=112.5)
    // -------------------------------------------------------------------------
    for (let x = 132; x <= 148; x += 5.5) {
      addWireWithLanterns(x, 87.5, x, 112.5, 5, x === 143);
    }

    // -------------------------------------------------------------------------
    // 6. CENTRAL CROSSROADS (X=100, Z=100)
    // Diagonal festive wires crisscrossing the central hub
    // -------------------------------------------------------------------------
    addWireWithLanterns(93.5, 93.5, 106.5, 106.5, 4, true);
    addWireWithLanterns(93.5, 106.5, 106.5, 93.5, 4, true);

    // -------------------------------------------------------------------------
    // 7. NORTH BAZAAR PLAZA: Wires stretching West-East from Wall (X=79.5) to Wall (X=120.5)
    // -------------------------------------------------------------------------
    for (let z = 104; z <= 142; z += 6.5) {
      addWireWithLanterns(79.5, z, 120.5, z, 7, z % 13 === 0);
    }

    return overheadGroup;
  }
}
