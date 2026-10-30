// landingScene.js – the landing page (index.html at the repo root, served by GitHub Pages).
//
// "Web Engine for Enhanced Dynamics" is built from Box2D bricks. Each brick's own tick pulls it to its place with a
// spring, so the words wobble when something knocks them, and the pointer pushes the bricks aside. A click or a tap
// sets off one of blastforgeScene's explosions there: the bricks around it spin away, fall, pile up on the floor and
// fly back, and the nearest ones burn for a while in burningBoxesScene's fire, smoke and all. Behind them the view
// flies through hyperspace: GPU particles stream out of a vanishing point that leans toward the pointer: slow far
// stars, fast comet streaks and tumbling cubes, one warp lane per logic worker (the four workers also share the
// bricks' ticks). Holding the button jumps to warp speed.
//   ?particles=<n>   the warp layers' maxParticles together (default 2 097 152, 1 048 576 on a touch screen)
//   ?backend=webgl   Pixi's WebGL backend (default WebGPU where the browser has it; the fire needs WebGPU)

import {
  explode,
  explosionAssets,
  explosionAssetsWgsl,
  explosionLayers,
  FIELD_LAYER,
  updateExplosions,
} from '../blastforgeScene/explosions.js';
import { PRESETS } from '../blastforgeScene/explosionPresets.js';
import { FIRE_HEAT, fireAssets, fireLayer } from '../burningBoxesScene/fireLayer.js';

const {
  Scene,
  GameObject,
  Component,
  RigidBody,
  Collider,
  SpriteRenderer,
  ParticleEmitter,
  GpuParticles,
  Mouse,
  Camera,
  Time,
  LAYER_KIND,
  BLEND_MODES,
  PARTICLE_EASE,
} = WEED;

function param(name, fallback) {
  const search = globalThis.location?.search;
  const value = typeof search === 'string' ? new URLSearchParams(search).get(name) : null;
  return value == null || value === '' ? fallback : value;
}

// The page's values. Workers get the scene's config from the page, and what their ticks need from the spawns.
const TOUCH = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
const PARTICLES = Math.max(65536, parseInt(param('particles', TOUCH ? '1048576' : '2097152'), 10) || 2097152);
const BACKEND = param('backend', globalThis.navigator?.gpu ? 'webgpu' : 'webgl') === 'webgl' ? 'webgl' : 'webgpu';
const WORLD_W = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1920;
const WORLD_H = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 1080;
const LANES = 4; // logic workers, one warp lane each
/** Pool size: the words take as many as fit, with bricks as small as the screen allows. */
const MAX_BRICKS = 12000;
/** The words, wide screens and narrow ones. */
const LINES_WIDE = ['WEB ENGINE FOR', 'ENHANCED DYNAMICS'];
const LINES_NARROW = ['WEB', 'ENGINE FOR', 'ENHANCED', 'DYNAMICS'];

const STARS = 'stars'; // far: slow dots
const STREAKS = 'streaks'; // near: fast comets, each turned along its way
const DEBRIS = 'debris'; // near: tumbling cubes in the word's colors
const TRAILS = 'trails';
const FIRE = 'fire';
/** The fire is a WebGPU compute layer: on WebGL the bricks blast without burning. */
const FIRE_ON = BACKEND === 'webgpu';
/** World px per fire cell: a brick spans about one. */
const FIRE_CELL = 3;
/** Bricks burning at once that the fire packs; a blast lights the nearest few hundred. */
const FIRE_BODIES = 2048;
/** How long a brick burns (ms), and how much of the blast's reach lights bricks. */
const BURN_MS = [6000, 10000];
const BURN_REACH = 0.42;
/** blastforgeScene's fuel barrel, without the parts that need its ground: dust ring, landing pieces, scorch, flames. */
const BLAST = { ...PRESETS.barrel, dust: 0, sparks: 0, debris: 0, scorch: 0, flames: 0, flameTime: 0, secondary: 0 };
/** Puffs per blast, times the preset's: a denser, softer fireball. */
const BLAST_AMOUNT = 2.5;
/** The explosion layers' texel, in world px: one, and no bands or dither (uSmooth), so the blast reads real. */
const BLAST_PIXEL = 1;
const STEP_MS = 50;
const FILL = 0.97;
const FRAME_MS = 1000 / 60; // GPU particle speeds are px per frame
/** Speeds (px per frame at unit 1), split in bands: each band's life is the time its slowest dot takes to leave the
 *  screen, so every dot fades in on its way out and none dies in view (an ease only goes one way). */
