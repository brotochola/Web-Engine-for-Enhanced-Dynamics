// Shape + gravity constants for the Box2D planet. The grid and every terrain
// algorithm come from destructibleTerrainScene/worldGrid.js; this file only
// decides where the disk sits and how hard it pulls.
// World gravity is zero; G is the radial pull toward (CX, CY).

import { COLS } from '../destructibleTerrainScene/worldGrid.js';

export const N = COLS;
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
