// Shared numbers for the Box2D planet. World gravity is zero; G is the pull.
// The grid is the square in worldGrid.js. The disk is PLANET_DIAMETER of that width.

import { COLS, PLANET_RADIUS } from './worldGrid.js';

export const N = COLS;
export const CELL = 16;
export const RADIUS = PLANET_RADIUS;
export const G = 3333;
export const CX = (N >> 1) * CELL;
export const CY = CX;
export const PARTICLE_R = 6;
export const PARTICLE_MASS = 4 * PARTICLE_R * PARTICLE_R;