const STAR_SPEED = [1.2, 3.6];
const STAR_BANDS = 3;
const STREAK_SPEED = [5, 15];
const STREAK_BANDS = 5;
const DEBRIS_SPEED = [3, 11];
/** streak.png's length (px): a comet's scaleX is its length over this. */
const STREAK_TEXTURE_PX = 64;
/** A streak call covers 360 / SECTORS degrees and is turned to its middle. */
const SECTORS = 96;
/** How far the vanishing point follows the pointer, and the speed while the button is held. */
const LEAN = 0.3;
const WARP = 3.2;
const WARP_COLORS = [0xffffff, 0xeaffdc, 0xffffff, 0xf6ffd2, 0xffffff, 0x28dc46, 0xa0f03c, 0xffe646];
/** The WeedJS logo's colors (server/devBanner.js, the browser's printLogo): leaf green to yellow. */
const WORD_COLORS = [0x28dc46, 0xa0f03c, 0xffe646];

// A brick's modes (BrickState.mode).
const HOME = 0; // held at its place by the stiff spring
const KICK = 1; // the page blasted it: its next tick takes the kick
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

/** ms a dot at `speed` (px per frame at unit 1) takes to travel `reach` px. Page and lanes both use it. */
function warpLife(speed, unit, reach) {
  return (reach / (speed * unit)) * FRAME_MS;
}

/**
 * Each kind of warp dot: how many sectors share the circle (360 / sectors degrees per call), its speeds (px per
 * frame at unit 1) split in bands, how far past the edge it lives (px at unit 1: a comet's tail trails its center by
 * half its length), and the half size of the box it is born in around the vanishing point.
 */
const WARP_KINDS = [
  { sectors: 32, speed: STAR_SPEED, bands: STAR_BANDS, margin: 10, spawn: 6 },
  { sectors: SECTORS, speed: STREAK_SPEED, bands: STREAK_BANDS, margin: 130, spawn: 4 },
  { sectors: 32, speed: DEBRIS_SPEED, bands: 4, margin: 20, spawn: 8 },
];
const KIND_STARS = 0;
const KIND_STREAKS = 1;
const KIND_DEBRIS = 2;

/**
 * One warp lane, pinned to its own logic worker: its fields live there, its dots go to that worker's rings. It throws
 * every lanes-th sector of the stars, the streaks and the cubes.
 */
export class WarpLane extends GameObject {
  static components = [];

