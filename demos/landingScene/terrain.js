// terrain.js – the landing page's ground: one height profile across the six chapters (hills under the title, a cliff
// and a lake, a valley, a ravine with a pond between two posts, a camp, a last hill). The landscape shader draws it
// from TerrainMap's heights; one Box2D chain makes it solid.

const { GameObject, RigidBody, Collider, SharedResource } = WEED;

/** World px between two height samples: the heights texture's texels. */
export const TERRAIN_STEP = 8;
/** World px between two points of the ground's chain. */
const CHAIN_STEP = 12;

/**
 * The ground, as [x in chapters (one screen width each), y as a fraction of the screen's height], left to right.
 * Neighbouring points are joined with a smoothstep, so a pair close together makes a cliff.
 */
const PROFILE = [
  [0, 0.8], [0.2, 0.765], [0.48, 0.815], [0.76, 0.775], [1.04, 0.8],
  // the cliff the waterfall pours from, then the lake's basin
  [1.12, 0.6], [1.16, 0.515], [1.3, 0.5], [1.33, 0.93], [1.5, 0.965], [1.74, 0.955], [1.9, 0.79],
  // the soft bodies' valley
  [2.22, 0.855], [2.56, 0.835], [2.84, 0.785],
  // the ropes: a post on each side of a ravine with a pond
  [3.14, 0.735], [3.3, 0.775], [3.37, 0.935], [3.63, 0.945], [3.7, 0.775], [3.86, 0.735],
  // the camp
  [4.12, 0.82], [4.5, 0.835], [4.88, 0.815],
  // under the hood
  [5.3, 0.77], [5.68, 0.79], [6, 0.8],
];

/** Ground y (world px) at world x, for a world of `width` px per chapter and `height` px. */
export function groundY(x, width, height) {
  const c = x / width;
  let k = 0;
  while (k < PROFILE.length - 2 && PROFILE[k + 1][0] <= c) k++;
  const [c0, y0] = PROFILE[k];
  const [c1, y1] = PROFILE[k + 1];
  const t = Math.min(1, Math.max(0, (c - c0) / (c1 - c0)));
  const s = t * t * (3 - 2 * t);
  // A small ripple, so no stretch of ground is a perfect curve.
  const ripple = 3 * Math.sin(x * 0.013) + 2 * Math.sin(x * 0.031 + 1.7);
  return (y0 + (y1 - y0) * s) * height + ripple;
}

/**
 * The ground's heights, one rgba8 texel per TERRAIN_STEP px, the height as a 16-bit fraction of the world's height
 * in r (high byte) and g: what the landscape shader draws, on WebGL and WebGPU alike. Writer: the page, once.
 */
export class TerrainMap extends SharedResource {}

export function terrainSamples(worldWidth) {
  return Math.ceil(worldWidth / TERRAIN_STEP) + 2;
}

/** TerrainMap's schema for a world this wide, for the scene's sharedResources. */
export function terrainSchema(worldWidth) {
  return { heights: { type: Uint8Array, length: terrainSamples(worldWidth) * 4 } };
}

/** Page only: fills TerrainMap.heights for a world `height` px high. */
export function writeHeights(worldWidth, width, height) {
  const texels = TerrainMap.heights;
  const n = terrainSamples(worldWidth);
  for (let i = 0; i < n; i++) {
    const y = Math.min(1, Math.max(0, groundY(i * TERRAIN_STEP, width, height) / height));
    const v = Math.round(y * 65535);
    texels[i * 4] = v >> 8;
    texels[i * 4 + 1] = v & 255;
    texels[i * 4 + 2] = 0;
    texels[i * 4 + 3] = 255;
  }
}

/** The ground's chain points in world px, with a point past each end of the world (an open chain's end points do not
 *  collide). */
export function groundChain(worldWidth, width, height) {
  const n = Math.ceil(worldWidth / CHAIN_STEP) + 1;
  const xy = new Float32Array((n + 2) * 2);
  xy[0] = -200;
  xy[1] = groundY(0, width, height);
  for (let i = 0; i < n; i++) {
    const x = Math.min(worldWidth, i * CHAIN_STEP);
    xy[2 + i * 2] = x;
    xy[3 + i * 2] = groundY(x, width, height);
  }
  xy[2 + n * 2] = worldWidth + 200;
  xy[3 + n * 2] = groundY(worldWidth, width, height);
  return xy;
}

/** The chain's point count for a world this wide, for physics.maxChainPoints. */
export function groundChainPoints(worldWidth) {
  return Math.ceil(worldWidth / CHAIN_STEP) + 3;
}

/** The ground: one static chain at the world's origin. */
export class Ground extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({ chain = null } = {}) {
    this.rigidBody.static = 1;
    this.collider.friction = 0.8;
    this.collider.restitution = 0.1;
    if (chain) this.collider.setChain(chain, chain.length / 2, false);
  }
}

/** The world's sides and top, so loose things stay in it. */
export class Wall extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned() {
    this.rigidBody.static = 1;
    this.collider.friction = 0.7;
    this.collider.restitution = 0.2;
  }
}
