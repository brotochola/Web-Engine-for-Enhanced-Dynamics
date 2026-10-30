// landingScene.js – the landing page (index.html at the repo root, served by GitHub Pages).
//
// The word WEED.JS is built from Box2D bricks. Each brick's own tick pulls it to its place with a spring, so the word
// wobbles when something knocks it, and the pointer pushes the bricks aside. A click or a tap blasts the bricks around
// it: they spin away, fall, pile up on the floor and fly back. Behind them the view flies through hyperspace: GPU
// particles stream out of a vanishing point that leans toward the pointer, slow far stars and fast near streaks, one
// warp lane per logic worker. Holding the button jumps to warp speed.
//   ?particles=<n>   the stars' and streaks' maxParticles together (default 2 097 152, 1 048 576 on a touch screen)
//   ?backend=webgl   Pixi's WebGL backend (default WebGPU where the browser has it)

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
/** Pool size: the word takes as many as fit, with bricks as small as the screen allows. */
const MAX_BRICKS = 2400;

const STARS = 'stars'; // far: slow dots
const STREAKS = 'streaks'; // near: fast streaks, each turned along its way
const TRAILS = 'trails';
const BURST = 'burst';
const STEP_MS = 50;
const FILL = 0.97;
const FRAME_MS = 1000 / 60; // GPU particle speeds are px per frame
/** Speeds (px per frame at unit 1), split in bands: each band's life is the time its slowest dot takes to leave the
 *  screen, so every dot fades in on its way out and none dies in view (an ease only goes one way). */
const STAR_SPEED = [1.2, 3.6];
const STAR_BANDS = 3;
const STREAK_SPEED = [5, 15];
const STREAK_BANDS = 5;
/** A streak call covers 360 / SECTORS degrees and is turned to its middle. */
const SECTORS = 96;
/** How far the vanishing point follows the pointer, and the speed while the button is held. */
const LEAN = 0.3;
const WARP = 3.2;
const WARP_COLORS = [0xffffff, 0xdcefff, 0xffffff, 0xbfe2ff, 0xffffff, 0x5dffa8, 0x47e0ff, 0xb48cff, 0xff6bd8];
/** The word's colors, left to right. */
const WORD_COLORS = [0x5dffa8, 0x47e0ff, 0x7f8cff, 0xd86bff];

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
  };
}

/** ms a dot at `speed` (px per frame at unit 1) takes to travel `reach` px. Page and lanes both use it. */
function warpLife(speed, unit, reach) {
  return (reach / (speed * unit)) * FRAME_MS;
}

