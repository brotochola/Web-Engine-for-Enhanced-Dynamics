// gpuGalaxyScene.js – as many GPU particles as the engine keeps alive at once: a spiral galaxy of additive dots.
//
// Each logic worker runs one Arm, and each Arm writes its own ring of the GPU particle layer (ParticleEmitter.emitGpu),
// at the rate that keeps that ring full: every dot lives LIFE_MS, so the ring is rewritten once per life. The arms
// turn, so the dots each one throws out lie on a spiral. The galaxy follows the mouse.
//   ?particles=<n>       the layer's maxParticles, split between the arms (default 4 194 304)
//   ?arms=<n>            logic workers, one arm each (default 4)
//   ?backend=webgl       Pixi's WebGL backend (default WebGPU, the engine's)
//   ?batchMs=<n>         an arm throws its dots once every n ms of the clock, not every tick (default 0)

import WEED from '/src/index.js';

const { Scene, GameObject, ParticleEmitter, GpuParticles, Mouse, Camera, Time, LAYER_KIND, BLEND_MODES, PARTICLE_EASE } = WEED;

function param(name, fallback) {
  const search = globalThis.location?.search;
  const value = typeof search === 'string' ? new URLSearchParams(search).get(name) : null;
  return value == null || value === '' ? fallback : value;
}

const PARTICLES = Math.max(1024, parseInt(param('particles', '4194304'), 10) || 4194304);
const ARMS = Math.max(1, Math.min(8, parseInt(param('arms', '4'), 10) || 4));
const BACKEND = param('backend', 'webgpu') === 'webgl' ? 'webgl' : 'webgpu';
const BATCH_MS = Math.max(0, Math.min(50, Number(param('batchMs', '0')) || 0));

const WORLD_W = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1920;
const WORLD_H = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 1080;
const LAYER = 'galaxy';
/** Every dot's life (ms). An arm throws a little less than a ring's worth of dots per life. */
const LIFE_MS = 5000;
/**
 * The most time one call covers (ms): its dots are born over it, so a call lives up to LIFE_MS + STEP_MS and the
 * next brings STEP_MS more. 0.97 of a ring per life then never laps a live dot. After a longer stall an arm does not
 * catch up.
 */
const STEP_MS = 50;
const FILL = 0.97;
/** How fast the arms turn (degrees per ms), and how wide an arm throws (degrees either side). */
const TURN = 0.08;
const SPREAD = 8;
const COLORS = [0x47c6ff, 0xff4fd8, 0xffa63d, 0x8f6bff, 0x5dffa8, 0xff5a5a, 0xfff15a, 0x6ff0ff];

/**
 * One spiral arm, pinned to its own logic worker (forceProcessOnLogicWorker): its onSpawned and its ticks run there,
 * so its fields live there, and its dots go to that worker's ring. A worker does not see the page's query string or
 * window, so the arm count comes with the spawn and the view's center from the camera.
 */
export class Arm extends GameObject {
  static components = [];

  onSpawned({ arm = 0, arms = 1, batchMs = 0 } = {}) {
    this.batchMs = batchMs; // ?batchMs: one call per batchMs of the clock, its dots born over it
    this.angle = (arm * 360) / arms; // where the arm throws its dots now (degrees)
    this.sweptFrom = this.angle; // the angle at its last call
    this.rate = NaN; // dots per ms that keep this worker's ring full
    this.owed = 0; // dots not thrown yet (the fraction carries over)
    // The clock the dots age by (Time.simNowMs) at the last tick: an arm meters its dots on it, not on its own
    // worker's frame time, so a ring never holds more than a life of them.
    this.lastNowMs = NaN;
    // The emitGpu config, made once: a tick sets its count, its source, its angle and its delay.
    this.dots = {
      layer: LAYER,
      count: 0,
      x: 0,
      y: 0,
      angleXY: { min: 0, max: 0 },
      speed: { min: 2.3, max: 2.8 },
      drag: 0.32,
      delay: { min: 0, max: 0 }, // born over the frame, not all at its start
      lifespan: LIFE_MS,
      scale: { from: 0.3, to: 0.16 },
      alpha: { from: 0.1, to: 0, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0x000000, to: COLORS[arm % COLORS.length], ease: PARTICLE_EASE.QUAD_OUT },
      texture: '_white',
    };
  }