  onSpawned({ lane = 0, lanes = 1, cx = 0, cy = 0, unit = 1, reach = 1000 } = {}) {
    this.lane = lane;
    this.lanes = lanes;
    this.cx = cx; // where the vanishing point rests
    this.cy = cy;
    this.vpX = cx; // the vanishing point, easing toward the pointer
    this.vpY = cy;
    this.unit = unit;
    this.reach = reach; // the farthest a dot goes: past the farthest corner, the point leaned all the way
    this.boost = 1; // speed factor, easing toward WARP while the button is held
    this.lastNowMs = NaN;
    this.starRate = NaN; // dots per ms at boost 1 that never overwrite a live one
    this.streakRate = NaN;
    this.debrisRate = NaN;
    this.starsOwed = 0;
    this.streaksOwed = 0;
    this.debrisOwed = 0;
    this.stars = {
      layer: STARS,
      count: 0,
      x: { min: 0, max: 0 },
      y: { min: 0, max: 0 },
      angleXY: { min: 0, max: 0 },
      speed: { min: 0, max: 0 },
      delay: { min: 0, max: 0 },
      lifespan: 1000,
      scale: { from: 0.04, to: 0.55, ease: PARTICLE_EASE.QUAD_IN },
      alpha: { from: 0, to: 0.7, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x18241a, to: 0xffffff },
      texture: '_whiteCircle',
    };
    this.streak = {
      layer: STREAKS,
      count: 0,
      x: { min: 0, max: 0 },
      y: { min: 0, max: 0 },
      angleXY: { min: 0, max: 0 },
      speed: { min: 0, max: 0 },
      delay: { min: 0, max: 0 },
      lifespan: 1000,
      rotation: 0,
      scaleX: { from: 0.05, to: 1, ease: PARTICLE_EASE.QUAD_IN },
      scaleY: { from: 0.12, to: 0.45 },
      alpha: { from: 0, to: 0.6, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x0e2414, to: 0xffffff, ease: PARTICLE_EASE.QUAD_IN },
      texture: 'streak', // a comet: bright head, fading tail
    };
    // Cubes in the word's colors, each turned and spinning its own way, growing as they come.
    this.debris = {
      layer: DEBRIS,
      count: 0,
      x: { min: 0, max: 0 },
      y: { min: 0, max: 0 },
      angleXY: { min: 0, max: 0 },
      speed: { min: 0, max: 0 },
      delay: { min: 0, max: 0 },
      lifespan: 1000,
      rotation: { min: 0, max: 360 },
      angularVelocity: { min: -0.5, max: 0.5 },
      scale: { from: 0.05, to: { min: 0.7, max: 1.9 }, ease: PARTICLE_EASE.QUAD_IN },
      alpha: { from: 0, to: 1, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x0a180c, to: 0xffffff, ease: PARTICLE_EASE.QUAD_OUT },
      texture: '_white',
    };
  }

  tick() {
    const now = Time.simNowMs;
    if (Number.isNaN(this.lastNowMs)) {
      this.lastNowMs = now;
      // A ring holds one longest life of dots: the slowest band's, all the way to `reach`.
      const slot = GpuParticles.writerSlot;
      this.starRate =
        (GpuParticles.stats(STARS)[slot].capacity * FILL) / warpLife(STAR_SPEED[0], this.unit, this.reach);
      this.streakRate =
        (GpuParticles.stats(STREAKS)[slot].capacity * FILL) / warpLife(STREAK_SPEED[0], this.unit, this.reach);
      this.debrisRate =
        (GpuParticles.stats(DEBRIS)[slot].capacity * FILL) / warpLife(DEBRIS_SPEED[0], this.unit, this.reach);
      return;
    }
    const elapsed = now - this.lastNowMs;
    this.lastNowMs = now;
    const dt = elapsed < STEP_MS ? elapsed : STEP_MS;
    if (!(dt > 0)) return;
    const tx = Mouse.isPresent ? this.cx + (Mouse.x - this.cx) * LEAN : this.cx;
    const ty = Mouse.isPresent ? this.cy + (Mouse.y - this.cy) * LEAN : this.cy;
    const follow = 1 - Math.exp(-dt / 220);
    this.vpX += (tx - this.vpX) * follow;
    this.vpY += (ty - this.vpY) * follow;
    const target = Mouse.isButton0Down ? WARP : 1;
    this.boost += (target - this.boost) * (1 - Math.exp(-dt / (target > this.boost ? 160 : 700)));
    // At warp the dots move `boost` times faster and live `boost` times shorter, so they come `boost` times more
    // often and the ring still never overwrites a live one.
    const b = this.boost;
    this.starsOwed = this.throwSectors(this.stars, KIND_STARS, this.starsOwed + this.starRate * b * dt, dt);
    this.streaksOwed = this.throwSectors(this.streak, KIND_STREAKS, this.streaksOwed + this.streakRate * b * dt, dt);
    this.debrisOwed = this.throwSectors(this.debris, KIND_DEBRIS, this.debrisOwed + this.debrisRate * b * dt, dt);
  }

