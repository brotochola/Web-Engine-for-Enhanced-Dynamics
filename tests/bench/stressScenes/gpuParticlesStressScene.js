import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, ParticleEmitter, Camera, SharedResource, LAYER_KIND, BLEND_MODES, PARTICLE_EASE, rng } = WEED;

// GPU particles (LAYER_KIND.GPU_PARTICLES) among y-sorted "trees": smoke columns and fire from ParticleEmitter.emitGpu,
// bouncing CPU sparks from ParticleEmitter.emit, so the two kinds are seen together. A visual check and a load knob
// for the renderer (`?columns=`, `?count=`).
//   ?backend=webgl|webgpu   default webgl
//   ?sort=0|1               the GPU layers' sortWithEntities (default 1): trees in front of a column hide it
//   ?columns=<n>            smoke columns started every second (default 6)
//   ?count=<n>              GPU particles per column (default 400)
//   ?look=1                 the smoke layer goes through a look shader (its density pass is GPU particles)
//   ?interp=1               renderer.interpolation: Pixi packs the entities (and lists the groups) itself
//   ?hold=<n>               n columns started at once, alive for the whole run, and none after (columns is ignored):
//                           the painter's groups and gaps stay as they are from frame to frame
//   ?trail=<n>              n movers (at most 1024) that each call emitGpu every tick, one particle with a second of
//                           life a call, on a layer of their own whose rings go to the logic worker: the call-per-tick
//                           pattern (E-161). With ?sort=1 each mover sorts at its own row.

function param(name, fallback) {
  try {
    const v = new URLSearchParams(globalThis.location?.search || '').get(name);
    return v == null || v === '' ? fallback : v;
  } catch {
    return fallback;
  }
}

const BACKEND = param('backend', 'webgl') === 'webgpu' ? 'webgpu' : 'webgl';
const SORT = param('sort', '1') !== '0';
const COLUMNS = Math.max(0, parseInt(param('columns', '6'), 10) || 0);
const COUNT = Math.max(1, parseInt(param('count', '400'), 10) || 400);
const LOOK = param('look', '0') === '1';
const INTERP = param('interp', '0') === '1';
const HOLD = Math.max(0, parseInt(param('hold', '0'), 10) || 0);
const MAX_TRAIL = 1024;
const TRAIL = Math.min(MAX_TRAIL, Math.max(0, parseInt(param('trail', '0'), 10) || 0));

export const stressSceneConfig = {
  requested: { backend: BACKEND, sort: SORT, columns: COLUMNS, count: COUNT, look: LOOK, interp: INTERP, hold: HOLD, trail: TRAIL },
};

/** The page's knobs, for the logic worker (which does not see the page's query string). */
export class GpuStressSettings extends SharedResource {
  static schema = { columns: Float32Array, count: Float32Array, hold: Float32Array };
}

/** A held column's life (ms): longer than any run. */
const HELD_MS = 3.6e6;

const WORLD_W = 1280;
const WORLD_H = 720;

/** A tree: a dark trunk-and-crown block standing on its feet (anchor at the bottom), y-sorted by them. */
export class Tree extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, h = 90 } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setDisplaySize(26, h);
    this.setTint(0x2d6a34);
  }
}

/** Starts smoke columns and fire on a timer from the logic worker, and throws CPU sparks with them. */
export class Smoker extends GameObject {
  static components = [];

  onSpawned() {
    this.timerMs = 0;
    this.started = 0;
  }

  tick(dtRatio, deltaTime) {
    const count = Math.max(1, GpuStressSettings.count[0] | 0);
    const hold = GpuStressSettings.hold[0];
    if (hold > 0) {
      if (this.started === 0) {
        for (let i = 0; i < hold; i++) this._column(count, HELD_MS);
        this.started = hold;
      }
      return;
    }
    this.timerMs -= deltaTime;
    if (this.timerMs > 0) return;
    const columns = GpuStressSettings.columns[0];
    this.timerMs = columns > 0 ? 1000 / columns : 1e9;
    if (!(columns > 0)) return;
    this.started++;
    const { x, y } = this._column(count, 0);
    ParticleEmitter.emit({
      count: 24,
      x,
      y,
      z: -6,
      angleXY: { min: 0, max: 360 },
      speed: { min: 1, max: 3.5 },
      vz: { min: -5, max: -2.5 },
      gravity: 0.25,
      bounces: { min: 1, max: 2 },
      bounciness: 0.4,
      bounceFriction: 0.6,
      lifespan: 1600,
      fadeOnTheFloor: 300,
      scale: 0.12,
      tint: 0xffd060,
      texture: '_whiteCircle_64x64',
    });
  }

