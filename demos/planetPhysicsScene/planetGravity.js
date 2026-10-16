// Shared numbers for the Box2D planet. World gravity is zero; G is the pull.

export const N = 2048;
export const CELL = 16;
export const RADIUS = 1024;
export const G = 3333;
export const CX = (N >> 1) * CELL;
export const CY = CX;
export const PARTICLE_R = 6;
export const PARTICLE_MASS = 4 * PARTICLE_R * PARTICLE_R;