  /**
   * Throws the whole dots `owed` holds over this lane's sectors (lane, lane + lanes, …) and returns what is left.
   * Each sector takes a random speed band, and its dots live until they are just past the screen's edge in that
   * direction: every one brightens all the way out, and none dies in view (an ease only goes one way).
   */
  throwSectors(cfg, kind, owed, dt) {
    const k = WARP_KINDS[kind];
    const mine = k.sectors / this.lanes;
    const total = Math.floor(owed);
    if (total < mine) return owed;
    const per = Math.floor(total / mine);
    let extra = total - per * mine;
    const width = 360 / k.sectors;
    const scale = this.unit * this.boost;
    const step = ((k.speed[1] - k.speed[0]) / k.bands) * scale;
    const r = k.spawn * this.unit;
    cfg.x.min = this.vpX - r;
    cfg.x.max = this.vpX + r;
    cfg.y.min = this.vpY - r;
    cfg.y.max = this.vpY + r;
    cfg.delay.max = dt; // born over the frame, not all at its start
    // Comets stretch with the square root of the boost: a full boost turned the screen white.
    const stretch = this.unit * Math.sqrt(this.boost);
    const margin = k.margin * stretch;
    for (let s = 0; s < mine; s++) {
      const a0 = (this.lane + s * this.lanes) * width;
      const mid = a0 + width / 2;
      const band = Math.floor(Math.random() * k.bands);
      const lo = k.speed[0] * scale + step * band;
      cfg.count = per + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      cfg.angleXY.min = a0;
      cfg.angleXY.max = a0 + width;
      cfg.speed.min = lo;
      cfg.speed.max = lo + step;
      cfg.lifespan = (Math.min(this.edgeDistance(mid) + margin, this.reach) / lo) * FRAME_MS;
      if (kind === KIND_STREAKS) {
        cfg.rotation = mid;
        // Nearer is faster and longer: 100 to 230 px at the edge (unit 1), more at warp.
        cfg.scaleX.to = ((70 + (160 * (band + 1)) / k.bands) * stretch) / STREAK_TEXTURE_PX;
        cfg.tint.to = WARP_COLORS[Math.floor(Math.random() * WARP_COLORS.length)];
      } else if (kind === KIND_DEBRIS) {
        cfg.tint.to = WORD_COLORS[Math.floor(Math.random() * WORD_COLORS.length)];
      }
      ParticleEmitter.emitGpu(cfg);
    }
    return owed - total;
  }

  /** px from the vanishing point to the screen's edge along `deg` (0 = +x, 90 = +y, as angleXY). */
  edgeDistance(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let t = this.reach;
    if (c > 1e-6) t = Math.min(t, (this.config.worldWidth - this.vpX) / c);
    else if (c < -1e-6) t = Math.min(t, -this.vpX / c);
    if (s > 1e-6) t = Math.min(t, (this.config.worldHeight - this.vpY) / s);
    else if (s < -1e-6) t = Math.min(t, -this.vpY / s);
    return t;
  }
}

/** A burning brick is drawn with the entities and fed to the fire layer as a hot body. */
const BURNING_LAYERS = ['entities', FIRE];
const PLAIN_LAYERS = ['entities'];

