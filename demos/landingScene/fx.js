// fx.js – the landing page's fire, smoke and explosions, all GPU particles (ParticleEmitter.emitGpu): written once,
// moved by the vertex shader. An explosion is a flash, a shock ring, a fireball of hot puffs and flame tongues that
// cool from white to deep red, smoke billows that rise, turn and cool from brown to grey, and embers. A campfire is
// flame tongues, a hot core, a glow on everything near, a column of smoke and sparks. The textures are soft and
// procedural (img/glow, flame, puff, ring), not cartoon frames. Two layers: FX_SMOKE (normal blend) under FX_GLOW
// (additive). The page emits them: its ring takes all the records.

const { ParticleEmitter, LAYER_KIND, BLEND_MODES, PARTICLE_EASE } = WEED;

export const FX_SMOKE = 'fxSmoke';
export const FX_GLOW = 'fxGlow';

/** The layers, for a scene's static config.layers. The page emits: its ring gets every record. */
export function fxLayers({ maxSmoke = 65536, maxGlow = 131072 } = {}) {
  const rings = { main: 1, logic: 0, particle: 0 };
  return {
    [FX_SMOKE]: { kind: LAYER_KIND.GPU_PARTICLES, zIndex: 3.45, maxParticles: maxSmoke, gpuRings: rings },
    [FX_GLOW]: {
      kind: LAYER_KIND.GPU_PARTICLES,
      zIndex: 5, // over burningBoxesScene's fire (4.9): a blast's fireball stays in front of what it lights
      maxParticles: maxGlow,
      gpuRings: rings,
      blendMode: BLEND_MODES.ADD,
    },
  };
}

const image = (name) => new URL(`./img/${name}`, import.meta.url).href;

/** Textures, for a scene's static assets. Sizes: glow, puff and ring 128 px; flame 64 x 128 (tip up). */
export const fxAssets = {
  textures: {
    fxGlow: image('glow.png'),
    fxFlame: image('flame.png'),
    fxPuff: image('puff.png'),
    fxRing: image('ring.png'),
  },
};

const around = (center, half) => ({ min: center - half, max: center + half });
const range = (min, max) => ({ min, max });
const ALL_WAYS = range(0, 360);
const UP = range(262, 278); // angleXY: 270 is up (+y is down)