/**
 * One warp lane, pinned to its own logic worker: its fields live there, its dots go to that worker's rings. It throws
 * a share of the stars and every lanes-th sector of the streaks.
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
    this.reach = reach; // px from the vanishing point to past the farthest corner
    this.boost = 1; // speed factor, easing toward WARP while the button is held
    this.lastNowMs = NaN;
    this.starRate = NaN; // dots per ms at boost 1 that never overwrite a live one
    this.streakRate = NaN;
    this.starsOwed = 0;
    this.streaksOwed = 0;
    this.stars = {
      layer: STARS,
      count: 0,
      x: { min: 0, max: 0 },
      y: { min: 0, max: 0 },
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 0 },
      delay: { min: 0, max: 0 },
      lifespan: 1000,
      scale: { from: 0.04, to: 0.55, ease: PARTICLE_EASE.QUAD_IN },
      alpha: { from: 0, to: 1, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x1c2a4a, to: 0xffffff },
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
      scaleX: { from: 0.2, to: 8, ease: PARTICLE_EASE.QUAD_IN },
      scaleY: { from: 0.08, to: 0.4 },
      alpha: { from: 0, to: 0.85, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x10203c, to: 0xffffff, ease: PARTICLE_EASE.QUAD_IN },
      texture: '_whiteCircle',
    };
  }

  tick() {
    const now = Time.simNowMs;
    if (Number.isNaN(this.lastNowMs)) {
      this.lastNowMs = now;
      // A ring holds one longest life of dots: the slowest band's.
      const slot = GpuParticles.writerSlot;
      this.starRate =
        (GpuParticles.stats(STARS)[slot].capacity * FILL) / warpLife(STAR_SPEED[0], this.unit, this.reach);
      this.streakRate =
        (GpuParticles.stats(STREAKS)[slot].capacity * FILL) / warpLife(STREAK_SPEED[0], this.unit, this.reach);
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
    this.emitStars(dt);
    this.emitStreaks(dt);
  }

  /**
   * At warp the dots move `boost` times faster and live `boost` times shorter, so they come `boost` times more often
   * and the ring still never overwrites a live one.
   */
  emitStars(dt) {
    this.starsOwed += this.starRate * this.boost * dt;
    const total = Math.floor(this.starsOwed);
    if (total < STAR_BANDS) return;
    this.starsOwed -= total;
    const s = this.stars;
    const r = 6 * this.unit;
    s.x.min = this.vpX - r;
    s.x.max = this.vpX + r;
    s.y.min = this.vpY - r;
    s.y.max = this.vpY + r;
    s.delay.max = dt; // born over the frame, not all at its start
    const per = Math.floor(total / STAR_BANDS);
    const step = (STAR_SPEED[1] - STAR_SPEED[0]) / STAR_BANDS;
    for (let b = 0; b < STAR_BANDS; b++) {
      const lo = STAR_SPEED[0] + step * b;
      s.count = b === STAR_BANDS - 1 ? total - per * (STAR_BANDS - 1) : per;
      s.speed.min = lo * this.unit * this.boost;
      s.speed.max = (lo + step) * this.unit * this.boost;
      s.lifespan = warpLife(lo, this.unit, this.reach) / this.boost;
      ParticleEmitter.emitGpu(s);
    }
  }

  emitStreaks(dt) {
    const mine = SECTORS / this.lanes; // this lane's sectors: lane, lane + lanes, …
    this.streaksOwed += this.streakRate * this.boost * dt;
    const total = Math.floor(this.streaksOwed);
    if (total < mine) return;
    this.streaksOwed -= total;
    const st = this.streak;
    const r = 4 * this.unit;
    st.x.min = this.vpX - r;
    st.x.max = this.vpX + r;
    st.y.min = this.vpY - r;
    st.y.max = this.vpY + r;
    st.delay.max = dt;
    const per = Math.floor(total / mine);
    let extra = total - per * mine;
    const width = 360 / SECTORS;
    const step = (STREAK_SPEED[1] - STREAK_SPEED[0]) / STREAK_BANDS;
    for (let k = 0; k < mine; k++) {
      const a0 = (this.lane + k * this.lanes) * width;
      const band = Math.floor(Math.random() * STREAK_BANDS);
      const lo = STREAK_SPEED[0] + step * band;
      st.count = per + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      st.angleXY.min = a0;
      st.angleXY.max = a0 + width;
      st.rotation = a0 + width / 2;
      st.speed.min = lo * this.unit * this.boost;
      st.speed.max = (lo + step) * this.unit * this.boost;
      st.lifespan = warpLife(lo, this.unit, this.reach) / this.boost;
      st.scaleX.to = (6 + (18 * (band + 1)) / STREAK_BANDS) * this.boost; // nearer is faster and longer
      st.tint.to = WARP_COLORS[Math.floor(Math.random() * WARP_COLORS.length)];
      ParticleEmitter.emitGpu(st);
    }
  }
}

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
      }
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

  trail(vx, vy) {
    if (vx * vx + vy * vy < TRAIL_SPEED * TRAIL_SPEED) return;
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
 * Page only: draws the word on a canvas the size of the world and keeps one brick per grid cell that falls on a
 * letter, with cells as small as MAX_BRICKS allows. Narrow screens get two lines.
 * @returns {{ size: number, bricks: { x: number, y: number, color: number }[] }}
 */
function layoutWord(width, height) {
  const portrait = width < height * 0.9;
  const lines = portrait ? ['WEED', '.JS'] : ['WEED.JS'];
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const font = (px) => `900 ${px}px "Arial Black", "Segoe UI Black", "Helvetica Neue", system-ui, sans-serif`;
  g.font = font(100);
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, g.measureText(line).width);
  const lineStep = 0.92; // line height, in font sizes
  const boxW = width * (portrait ? 0.88 : 0.8);
  const boxH = height * (portrait ? 0.38 : 0.34);
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

  let size = Math.max(5, Math.min(width, height) / 95);
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
  for (let k = 0; k < cells.length; k += 2) {
    minX = Math.min(minX, cells[k]);
    maxX = Math.max(maxX, cells[k]);
  }
  const bricks = [];
  for (let k = 0; k < cells.length; k += 2) {
    const x = cells[k];
    const y = cells[k + 1];
    const base = gradient((x - minX) / (maxX - minX || 1));
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
    physics: { numberOfPhysicsWorkers: 4, commandRingCapacity: 16384 },
    spatial: { numberOfSpatialWorkers: 0, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: LANES },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
    renderer: { backend: BACKEND },
    layers: {
      [STARS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.4,
        maxParticles: Math.round(PARTICLES * 0.6),
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
      [TRAILS]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.8,
        maxParticles: 131072,
        gpuRings: { main: 0, logic: 1, particle: 0 }, // the bricks' ticks
        blendMode: BLEND_MODES.ADD,
      },
      [BURST]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 6,
        maxParticles: 262144,
        gpuRings: { main: 1, logic: 0, particle: 0 }, // the page's blasts
        blendMode: BLEND_MODES.ADD,
      },
    },
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
    this.warpReach = 0.62 * Math.sqrt(WORLD_W * WORLD_W + WORLD_H * WORLD_H);
    this.blastCount = 0;
    this.buildBlasts();
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

  update() {
    if (Mouse.isButton0Pressed) this.blast(Mouse.x, Mouse.y);
  }

  /** The bricks within reach of (x, y) fly off; the page writes their kick, their own ticks apply it. */
  blast(x, y) {
    const reach = 380 * this.unit + 60;
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
      const speed = (500 + 2600 * f) * Math.max(0.6, this.unit);
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.7;
      BrickState.kickX[i] = Math.cos(angle) * speed;
      BrickState.kickY[i] = Math.sin(angle) * speed - 600 * this.unit;
      BrickState.spin[i] = (Math.random() - 0.5) * 50 * f;
      BrickState.timer[i] = 2300 + Math.random() * 1000 + 600 * f;
      BrickState.mode[i] = KICK;
    }
    const b = this.blasts;
    for (const cfg of b) {
      cfg.x = x;
      cfg.y = y;
      ParticleEmitter.emitGpu(cfg);
    }
    Camera.shake(9 * Math.max(0.6, this.unit), 260);
    this.blastCount++;
  }

  /** A blast's emits: sparks in the word's colors, a shock ring, a flash. Made once; blast() only moves them. */
  buildBlasts() {
    const u = Math.max(0.6, this.unit);
    const sparks = (to) => ({
      layer: BURST,
      count: TOUCH ? 3500 : 8000,
      x: 0,
      y: 0,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2 * u, max: 24 * u },
      drag: 2.8,
      lifespan: { min: 500, max: 1700 },
      scale: { from: 0.42, to: 0, ease: PARTICLE_EASE.QUAD_IN },
      alpha: { from: 0.9, to: 0, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0xffffff, to, ease: PARTICLE_EASE.QUAD_OUT },
      texture: '_whiteCircle',
    });
    this.blasts = [
      sparks(WORD_COLORS[0]),
      sparks(WORD_COLORS[1]),
      sparks(WORD_COLORS[3]),
      {
        layer: BURST,
        count: TOUCH ? 3000 : 6000,
        x: 0,
        y: 0,
        angleXY: { min: 0, max: 360 },
        speed: { min: 15 * u, max: 16 * u },
        drag: 3.2,
        lifespan: { min: 450, max: 650 },
        scale: { from: 0.7, to: 0.15 },
        alpha: { from: 0.9, to: 0, ease: PARTICLE_EASE.QUAD_IN },
        tint: { from: 0xffffff, to: 0xd86bff },
        texture: '_whiteCircle',
      },
      {
        layer: BURST,
        count: 6,
        x: 0,
        y: 0,
        angleXY: { min: 0, max: 360 },
        speed: { min: 0, max: 0.4 },
        lifespan: { min: 260, max: 420 },
        scale: { from: 1.1 * u, to: 2.4 * u, ease: PARTICLE_EASE.QUAD_OUT }, // _lightGradient is 200 px wide
        alpha: { from: 0.4, to: 0, ease: PARTICLE_EASE.QUAD_IN },
        tint: { from: 0xffffff, to: 0x7f8cff },
        texture: '_lightGradient',
      },
    ];
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
      { layer: TRAILS, lifeMs: 460 },
      { layer: BURST, lifeMs: 1700 },
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
