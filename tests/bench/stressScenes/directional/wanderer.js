import WEED from '/src/index.js';

const { GameObject, Component, SpriteRenderer, DirectionalSprite } = WEED;

const WALKS = ['walk_up', 'walk_left', 'walk_down', 'walk_right'];

/** A wanderer's heading (radians), its speed (px a frame) and, for the hand selector, the direction it drew last. */
export class WanderState extends Component {
  static ARRAY_SCHEMA = {
    heading: Float32Array,
    turn: Float32Array,
    speed: Float32Array,
    lastDir: Uint8Array,
  };
}

/** Predator's selector before DirectionalSprite: the velocity's octant by comparisons (up, left, down, right). */
function octant(vx, vy) {
  const ax = vx < 0 ? -vx : vx;
  const ay = vy < 0 ? -vy : vy;
  if (ay >= ax) return vy >= 0 ? 2 : 0;
  return vx >= 0 ? 3 : 1;
}

/** The world wanderers wrap in (the scene sets it). */
export const WORLD = { w: 1920, h: 1080 };

/** One frame's walk along (vx, vy), wrapped at the world's edges. */
function wander(i, vx, vy) {
  let x = WEED.Transform.x[i] + vx;
  let y = WEED.Transform.y[i] + vy;
  if (x < 0) x += WORLD.w;
  else if (x >= WORLD.w) x -= WORLD.w;
  if (y < 0) y += WORLD.h;
  else if (y >= WORLD.h) y -= WORLD.h;
  WEED.Transform.x[i] = x;
  WEED.Transform.y[i] = y;
}

/** Walks a slow curve across the world and wraps at its edges. The hand selector picks its frame in its tick. */
export class HandWanderer extends GameObject {
  static components = [SpriteRenderer, WanderState];

  onSpawned({ x = 0, y = 0, heading = 0, turn = 0.01, pace = 1 } = {}) {
    this.setSpritesheet('civil1');
    this.setScale(0.5);
    this.x = x;
    this.y = y;
    const s = this.wanderState;
    s.heading = heading;
    s.turn = turn;
    s.speed = pace;
    s.lastDir = 255;
    this.setAnimation('walk_down');
  }

  tick() {
    const i = this.index;
    const h = WanderState.heading[i] + WanderState.turn[i];
    WanderState.heading[i] = h;
    const vx = Math.cos(h) * WanderState.speed[i];
    const vy = Math.sin(h) * WanderState.speed[i];
    wander(i, vx, vy);
    const d = octant(vx, vy);
    if (d !== WanderState.lastDir[i]) {
      WanderState.lastDir[i] = d;
      this.setAnimation(WALKS[d]);
    }
  }
}

/** The same walk; DirectionalSprite picks its frame from where it moved, after the ticks. */
export class DirectionalWanderer extends GameObject {
  static components = [DirectionalSprite, WanderState];

  onSpawned({ x = 0, y = 0, heading = 0, turn = 0.01, pace = 1, margin = -1 } = {}) {
    this.setSpritesheet('civil1');
    this.setScale(0.5);
    this.x = x;
    this.y = y;
    const s = this.wanderState;
    s.heading = heading;
    s.turn = turn;
    s.speed = pace;
    this.directionalSprite.facingFrom = 'velocity';
    if (margin >= 0) this.directionalSprite.turnMargin = margin;
    this.setAnimation('walk');
  }

  tick() {
    const i = this.index;
    const h = WanderState.heading[i] + WanderState.turn[i];
    WanderState.heading[i] = h;
    wander(i, Math.cos(h) * WanderState.speed[i], Math.sin(h) * WanderState.speed[i]);
  }
}
