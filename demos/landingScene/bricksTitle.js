// bricksTitle.js – the landing page's title: the words built from Box2D bricks.
//
// Each brick's own tick pulls it to its place with a spring, so the words wobble when something knocks them, and the
// pointer pushes the bricks aside. The page blasts them (BrickState.mode = KICK): they spin away, fall, pile up on the
// ground and fly home through everything; the nearest ones burn in burningBoxesScene's fire for a while. Bricks at
// rest at home stop pulling, so Box2D sleeps them.

import { FIRE_HEAT } from '../burningBoxesScene/fireLayer.js';

const { GameObject, Component, RigidBody, Collider, SpriteRenderer, ParticleEmitter, Mouse } = WEED;

/** Pool size: the words take as many as fit, with bricks as small as the screen allows. */
export const MAX_BRICKS = 12000;
/** The words, wide screens and narrow ones. */
const LINES_WIDE = ['WEB ENGINE FOR', 'ENHANCED DYNAMICS'];
const LINES_NARROW = ['WEB', 'ENGINE FOR', 'ENHANCED', 'DYNAMICS'];
/** The WeedJS logo's colors (server/devBanner.js, the browser's printLogo): leaf green to yellow. */
export const WORD_COLORS = [0x28dc46, 0xa0f03c, 0xffe646];
/** The layers a brick feeds: its trail dots, and the fire while it burns. */
export const TRAILS_LAYER = 'trails';
export const FIRE_LAYER = 'fire';

// A brick's modes (BrickState.mode).
const HOME = 0; // held at its place by the stiff spring
export const KICK = 1; // the page blasted it: its next tick takes the kick
const FREE = 2; // loose: falls under its own gravity and collides, for `timer` ms
const RETURN = 3; // flies home through everything on the soft spring
// Collision layers. The word ignores itself (bricks at home that knocked each other kept the word boiling): only loose
// bricks hit it. Loose bricks hit everything, the walls included.
const HOME_LAYER = 1;
const LOOSE_LAYER = 2;
const HOME_MASK = 1 << LOOSE_LAYER;
const LOOSE_MASK = 0xffffffff;
/** Flying home: a bit no body has. Not 0, which Box2D's glue reads as "every layer". */
const GHOST_MASK = 1 << 31;
/** Gravity while loose (px/s²). The world has none, so the word floats. */
const GRAVITY = 2400;
/** Springs (1/s², 1/s). Home is underdamped, so a knock makes the word wobble; the way back is nearly critical. */
const HOME_K = 260;
const HOME_C = 16;
const BACK_K = 42;
const BACK_C = 11.5;
const SPIN_K = 140;
const SPIN_C = 16;
/** A brick moving faster than this (px/s) leaves a trail. */
const TRAIL_SPEED = 380;
/** A brick at home this close (px) and this slow (px/s), with the pointer away, stops pulling: Box2D lets it sleep. */
const REST_DISTANCE = 0.4;
const REST_SPEED = 3;

/** Per brick, in shared memory: a brick's tick can run on any logic worker, and the page writes the blasts. */
export class BrickState extends Component {
  static ARRAY_SCHEMA = {
    homeX: Float32Array,
    homeY: Float32Array,
    mode: Uint8Array,
    timer: Float32Array,
    kickX: Float32Array,
    kickY: Float32Array,
    spin: Float32Array,
    burn: Float32Array, // ms of fire left; the page lights it, the brick's tick puts it out
  };
}


/** A burning brick is drawn with the entities and fed to the fire layer as a hot body. */
const BURNING_LAYERS = ['entities', FIRE_LAYER];
const PLAIN_LAYERS = ['entities'];

/** The trail dot a fast brick leaves, one config per worker. */
const TRAIL = {
  layer: TRAILS_LAYER,
  count: 1,
  x: 0,
  y: 0,
  angleXY: { min: 0, max: 360 },
  speed: { min: 0, max: 0.3 },
  lifespan: { min: 220, max: 460 },
  scale: { from: 0.6, to: 0 },
  alpha: { from: 0.7, to: 0 },
  tint: { from: 0xffffff, to: 0xffffff },
  texture: '_whiteCircle',
};

