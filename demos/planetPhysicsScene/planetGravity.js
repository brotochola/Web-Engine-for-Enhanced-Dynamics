// Shape + gravity constants for the Box2D planet. The grid and every terrain
// algorithm come from destructibleTerrainScene/worldGrid.js; this file only
// decides where the disk sits and how hard it pulls.
// World gravity is zero; G is the radial pull toward (CX, CY).

/** Square grid side in cells. Its own number: it used to be the flat level's COLS. */
export const N = 900;
export const CELL = 10;
/** Circle diameter as a fraction of the square grid. The rest is empty margin. */
export const PLANET_DIAMETER = 0.66;
export const RADIUS = Math.round((N * PLANET_DIAMETER) / 2);
/** Same magnitude as the terrain scene's world gravity, but radial. */
export const G = 1800;
export const CX = (N >> 1) * CELL;
export const CY = CX;
export const PARTICLE_R = 6;
export const PARTICLE_MASS = 4 * PARTICLE_R * PARTICLE_R;
/** Ship spawn, east of the disk and 120 px off its surface. The boot camera starts here. */
export const SHIP_SPAWN_X = CX + RADIUS * CELL + 120;
export const SHIP_SPAWN_Y = CY;
/** Top of the disk (north pole), in world px. */
export const SURFACE_Y = CY - RADIUS * CELL;

/**
 * Pull toward the core: the unit vector from (x, y) to (CX, CY), times G,
 * into out.x / out.y. PlanetPull keeps its own inline copy: through `out`
 * the per-particle loop measured 4 % slower (review R11).
 */
export function radialPull(x, y, out) {
  const dx = CX - x;
  const dy = CY - y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  out.x = (dx / len) * G;
  out.y = (dy / len) * G;
  return out;
}

/**
 * Camera angle (radians) that keeps the planet's local "up" at the top of the
 * screen. Local up is the outward radial, so the whole disk turns under the
 * view as the ship travels around it. Matches Camera.worldToScreen, which
 * maps world deltas through R(rotation).
 */
export function radialCameraAngle(x, y) {
  const a = Math.atan2(y - CY, x - CX); // outward radial
  return -Math.PI / 2 - a;
}
