/**
 * NpcAim: which NPC the player is looking at (crosshair in the screen centre).
 * Works on NPC positions from the server's CHUNK_LOAD, so it does not depend on which 3D model is drawn.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface AimTarget extends Vec3Like {
  id: string;
}

/** NPC positions are on the ground; aim at roughly chest/head height. */
export const NPC_AIM_HEIGHT = 1.4;
export const AIM_MAX_DISTANCE = 12;
export const AIM_RADIUS = 0.9;

/**
 * Returns the id of the nearest NPC whose aim point lies within `radius` of the view ray, or null.
 * `direction` must be normalised.
 */
export function pickAimedNpc(
  origin: Vec3Like,
  direction: Vec3Like,
  npcs: Iterable<AimTarget>,
  maxDistance: number = AIM_MAX_DISTANCE,
  radius: number = AIM_RADIUS
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const npc of npcs) {
    const vx = npc.x - origin.x;
    const vy = npc.y + NPC_AIM_HEIGHT - origin.y;
    const vz = npc.z - origin.z;
    // Distance along the ray, then distance from the ray to the aim point.
    const along = vx * direction.x + vy * direction.y + vz * direction.z;
    if (!(along > 0) || along > maxDistance) continue;
    const offRaySq = vx * vx + vy * vy + vz * vz - along * along;
    if (offRaySq <= radius * radius && along < bestDistance) {
      best = npc.id;
      bestDistance = along;
    }
  }
  return best;
}