export class Brick extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, BrickState];

  onSpawned({ homeX = 0, homeY = 0, size = 10, color = 0xffffff } = {}) {
    const i = this.index;
    BrickState.homeX[i] = homeX;
    BrickState.homeY[i] = homeY;
    BrickState.mode[i] = RETURN; // it flies in from where it spawned
    BrickState.timer[i] = 0;
    BrickState.kickX[i] = 0;
    BrickState.kickY[i] = 0;
    BrickState.spin[i] = 0;
    BrickState.burn[i] = 0;
    const side = size * 0.86; // a gap between neighbours: at home they never touch
    this.collider.width = side;
    this.collider.height = side;
    this.collider.friction = 0.5;
    this.collider.restitution = 0.25;
    this.collider.collisionLayer = HOME_LAYER;
    this.collider.collisionMask = GHOST_MASK; // flying home
    this.rigidBody.linearDamping = 0.15;
    this.rigidBody.angularDamping = 0.6;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setScale(side / 8);
    this.setTint(color);
  }

  tick(dtRatio, deltaTimeMs) {
    const i = this.index;
    if (BrickState.burn[i] > 0) this.burn(i, deltaTimeMs);
    let mode = BrickState.mode[i];
    if (mode === KICK) {
      this.addVelocity(BrickState.kickX[i], BrickState.kickY[i]);
      this.angularVelocity = BrickState.spin[i];
      this.collider.collisionLayer = LOOSE_LAYER;
      this.collider.collisionMask = LOOSE_MASK;
      BrickState.mode[i] = mode = FREE;
    }
    const vx = this.vx;
    const vy = this.vy;
    if (mode === FREE) {
      this.addAcceleration(0, GRAVITY);
      const left = BrickState.timer[i] - deltaTimeMs;
      BrickState.timer[i] = left;
      if (left <= 0) {
        BrickState.mode[i] = RETURN;
        this.collider.collisionMask = GHOST_MASK;
      }
      this.trail(vx, vy);
      return;
    }
    const dx = BrickState.homeX[i] - this.x;
    const dy = BrickState.homeY[i] - this.y;
    const k = mode === HOME ? HOME_K : BACK_K;
    const c = mode === HOME ? HOME_C : BACK_C;
    let ax = k * dx - c * vx;
    let ay = k * dy - c * vy;
    // The pointer pushes the bricks around it aside.
    let pushed = false;
    if (Mouse.isPresent) {
      const reach = this.config.worldHeight * 0.11;
      const px = this.x - Mouse.x;
      const py = this.y - Mouse.y;
      const d2 = px * px + py * py;
      if (d2 < reach * reach && d2 > 1) {
        const d = Math.sqrt(d2);
        const push = (1 - d / reach) * 14000;
        ax += (px / d) * push;
        ay += (py / d) * push;
        pushed = true;
      }
    }
    // At rest at home: no pull, so Box2D puts the brick to sleep (thousands of awake springs cost the physics worker).
    // A pull, the pointer or a loose brick's hit wakes it.
    if (
      mode === HOME &&
      !pushed &&
      dx * dx + dy * dy < REST_DISTANCE * REST_DISTANCE &&
      vx * vx + vy * vy < REST_SPEED * REST_SPEED &&
      Math.abs(this.rotation) < 0.02 &&
      Math.abs(this.angularVelocity) < 0.05
    ) {
      return;
    }
    this.addAcceleration(ax, ay);
    RigidBody.angularAccel[i] = -SPIN_K * this.rotation - SPIN_C * this.angularVelocity;
    if (mode === RETURN) {
      if (dx * dx + dy * dy < 9 && vx * vx + vy * vy < 3600) {
        BrickState.mode[i] = HOME;
        this.collider.collisionLayer = HOME_LAYER;
        this.collider.collisionMask = HOME_MASK;
      }
      this.trail(vx, vy);
    }
  }

  /** Lights the brick for the fire layer, and puts it out when its time is up. */
  burn(i, deltaTimeMs) {
    if ((this.getFeedBits() & FIRE_HEAT) === 0) {
      this.setLayers(BURNING_LAYERS);
      this.setFeedBits(FIRE_HEAT);
    }
    const left = BrickState.burn[i] - deltaTimeMs;
    if (left > 0) {
      BrickState.burn[i] = left;
      return;
    }
    BrickState.burn[i] = 0;
    this.setFeedBits(0);
    this.setLayers(PLAIN_LAYERS);
  }

  trail(vx, vy) {
    // Every other brick: thousands fly home at once.
    if ((this.index & 1) !== 0 || vx * vx + vy * vy < TRAIL_SPEED * TRAIL_SPEED) return;
    TRAIL.x = this.x;
    TRAIL.y = this.y;
    const tint = this.tint;
    TRAIL.tint.from = tint;
    TRAIL.tint.to = tint;
    TRAIL.scale.from = this.collider.width * 0.08;
    ParticleEmitter.emitGpu(TRAIL);
  }
}