  tick() {
    const now = Time.simNowMs;
    if (Number.isNaN(this.lastNowMs)) {
      this.lastNowMs = now;
      this.rate = (GpuParticles.stats(LAYER)[GpuParticles.writerSlot].capacity * FILL) / LIFE_MS;
      return;
    }
    const elapsed = now - this.lastNowMs;
    if (elapsed < this.batchMs) return;
    this.lastNowMs = now;
    this.angle += TURN * elapsed;
    const dt = elapsed < STEP_MS ? elapsed : STEP_MS;
    this.owed += this.rate * dt;
    const count = Math.floor(this.owed);
    if (count === 0) return;
    this.owed -= count;
    const dots = this.dots;
    dots.count = count;
    dots.x = Mouse.isPresent ? Mouse.x : Camera.centerX;
    dots.y = Mouse.isPresent ? Mouse.y : Camera.centerY;
    // Over the angle the arm swept since its last call: a long frame leaves no notch in the spiral.
    dots.angleXY.min = this.sweptFrom - SPREAD;
    dots.angleXY.max = this.angle + SPREAD;
    this.sweptFrom = this.angle;
    dots.delay.max = dt;
    ParticleEmitter.emitGpu(dots);
  }
}

const HUD_CSS =
  'position:fixed;left:12px;bottom:12px;z-index:940;pointer-events:none;color:#eee;' +
  'font:14px/1.45 system-ui,sans-serif;background:rgba(0,0,0,0.55);padding:8px 12px;border-radius:6px;';

export class GpuGalaxyScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,
    physics: { enabled: false },
    spatial: { numberOfSpatialWorkers: 0, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: ARMS },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
    renderer: { backend: BACKEND },
    layers: {
      [LAYER]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 3,
        maxParticles: PARTICLES,
        gpuRings: { main: 0, logic: 1, particle: 0 }, // only the arms emit
        blendMode: BLEND_MODES.ADD,
      },
    },
  };

  static entities = [[Arm, ARMS]];

  create() {
    Camera.setZoom(1);
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
    this._buildHud();
  }

  createNewGame() {
    for (let arm = 0; arm < ARMS; arm++) Arm.spawn({ arm, arms: ARMS, batchMs: BATCH_MS, forceProcessOnLogicWorker: arm });
  }

  async destroy() {
    clearInterval(this._hudTimer);
    this._hud?.remove();
    this._hud = null;
    await super.destroy();
  }

  /** Dots alive: what the rings published over the last life, sampled four times a second. */
  _buildHud() {
    const hud = document.createElement('div');
    hud.style.cssText = HUD_CSS;
    document.body.append(hud);
    this._hud = hud;
    const samples = Math.round(LIFE_MS / 250) + 1;
    const history = new Float64Array(samples); // dots published so far, at each of the last `samples` samples
    let last = null; // each ring's published count at the last sample (uint32: it wraps)
    let total = 0;
    let at = 0;
    this._hudTimer = setInterval(() => {
      const rings = GpuParticles.stats(LAYER);
      if (!rings) return;
      if (last === null) last = rings.map((ring) => ring.published);
      let capacity = 0;
      rings.forEach((ring, i) => {
        total += (ring.published - last[i]) >>> 0;
        last[i] = ring.published;
        capacity += ring.capacity;
      });
      history[at % samples] = total;
      const lifeAgo = at >= samples - 1 ? history[(at + 1) % samples] : 0;
      at++;
      const alive = Math.min(capacity, total - lifeAgo);
      hud.textContent = `${alive.toLocaleString()} GPU particles alive (${capacity.toLocaleString()} slots, ${ARMS} arms)`;
    }, 250);
  }
}