  /** A smoke column and its fire at a random spot; `heldMs` > 0 gives both that life instead of their own. */
  _column(count, heldMs) {
    const x = 160 + rng() * (WORLD_W - 320);
    const y = 220 + rng() * (WORLD_H - 300);
    ParticleEmitter.emitGpu({
      layer: 'smoke',
      heighted: true,
      count,
      x: { min: x - 10, max: x + 10 },
      y: { min: y - 4, max: y + 4 },
      z: -4,
      vz: { min: -1.8, max: -0.6 },
      gravity: -0.004,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.05, max: 0.5 },
      drag: 0.6,
      delay: { min: 0, max: 900 },
      lifespan: heldMs > 0 ? heldMs : { min: 1800, max: 3200 },
      scale: { from: { min: 0.25, max: 0.45 }, to: { min: 0.9, max: 1.5 }, ease: PARTICLE_EASE.QUAD_OUT },
      alpha: { from: 0.55, to: 0, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x9a9a9a, to: 0x3c3c3c },
      texture: '_whiteCircle_64x64',
      sortY: y,
    });
    ParticleEmitter.emitGpu({
      layer: 'fire',
      heighted: true,
      count: Math.max(1, count >> 2),
      x: { min: x - 8, max: x + 8 },
      y,
      z: -2,
      vz: { min: -1.6, max: -0.8 },
      gravity: -0.01,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 0.3 },
      lifespan: heldMs > 0 ? heldMs : { min: 300, max: 700 },
      scale: { from: 0.35, to: 0.05, ease: PARTICLE_EASE.CUBIC_IN },
      tint: { from: 0xffe08a, to: 0xff4010 },
      texture: '_whiteCircle_64x64',
      sortY: y,
    });
    return { x, y };
  }
}

/** A trail mover's call, one object for every call (x, y and sortY are set before each). */
const TRAIL_CALL = {
  layer: 'trail',
  count: 1,
  x: 0,
  y: 0,
  angleXY: { min: 0, max: 360 },
  speed: { min: 0.1, max: 0.6 },
  lifespan: 1000,
  scale: { from: 0.16, to: 0.04 },
  tint: { from: 0xa0e0ff, to: 0x2050ff },
  texture: '_whiteCircle_64x64',
  sortY: 0,
};

/** Circles its own centre and leaves a GPU particle every tick (?trail=). */
export class Trailer extends GameObject {
  static components = [];

  onSpawned({ x = 0, y = 0, phase = 0 } = {}) {
    this.cx = x;
    this.cy = y;
    this.phase = phase;
    this.x = x;
    this.y = y;
  }

  tick(dtRatio) {
    this.phase += 0.05 * dtRatio;
    const x = this.cx + Math.cos(this.phase) * 40;
    const y = this.cy + Math.sin(this.phase) * 25;
    this.x = x;
    this.y = y;
    TRAIL_CALL.x = x;
    TRAIL_CALL.y = y;
    TRAIL_CALL.sortY = y;
    ParticleEmitter.emitGpu(TRAIL_CALL);
  }
}

export class GpuParticlesStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x5eed,
    physics: { enabled: false },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, interpolation: INTERP },
    ...(INTERP ? { preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' } } : {}),
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    particle: { maxParticles: 4000 },
    layers: {
      smoke: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 3.5,
        maxParticles: 120000,
        sortWithEntities: SORT,
        ...(LOOK ? { shader: { fragment: 'gpuSmokeLook', containerBlend: BLEND_MODES.ADD } } : {}),
      },
      fire: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 3.6,
        maxParticles: 40000,
        blendMode: BLEND_MODES.ADD,
        sortWithEntities: SORT,
      },
      trail: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 3.7,
        maxParticles: 120000,
        gpuRings: { main: 0, logic: 1, particle: 0 },
        blendMode: BLEND_MODES.ADD,
        sortWithEntities: SORT,
      },
    },
  };

  static assets = LOOK
    ? { shaders: { gpuSmokeLook: `/tests/bench/stressScenes/gpuSmokeLook.${BACKEND === 'webgpu' ? 'wgsl' : 'frag'}` } }
    : {};

  static entities = [
    [Tree, 200],
    [Smoker, 1],
    [Trailer, MAX_TRAIL],
  ];

  static sharedResources = [[GpuStressSettings, GpuStressSettings.schema]];

  create() {
    GpuStressSettings.columns[0] = COLUMNS;
    GpuStressSettings.count[0] = COUNT;
    GpuStressSettings.hold[0] = HOLD;
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
    Camera.setZoom(1);
  }

  createNewGame() {
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 16; col++) {
        Tree.spawn({ x: 60 + col * 78 + (row % 2) * 39, y: 140 + row * 85, h: 70 + ((row * 16 + col) % 5) * 9 });
      }
    }
    Smoker.spawn();
    for (let i = 0; i < TRAIL; i++) {
      Trailer.spawn({ x: 80 + rng() * (WORLD_W - 160), y: 80 + rng() * (WORLD_H - 160), phase: rng() * 6.283 });
    }
  }
}