/** An explosion at world (x, y); s scales it (1 = a screen 1000 px high). Page only. */
export function fxExplosion(x, y, s = 1) {
  const emit = (cfg) => ParticleEmitter.emitGpu(cfg);
  // The flash, and the shock ring racing out.
  emit({
    layer: FX_GLOW, count: 2, x: around(x, 4 * s), y: around(y, 4 * s), speed: 0,
    lifespan: range(150, 220), texture: 'fxGlow',
    scale: { from: 2.6 * s, to: 5.5 * s, ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.95, to: 0, ease: PARTICLE_EASE.QUAD_OUT },
    tint: { from: 0xffffff, to: 0xffc070 },
  });
  emit({
    layer: FX_GLOW, count: 1, x, y, speed: 0, lifespan: 380, texture: 'fxRing',
    scale: { from: 0.4 * s, to: 3.6 * s, ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.5, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: 0xffe2b0,
  });
  // The fireball: hot puffs thrown out that stop on drag and rise, white-yellow cooling to deep orange.
  emit({
    layer: FX_GLOW, count: 110, x: around(x, 12 * s), y: around(y, 12 * s), angleXY: ALL_WAYS,
    speed: range(1.5 * s, 7 * s), drag: 3.2, gravity: -0.02 * s, delay: range(0, 60), lifespan: range(450, 1000),
    texture: 'fxGlow',
    scale: { from: range(0.25 * s, 0.4 * s), to: range(0.6 * s, 1 * s), ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.55, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: { from: 0xffe8b0, to: 0xff2a00, ease: PARTICLE_EASE.QUAD_OUT },
  });
  // Flame tongues licking out of it.
  emit({
    layer: FX_GLOW, count: 40, x: around(x, 14 * s), y: around(y, 14 * s), angleXY: ALL_WAYS,
    speed: range(2 * s, 8 * s), drag: 3, lifespan: range(300, 650), rotation: ALL_WAYS, texture: 'fxFlame',
    scale: { from: range(0.35 * s, 0.6 * s), to: range(0.8 * s, 1.2 * s), ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.7, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: { from: 0xffe2a0, to: 0xff3000, ease: PARTICLE_EASE.QUAD_OUT },
  });
  // Smoke billows once the fire is out: they rise, turn, grow and cool from brown to grey.
  emit({
    layer: FX_SMOKE, count: 55, x: around(x, 26 * s), y: around(y, 22 * s), angleXY: ALL_WAYS,
    speed: range(0.5 * s, 3 * s), drag: 1.6, gravity: -0.03 * s, delay: range(60, 380),
    lifespan: range(2600, 5200), rotation: ALL_WAYS, angularVelocity: range(-0.03, 0.03), texture: 'fxPuff',
    scale: { from: range(0.5 * s, 0.8 * s), to: range(1.8 * s, 2.8 * s), ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.85, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: { from: 0x2a1a12, to: 0x5e5e64, ease: PARTICLE_EASE.QUAD_OUT },
  });
  emit({
    layer: FX_SMOKE, count: 8, x: around(x, 20 * s), y: around(y - 30 * s, 20 * s), angleXY: range(240, 300),
    speed: range(0.3 * s, 1.2 * s), drag: 1, gravity: -0.025 * s, delay: range(250, 700),
    lifespan: range(3500, 6000), rotation: ALL_WAYS, angularVelocity: range(-0.02, 0.02), texture: 'fxPuff',
    scale: { from: range(0.8 * s, 1.2 * s), to: range(3 * s, 3.8 * s), ease: PARTICLE_EASE.QUAD_OUT },
    alpha: { from: 0.55, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: { from: 0x241c18, to: 0x6a6a70 },
  });
  // Embers: thrown out, falling, cooling.
  emit({
    layer: FX_GLOW, count: 160, x: around(x, 10 * s), y: around(y, 10 * s), angleXY: ALL_WAYS,
    speed: range(3 * s, 14 * s), drag: 1.1, gravity: 0.05 * s, lifespan: range(800, 2200), texture: '_whiteCircle',
    scale: { from: range(0.18, 0.32), to: 0.04 },
    alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    tint: { from: 0xfff6c0, to: 0xff4a10 },
  });
}

/** A campfire at world (x, y), the ground under it: call update() every frame it should burn. Page only. */
export class Campfire {
  constructor(x, y, s = 1) {
    this.owed = new Float64Array(5);
    this.kinds = [
      // Flame tongues, upright, rising and shrinking as they cool.
      {
        rate: 95,
        cfg: {
          layer: FX_GLOW, count: 0, x: around(x, 20 * s), y: around(y - 14 * s, 5 * s), angleXY: UP,
          speed: range(0.7 * s, 1.6 * s), drag: 0.6, gravity: -0.045 * s, lifespan: range(450, 850),
          rotation: range(-12, 12), angularVelocity: range(-0.02, 0.02), texture: 'fxFlame',
          scale: { from: range(0.6 * s, 0.95 * s), to: range(0.15 * s, 0.25 * s), ease: PARTICLE_EASE.QUAD_IN },
          alpha: { from: 0.4, to: 0, ease: PARTICLE_EASE.QUAD_IN },
          tint: { from: 0xffb060, to: 0xff2000, ease: PARTICLE_EASE.QUAD_OUT },
        },
      },
      // The hot core.
      {
        rate: 30,
        cfg: {
          layer: FX_GLOW, count: 0, x: around(x, 10 * s), y: around(y - 8 * s, 4 * s), angleXY: UP,
          speed: range(0.1 * s, 0.4 * s), lifespan: range(250, 450), texture: 'fxGlow',
          scale: { from: range(0.5 * s, 0.7 * s), to: range(0.8 * s, 1 * s) },
          alpha: { from: 0.35, to: 0, ease: PARTICLE_EASE.QUAD_IN },
          tint: { from: 0xffc070, to: 0xff4000 },
        },
      },
      // A wide, flickering glow on everything near.
      {
        rate: 6,
        cfg: {
          layer: FX_GLOW, count: 0, x: around(x, 4 * s), y: around(y - 24 * s, 4 * s), speed: 0,
          lifespan: range(400, 700), texture: 'fxGlow',
          scale: { from: range(3.4 * s, 3.8 * s), to: range(3.8 * s, 4.2 * s) },
          alpha: { from: 0.18, to: 0, ease: PARTICLE_EASE.QUAD_IN },
          tint: 0xff9030,
        },
      },
      // The smoke column.
      {
        rate: 8,
        cfg: {
          layer: FX_SMOKE, count: 0, x: around(x, 8 * s), y: around(y - 70 * s, 8 * s), angleXY: range(255, 285),
          speed: range(0.3 * s, 0.7 * s), drag: 0.5, gravity: -0.012 * s, lifespan: range(4000, 6000),
          rotation: ALL_WAYS, angularVelocity: range(-0.03, 0.03), texture: 'fxPuff',
          scale: { from: range(0.3 * s, 0.4 * s), to: range(1.6 * s, 2.2 * s), ease: PARTICLE_EASE.QUAD_OUT },
          alpha: { from: 0.45, to: 0, ease: PARTICLE_EASE.QUAD_IN },
          tint: { from: 0x332a26, to: 0x707078 },
        },
      },
      // Sparks.
      {
        rate: 22,
        cfg: {
          layer: FX_GLOW, count: 0, x: around(x, 12 * s), y: around(y - 14 * s, 6 * s), angleXY: range(245, 295),
          speed: range(1 * s, 3.5 * s), drag: 0.9, gravity: -0.01 * s, lifespan: range(1000, 2200),
          texture: '_whiteCircle',
          scale: { from: range(0.1, 0.18), to: 0.02 },
          alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN },
          tint: { from: 0xffe090, to: 0xff4010 },
        },
      },
    ];
  }

  /** Emits this frame's share of each kind at its rate (per second). */
  update(deltaMs) {
    const dt = deltaMs * 0.001;
    for (let k = 0; k < this.kinds.length; k++) {
      const { rate, cfg } = this.kinds[k];
      const owed = this.owed[k] + rate * dt;
      const n = Math.floor(owed);
      this.owed[k] = owed - n;
      if (n > 0) {
        cfg.count = n;
        ParticleEmitter.emitGpu(cfg);
      }
    }
  }
}