/** The trail dot a fast brick leaves, one config per worker. */
const TRAIL = {
  layer: TRAILS,
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

/** The screen's edges, so loose bricks bounce back into view. */
export class Wall extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned() {
    this.rigidBody.static = 1;
    this.collider.friction = 0.7;
    this.collider.restitution = 0.2;
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
 * blastforgeScene's explosion layers, smooth: no bands, dither or outline. They expect a logic worker to set blasts
 * off; here the page does.
 */
function blastLayers() {
  const layers = explosionLayers({ pixelZoom: BLAST_PIXEL, palette: BLAST.palette });
  for (const layer of Object.values(layers)) {
    if (layer.gpuRings) layer.gpuRings = { main: 1, logic: 0, particle: 0 };
  }
  const field = layers[FIELD_LAYER].shader.uniforms;
  field.uSmooth.value = 1;
  field.uDither.value = 0;
  field.uOutline.value = 0;
  return layers;
}

/** burningBoxesScene's fire, its smoke paled: soot does not show on a black sky. */
function landingFire() {
  const layer = fireLayer({
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    cellSize: FIRE_CELL,
    lfRadius: 6,
    maxBodies: FIRE_BODIES,
    maxParticles: 64, // no LiquidFun here: only burning bricks feed it
  });
  layer.shader.uniforms.uSmokeLift.value = 0.75;
  layer.shader.uniforms.uSmokeDens.value = 1;
  return layer;
}

/**
 * Page only: draws the words on a canvas the size of the world and keeps one brick per grid cell that falls on a
 * letter, with cells as small as MAX_BRICKS allows. Narrow screens get more lines.
 * @returns {{ size: number, bricks: { x: number, y: number, color: number }[] }}
 */
function layoutWord(width, height) {
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

export class LandingScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,
    // A blast of the whole word kicks every brick: two commands each.
    physics: { numberOfPhysicsWorkers: 4, commandRingCapacity: 32768 },
    spatial: { numberOfSpatialWorkers: 0, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: LANES },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
    renderer: { backend: BACKEND },
    layers: {
      [STARS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.4,
        maxParticles: Math.round(PARTICLES * 0.55),
        gpuRings: { main: 0, logic: 1, particle: 0 }, // only the lanes emit
        blendMode: BLEND_MODES.ADD,
      },
      [STREAKS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.5,
        maxParticles: Math.round(PARTICLES * 0.4),
        gpuRings: { main: 0, logic: 1, particle: 0 },
        blendMode: BLEND_MODES.ADD,
      },
      [DEBRIS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.6, // in front of the light, solid
        maxParticles: Math.round(PARTICLES * 0.02),
        gpuRings: { main: 0, logic: 1, particle: 0 },
      },
      [TRAILS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.8,
        maxParticles: 131072,
        gpuRings: { main: 0, logic: 1, particle: 0 }, // the bricks' ticks
        blendMode: BLEND_MODES.ADD,
      },
      ...blastLayers(),
      ...(FIRE_ON
        ? {
            [FIRE]: landingFire(),
          }
        : {}),
    },
  };

  // The page loads assets; import.meta.url keeps the path right wherever the site is served.
  static assets = {
    textures: { streak: new URL('./img/streak.png', import.meta.url).href, ...explosionAssets.textures },
    shaders: { ...(BACKEND === 'webgpu' ? explosionAssetsWgsl : explosionAssets).shaders, ...fireAssets.shaders },
  };

  static entities = [
    [WarpLane, LANES],
    [Brick, MAX_BRICKS],
    [Wall, 4],
  ];

  create() {
    Camera.setZoom(1);
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
    this.word = layoutWord(WORLD_W, WORLD_H);
    this.unit = Math.min(WORLD_W, WORLD_H) / 1000; // sizes that follow the screen
    this.warpUnit = Math.max(0.6, this.unit);
    // From the vanishing point, leaned as far as it goes, to past the farthest corner.
    this.warpReach = 0.66 * Math.sqrt(WORLD_W * WORLD_W + WORLD_H * WORLD_H) + 140 * this.warpUnit;
    this.blastCount = 0;
    this.blastSize = Math.max(1, 2 * this.unit); // the fireball: 40 px of radius at size 1
    this.buildHud();
  }

  createNewGame() {
    for (let lane = 0; lane < LANES; lane++) {
      WarpLane.spawn({
        lane,
        lanes: LANES,
        cx: WORLD_W / 2,
        cy: WORLD_H * 0.42,
        unit: this.warpUnit,
        reach: this.warpReach,
        forceProcessOnLogicWorker: lane,
      });
    }
    const t = 200; // wall thickness, outside the view
    Wall.spawn({ x: WORLD_W / 2, y: WORLD_H + t / 2, width: WORLD_W + 2 * t, height: t });
    Wall.spawn({ x: WORLD_W / 2, y: -t / 2, width: WORLD_W + 2 * t, height: t });
    Wall.spawn({ x: -t / 2, y: WORLD_H / 2, width: t, height: WORLD_H + 2 * t });
    Wall.spawn({ x: WORLD_W + t / 2, y: WORLD_H / 2, width: t, height: WORLD_H + 2 * t });
    // The bricks start scattered over the screen and fly into the word.
    const { size, bricks } = this.word;
    for (const b of bricks) {
      Brick.spawn({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        homeX: b.x,
        homeY: b.y,
        size,
        color: b.color,
      });
    }
  }

  update(dtRatio, deltaTimeMs) {
    if (Mouse.isButton0Pressed) this.blast(Mouse.x, Mouse.y);
    updateExplosions(deltaTimeMs); // the blasts' lights and shockwaves, on the thread that sets them off
  }

  /**
   * One of blastforgeScene's fireballs at (x, y). The bricks within reach fly off (the page writes their kick, their
   * own ticks apply it), and the nearest ones catch fire.
   */
  blast(x, y) {
    const reach = 150 * this.unit + 40;
    const lit = reach * BURN_REACH;
    const list = Brick.getAllActive();
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const brick = Brick.get(i);
      const dx = brick.x - x;
      const dy = brick.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2) || 1;
      const f = 1 - d / reach;
      const speed = (450 + 2300 * f) * Math.max(0.6, this.unit);
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.7;
      BrickState.kickX[i] = Math.cos(angle) * speed;
      BrickState.kickY[i] = Math.sin(angle) * speed - 500 * this.unit;
      BrickState.spin[i] = (Math.random() - 0.5) * 50 * f;
      BrickState.timer[i] = 2300 + Math.random() * 1000 + 600 * f;
      if (FIRE_ON && d < lit) BrickState.burn[i] = BURN_MS[0] + Math.random() * (BURN_MS[1] - BURN_MS[0]);
      BrickState.mode[i] = KICK;
    }
    explode(x, y, BLAST, { size: this.blastSize, amount: BLAST_AMOUNT });
    Camera.shake(7 * Math.max(0.6, this.unit), 300);
    this.blastCount++;
  }

  async destroy() {
    clearInterval(this.hudTimer);
    await super.destroy();
  }

  /** Live numbers: GPU particles alive (each layer's published dots over its longest life), bodies, threads, fps. */
  buildHud() {
    const hud = document.getElementById('weed-hud');
    if (!hud) return;
    const tracks = [
      { layer: STARS, lifeMs: warpLife(STAR_SPEED[0], this.warpUnit, this.warpReach) },
      { layer: STREAKS, lifeMs: warpLife(STREAK_SPEED[0], this.warpUnit, this.warpReach) },
      { layer: DEBRIS, lifeMs: warpLife(DEBRIS_SPEED[0], this.warpUnit, this.warpReach) },
      { layer: TRAILS, lifeMs: 460 },
    ].map((t) => ({ ...t, samples: Math.round(t.lifeMs / 250) + 1, history: null, last: null, total: 0, at: 0 }));
    const w = this.workers;
    const threads =
      1 +
      w.logicWorkers.length +
      w.spatialWorkers.length +
      w.preRenderWorkers.length +
      (w.particle ? 1 : 0) +
      (w.renderer ? 1 : 0) +
      (w.physics ? this.config.physics.numberOfPhysicsWorkers : 0);
    const fmt = (n) => n.toLocaleString('en-US');
    this.hudTimer = setInterval(() => {
      let alive = 0;
      for (const t of tracks) {
        const rings = GpuParticles.stats(t.layer);
        if (!rings) continue;
        if (t.last === null) {
          t.last = rings.map((r) => r.published);
          t.history = new Float64Array(t.samples);
        }
        let capacity = 0;
        rings.forEach((r, k) => {
          t.total += (r.published - t.last[k]) >>> 0;
          t.last[k] = r.published;
          capacity += r.capacity;
        });
        t.history[t.at % t.samples] = t.total;
        const lifeAgo = t.at >= t.samples - 1 ? t.history[(t.at + 1) % t.samples] : 0;
        t.at++;
        alive += Math.min(capacity, t.total - lifeAgo);
      }
      hud.innerHTML =
        `<b>${fmt(alive)}</b> GPU particles<br>` +
        `<b>${fmt(Brick.activeCount + 4)}</b> Box2D bodies<br>` +
        `<b>${threads}</b> threads · <b>${Math.round(this.mainFPS || 0)}</b> fps`;
    }, 250);
  }
}