/** a to b, 0..1, per channel. */
function mixColor(a, b, t) {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

function gradient(t) {
  const span = WORD_COLORS.length - 1;
  const at = Math.min(span - 1e-6, Math.max(0, t * span));
  const k = Math.floor(at);
  return mixColor(WORD_COLORS[k], WORD_COLORS[k + 1], at - k);
}


/**
 * Page only: draws the words on a canvas the size of the world and keeps one brick per grid cell that falls on a
 * letter, with cells as small as MAX_BRICKS allows. Narrow screens get more lines.
 * @returns {{ size: number, bricks: { x: number, y: number, color: number }[] }}
 */
export function layoutWord(width, height) {
  const portrait = width < height * 0.9;
  const lines = portrait ? LINES_NARROW : LINES_WIDE;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const font = (px) => `900 ${px}px "Arial Black", "Segoe UI Black", "Helvetica Neue", system-ui, sans-serif`;
  g.font = font(100);
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, g.measureText(line).width);
  const lineStep = 0.92; // line height, in font sizes
  const boxW = width * (portrait ? 0.9 : 0.86);
  const boxH = height * (portrait ? 0.44 : 0.36);
  const px = Math.floor(100 * Math.min(boxW / widest, boxH / (0.75 + lineStep * (lines.length - 1))));
  const centerY = height * (portrait ? 0.34 : 0.4);
  g.font = font(px);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  for (let k = 0; k < lines.length; k++) {
    g.fillText(lines[k], width / 2, centerY + (k - (lines.length - 1) / 2) * px * lineStep);
  }
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const filled = (x, y) => pixels[(Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 3] > 127;

  let size = Math.max(3, Math.min(width, height) / 260);
  let cells = [];
  for (;;) {
    cells = [];
    for (let y = size / 2; y < height; y += size) {
      for (let x = size / 2; x < width; x += size) {
        if (filled(x, y)) cells.push(x, y);
      }
    }
    if (cells.length / 2 <= MAX_BRICKS) break;
    size *= 1.06;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < cells.length; k += 2) {
    minX = Math.min(minX, cells[k]);
    maxX = Math.max(maxX, cells[k]);
    minY = Math.min(minY, cells[k + 1]);
    maxY = Math.max(maxY, cells[k + 1]);
  }
  const bricks = [];
  for (let k = 0; k < cells.length; k += 2) {
    const x = cells[k];
    const y = cells[k + 1];
    // The logo's diagonal bands, green, yellow, green, yellow, green from top left to bottom right.
    const band = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((x - minX) / (maxX - minX || 1) + (y - minY) / (maxY - minY || 1)));
    const base = gradient(band);
    // A little light and dark per brick, so the letters read as built, not painted.
    const shade = Math.random();
    const color = shade < 0.5 ? mixColor(base, 0x000000, (0.5 - shade) * 0.35) : mixColor(base, 0xffffff, (shade - 0.5) * 0.3);
    bricks.push({ x, y, color });
  }
  return { size, bricks };
}

