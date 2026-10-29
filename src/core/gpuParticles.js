// GPU particles: emitted from any writer thread into LAYER_KIND.GPU_PARTICLES layers, then computed entirely in the
// renderer's vertex shader from what they were born with (gpuParticleEval.js is the same math in JS). Nothing reads
// them back: they do not collide, cannot be queried, are not saved, and cost nothing per frame on the CPU.
//
// Memory (gpuParticleLayout.js): each GPU layer has one SharedArrayBuffer with one ring per writer thread (main,
// each logic worker, the particle worker). A writer only ever touches its own ring, so there are no locks: it
// writes records and a group row, then publishes the counts. ParticleEmitter.emitGpu is the public entry point.
//
// Emitting makes no garbage. A config is read once per call into typed arrays (samplers: a value, or a range drawn
// per particle), the generator's numbers come in batches (rngFill), and no double crosses a call: TurboFan boxes a
// double passed to or returned from a call it does not inline, and emit runs per particle. The numbers are drawn in
// the order the per-key resolvers drew them (randomRange, resolveParticleOp, resolveParticleColorOp), so a seed
// gives the same particles.

import { Layer } from './layer.js';
import { Time } from './timeScale.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { LAYER_KIND, PARTICLE_EASE } from '../util/configDefaults.js';
import { rngFill } from '../util/utils.js';
import { PARTICLE_EASE_SHIFT, isFromToObject, resolveEaseId } from '../util/particleTween.js';
import {
  GPU_FLAG,
  GPU_FRAME_MS,
  GPU_GROUP,
  GPU_GROUP_FLAG,
  GPU_GROUP_WORDS,
  GPU_MAX_FRAMES,
  GPU_REC,
  GPU_RECORD_FLOATS,
  GPU_RING,
  gpuLayerLayout,
  gpuRingCapacities,
  gpuWriterCount,
  proxyMemoryBytes,
} from '../util/gpuParticleLayout.js';

/** A ring with nothing alive moves its epoch to now when it is this far behind (keeps float32 births precise). */
const EPOCH_REBASE_MS = 60000;
/**
 * E-161: a call this soon (sim ms) after the call that opened the ring's last group joins that group, so the calls
 * of one frame (an entity's tick each) share a group instead of spending one each out of the ring's 2 048.
 */
export const GPU_GROUP_JOIN_MS = 8;
/** A group that ends sooner than this after a call takes no more calls: a reader may already have passed it. */
const GPU_GROUP_JOIN_LIVE_MS = 100;
/** Bounds padding when a frame's size is unknown, px per unit of scale. */
const DEFAULT_HALF_SIZE = 32;

/** CPU emit keys GPU particles do not have; each is reported once. */
const UNSUPPORTED_KEYS = [
  'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact', 'bounces', 'bounciness', 'bounceFriction',
  'lightIntensity', 'layers', 'renderOnly', 'blendMode', 'rotC', 'rotS', 'wind', 'turbulence',
];

/** Samplers: a key's value, or the range it is drawn from per particle (randomRange's rule). */
const S = Object.freeze({
  X: 0, Y: 1, SPEED: 2, SPREAD: 3, ANGLE: 4, VX: 5, VY: 6, Z: 7, VZ: 8, DRAG: 9, LIFE: 10, DELAY: 11,
  SCALE_X_FROM: 12, SCALE_X_TO: 13, SCALE_Y_FROM: 14, SCALE_Y_TO: 15, ALPHA_FROM: 16, ALPHA_TO: 17,
  ROT_FROM: 18, ROT_TO: 19, SPIN_FROM: 20, SPIN_TO: 21,
});
const SAMPLERS = 22;
/** 1: drawn per particle as lo + r * span; 0: lo. */
const KIND = new Uint8Array(SAMPLERS);
const LO = new Float64Array(SAMPLERS);
const SPAN = new Float64Array(SAMPLERS);

/** Over-life ops (scale x, scale y, alpha, rotation, spin): tweened from → to, or one value (to = from). */
const OP = Object.freeze({ SCALE_X: 0, SCALE_Y: 1, ALPHA: 2, ROT: 3, SPIN: 4 });
const OP_TWEEN = new Uint8Array(5);
const OP_EASE = new Uint8Array(5);

/** Tint endpoints, from and to: [kind, red, green, blue, red span, green span, blue span]; kind 0 is `red` = the color. */
const TINT_FROM = 0;
const TINT_TO = 7;
const TINT = new Float64Array(14);

/** Velocity modes, as emit picks them. */
const BY_DIRECTION = 0;
const BY_ANGLE = 1;
const BY_AXES = 2;

/** Particles per batch of generator numbers, and the most numbers one particle draws. */
const BATCH = 256;
const MAX_DRAWS = 24;
const RND = new Float64Array(BATCH * MAX_DRAWS);

/** Per call: [now, the frames' half size, the default sortY]. */
const CALL = new Float64Array(3);
const NOW = 0;
const HALF = 1;
const CENTER_Y = 2;

/** travelExtent's input [p0, v0, a, d, T] and output [min, max]. */
const TRAVEL = new Float64Array(5);
const EXTENT = new Float64Array(2);

/** randomRange(value, def) as sampler `s`. Returns the numbers it draws per particle. */
function setSampler(s, value, def) {
  if (value === undefined || value === null) {
    KIND[s] = 0;
    LO[s] = def;
    SPAN[s] = 0;
    return 0;
  }
  if (typeof value === 'number') {
    KIND[s] = 0;
    LO[s] = value;
    SPAN[s] = 0;
    return 0;
  }
  const min = value.min ?? def;
  const max = value.max ?? def;
  KIND[s] = 1;
  LO[s] = min;
  SPAN[s] = max - min;
  return 1;
}

/**
 * resolveParticleOp(value, def) as op `op` with samplers `from` and `to`: a value or a range drawn once (to = from),
 * or from → to with an ease. Returns the numbers it draws per particle.
 */
function setOp(op, from, to, value, def) {
  if (value !== undefined && value !== null && typeof value !== 'number' && isFromToObject(value)) {
    OP_TWEEN[op] = 1;
    OP_EASE[op] = resolveEaseId(value.ease);
    return setSampler(from, value.from ?? value.start ?? def, def) + setSampler(to, value.to ?? value.end ?? def, def);
  }
  OP_TWEEN[op] = 0;
  OP_EASE[op] = PARTICLE_EASE.LERP;
  return setSampler(from, value, def);
}

/** randomColor(value, def) as tint endpoint `at`. Returns the numbers it draws per particle. */
function setColor(at, value, def) {
  if (value === undefined || value === null || typeof value === 'number') {
    TINT[at] = 0;
    TINT[at + 1] = value ?? def;
    return 0;
  }
  const min = value.min ?? def;
  const max = value.max ?? def;
  TINT[at] = 1;
  TINT[at + 1] = (min >> 16) & 0xff;
  TINT[at + 2] = (min >> 8) & 0xff;
  TINT[at + 3] = min & 0xff;
  TINT[at + 4] = ((max >> 16) & 0xff) - ((min >> 16) & 0xff);
  TINT[at + 5] = ((max >> 8) & 0xff) - ((min >> 8) & 0xff);
  TINT[at + 6] = (max & 0xff) - (min & 0xff);
  return 1;
}

/** Tint endpoint `at` for a particle, drawing RND[r] when it is a range (randomColor's per-channel lerp). */
function colorAt(at, r) {
  if (TINT[at] === 0) return TINT[at + 1] | 0;
  const t = RND[r];
  const red = Math.round(TINT[at + 1] + t * TINT[at + 4]);
  const green = Math.round(TINT[at + 2] + t * TINT[at + 5]);
  const blue = Math.round(TINT[at + 3] + t * TINT[at + 6]);
  return (red << 16) | (green << 8) | blue;
}

/** centerOf(cfg.y) into CALL[CENTER_Y]: the group's default sortY. */
function setCenterY(v) {
  if (typeof v === 'number') {
    CALL[CENTER_Y] = v;
  } else if (v && typeof v === 'object') {
    const lo = Number.isFinite(v.min) ? v.min : 0;
    const hi = Number.isFinite(v.max) ? v.max : lo;
    CALL[CENTER_Y] = (lo + hi) * 0.5;
  } else {
    CALL[CENTER_Y] = 0;
  }
}

/**
 * Min and max over [0, T] frames of the position from TRAVEL = [p0, v0, a, d, T], into EXTENT: the ends, and the
 * turning point when it is inside.
 */
function travelExtent() {
  const p0 = TRAVEL[0];
  const v0 = TRAVEL[1];
  const a = TRAVEL[2];
  const d = TRAVEL[3];
  const T = TRAVEL[4];
  let lo = p0;
  let hi = p0;
  let end;
  let tStar = -1;
  if (d < 1e-5) {
    end = p0 + v0 * T + (a * (T * T + T)) * 0.5;
    if (a !== 0) tStar = -v0 / a - 0.5;
  } else {
    const terminal = a / d;
    end = p0 + terminal * T + ((v0 - terminal) * (1 - Math.exp(-d * T))) / d;
    const den = terminal - v0;
    if (den !== 0) {
      const ratio = terminal / den;
      if (ratio > 0 && ratio < 1) tStar = -Math.log(ratio) / d;
    }
  }
  if (end < lo) lo = end;
  if (end > hi) hi = end;
  if (tStar > 0 && tStar < T) {
    let p;
    if (d < 1e-5) p = p0 + v0 * tStar + (a * (tStar * tStar + tStar)) * 0.5;
    else {
      const terminal = a / d;
      p = p0 + terminal * tStar + ((v0 - terminal) * (1 - Math.exp(-d * tStar))) / d;
    }
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  EXTENT[0] = lo;
  EXTENT[1] = hi;
}

/** One ring's views. The writer's own state lives here too (only the owning realm writes it). */
function bindRing(sab, r) {
  const liveUntil = new Float64Array(1);
  liveUntil[0] = -Infinity;
  const joinUntil = new Float64Array(1);
  joinUntil[0] = -Infinity;
  return {
    capacity: r.capacity,
    groupCapacity: r.groupCapacity,
    header: new Int32Array(sab, r.headerByte, 16),
    epoch: new Float64Array(sab, r.headerByte + GPU_RING.EPOCH_F64 * 8, 1),
    records: new Float32Array(sab, r.recordsByte, r.capacity * GPU_RECORD_FLOATS),
    recordBits: new Uint32Array(sab, r.recordsByte, r.capacity * GPU_RECORD_FLOATS),
    groups: new Float32Array(sab, r.groupsByte, r.groupCapacity * GPU_GROUP_WORDS),
    groupBits: new Uint32Array(sab, r.groupsByte, r.groupCapacity * GPU_GROUP_WORDS),
    // writer-side: the oldest group that may still be alive, and the absolute time its newest group ends
    oldestLive: 0,
    liveUntil,
    // writer-side: until when (absolute sim ms) the ring's last group takes more calls (E-161)
    joinUntil,
  };
}

export class GpuParticles {
  /** This realm's ring in every GPU layer (gpuParticleLayout writer slots); -1 = this thread cannot emit. */
  static writerSlot = -1;
  /** Writer rings per GPU layer (gpuWriterCount): main, each logic worker, the particle worker. */
  static writers = 0;
  /** The y-sort proxies' splits, A and B (gpuParticleProxies.js), when a layer sorts with the entities. */
  static proxySab = null;
  /** @type {Array<null | { id: number, name: string, sab: SharedArrayBuffer, layout: object, rings: object[], sortWithEntities: boolean, look: boolean, pixelSnap: boolean, maxParticles: number }>} */
  static _layers = [];
  static _warned = new Set();
  static _frameIds = new Uint16Array(GPU_MAX_FRAMES);
  /** _resolveFrames' result: frames cycled over life, and how many `anim: 'random'` picks from. */
  static _frameCount = 1;
  static _frameRandom = 0;

  /**
   * Main thread, after Layer.initializeFromConfig: one memory per GPU_PARTICLES layer.
   * @param {Record<string, object>} layersConfig scene config.layers
   * @param {number} numberOfLogicWorkers
   */
  static initializeFromConfig(layersConfig = {}, numberOfLogicWorkers = 1) {
    this.reset();
    const writers = gpuWriterCount(numberOfLogicWorkers);
    this.writers = writers;
    for (const [name, config] of Object.entries(layersConfig || {})) {
      if (config?.kind !== LAYER_KIND.GPU_PARTICLES) continue;
      const layer = Layer.get(name);
      if (!layer) continue;
      const shares = this._ringShares(config.gpuRings, numberOfLogicWorkers, writers);
      const caps = gpuRingCapacities(config.maxParticles ?? 100000, writers, shares);
      const layout = gpuLayerLayout(caps);
      const sab = new SharedArrayBuffer(layout.bytes);
      this._bindLayer({
        id: layer.id,
        name,
        sab,
        layout,
        sortWithEntities: config.sortWithEntities === true,
        // A look shader: among the entities its finished target is drawn in regions (gpuParticleProxies.js).
        look: !!config.shader?.fragment,
        pixelSnap: config.pixelSnap === true,
        maxParticles: caps.reduce((a, b) => a + b, 0),
        // What the config asked for, for the warnings that say how much of it a thread's ring got.
        requested: config.maxParticles ?? 100000,
      });
    }
    if (this._layers.some((l) => l && l.sortWithEntities)) this.proxySab = new SharedArrayBuffer(proxyMemoryBytes());
    return this;
  }

  /** `gpuRings: { main, logic, particle }` weights: logic's weight goes to every logic worker. */
  static _ringShares(spec, numberOfLogicWorkers, writers) {
    if (!spec || typeof spec !== 'object') return null;
    const shares = new Array(writers).fill(1);
    const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
    shares[0] = num(spec.main, 1);
    const logic = num(spec.logic, 1);
    for (let i = 1; i < writers - 1; i++) shares[i] = logic / Math.max(1, numberOfLogicWorkers | 0);
    shares[writers - 1] = num(spec.particle, 1);
    return shares;
  }

  static _bindLayer(info) {
    const rings = info.layout.rings.map((r) => bindRing(info.sab, r));
    // This realm's once-only warnings for the layer (emit warns on a cut call and on lapping live particles).
    this._layers[info.id] = { ...info, rings, warnedClamp: false, warnedOverflow: false };
  }

  /** Posted to workers with the scene's init data. */
  static getSerializableData() {
    return {
      writers: this.writers,
      proxySab: this.proxySab,
      layers: this._layers
        .filter(Boolean)
        .map(({ rings, warnedClamp, warnedOverflow, ...rest }) => rest),
    };
  }

  /** Workers: bind the memories the main thread made. */
  static initializeFromBuffers(data) {
    this._layers = [];
    this._warned.clear();
    this.writers = data?.writers | 0;
    this.proxySab = data?.proxySab || null;
    for (const info of data?.layers || []) this._bindLayer(info);
  }

  /** The particle worker's writer slot (the last ring). */
  static get particleWorkerSlot() {
    return this.writers - 1;
  }

  static reset() {
    this._layers = [];
    this._warned.clear();
    this.writers = 0;
    this.writerSlot = -1;
    this.proxySab = null;
  }

  /** The GPU layers, by id (null holes for other layers). */
  static get layers() {
    return this._layers;
  }

  /** @param {string|number} layer */
  static layerOf(layer) {
    if (typeof layer === 'number') return this._layers[layer] || null;
    const l = typeof layer === 'string' ? Layer.get(layer) : null;
    return l ? this._layers[l.id] || null : null;
  }

  /** Warn once per key in this realm; the message is built only the first time. */
  /** How a thread's ring came out of the layer's maxParticles, and how to give it more (the warnings' advice). */
  static _ringShareText(info, ring) {
    const writers = info.rings.length;
    return `maxParticles ${info.requested} is split between ${writers} writer rings (the main thread, each logic worker, the particle worker), each rounded down to a power of two: this one got ${ring.capacity}. Give the thread that emits a larger share with gpuRings (for example { main: 0, logic: 1, particle: 0 } when only entities emit), or raise maxParticles.`;
  }

  static _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(msg);
  }

  /**
   * Emit GPU particles: ParticleEmitter.emitGpu's body (the one public way to emit). Returns how many were written.
   * @param {object} cfg
   */
  static _emit(cfg) {
    if (!cfg) return 0;
    const info = this.layerOf(cfg.layer);
    if (!info) {
      this._warnOnce(`layer:${cfg.layer}`, `ParticleEmitter.emitGpu: "${cfg.layer}" is not a GPU_PARTICLES layer`);
      return 0;
    }
    const slot = this.writerSlot;
    const ring = slot >= 0 ? info.rings[slot] : null;
    if (!ring) {
      this._warnOnce('writer', 'ParticleEmitter.emitGpu: GPU particles are emitted from the main thread, a logic worker or the particle worker');
      return 0;
    }
    for (let k = 0; k < UNSUPPORTED_KEYS.length; k++) {
      const key = UNSUPPORTED_KEYS[k];
      if (cfg[key] !== undefined && !this._warned.has(key)) {
        this._warnOnce(key, `ParticleEmitter.emitGpu: "${key}" is not supported by GPU particles and is ignored`);
      }
    }
    // count: randomRange(cfg.count, 1), rounded
    let count;
    const countCfg = cfg.count;
    if (countCfg === undefined || countCfg === null) {
      count = 1;
    } else if (typeof countCfg === 'number') {
      count = Math.round(countCfg);
    } else {
      setSampler(S.X, countCfg, 1);
      rngFill(RND, 0, 1);
      count = Math.round(LO[S.X] + RND[0] * SPAN[S.X]);
    }
    if (!(count > 0)) return 0;
    const n = count > ring.capacity ? ring.capacity : count;
    if (n < count && !info.warnedClamp) {
      info.warnedClamp = true;
      console.warn(`ParticleEmitter.emitGpu: ${count} particles is more than this thread's ring in "${info.name}" holds (${ring.capacity}); ${n} were written. ${this._ringShareText(info, ring)}`);
    }

    // Epoch: births are float32 ms after it, so a quiet ring moves it to now.
    const header = ring.header;
    Time.readSimNowInto(CALL, NOW);
    const now = CALL[NOW];
    if (now >= ring.liveUntil[0] && (now - ring.epoch[0] > EPOCH_REBASE_MS || Atomics.load(header, GPU_RING.EPOCH_GEN) === 0)) {
      ring.epoch[0] = now;
      Atomics.add(header, GPU_RING.EPOCH_GEN, 1);
    }
    const nowRel = now - ring.epoch[0];

    // Overflow: records still alive about to be overwritten.
    const cursor = Atomics.load(header, GPU_RING.PUBLISHED) >>> 0;
    const groupCursor = Atomics.load(header, GPU_RING.GROUPS) >>> 0;
    this._advanceOldestLive(ring, groupCursor);
    if (ring.oldestLive !== groupCursor) {
      const g = (ring.oldestLive & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
      const firstLive = ring.groupBits[g + GPU_GROUP.FIRST] >>> 0;
      const groupsFull = ((groupCursor - ring.oldestLive) >>> 0) >= ring.groupCapacity;
      if (((cursor + n - firstLive) >>> 0) > ring.capacity || groupsFull) {
        Atomics.add(header, GPU_RING.OVERFLOW, 1);
        if (!info.warnedOverflow) {
          info.warnedOverflow = true;
          console.warn(`ParticleEmitter.emitGpu: "${info.name}" wrote over particles that were still alive: this thread's ring holds ${ring.capacity} particles and ${ring.groupCapacity} emitGpu calls. ${this._ringShareText(info, ring)} Or make fewer, larger calls.`);
        }
      }
    }

    const heighted = cfg.heighted === true;
    if (!heighted && (cfg.z !== undefined || cfg.vz !== undefined)) {
      // emitGpu defaults to emitFlat's model; a config moved over from emit keeps z / vz and would silently lose them.
      this._warnOnce('flat-z', 'ParticleEmitter.emitGpu: "z" and "vz" move a particle only with heighted: true (emit\'s model); without it they are ignored and gravity pulls on vy, as in emitFlat');
    }
    this._resolveFrames(cfg);
    const frameRandom = this._frameRandom;
    let flags = (heighted ? GPU_FLAG.HEIGHTED : 0) | ((this._frameCount - 1) << GPU_FLAG.FRAMES_SHIFT);
    if (cfg.flipX) flags |= GPU_FLAG.FLIP_X;
    if (cfg.flipY) flags |= GPU_FLAG.FLIP_Y;
    const frameIds = this._frameIds;
    const tex01 = (frameIds[0] | (frameIds[1] << 16)) >>> 0;
    const tex23 = (frameIds[2] | (frameIds[3] << 16)) >>> 0;
    const tex45 = (frameIds[4] | (frameIds[5] << 16)) >>> 0;
    const tex67 = (frameIds[6] | (frameIds[7] << 16)) >>> 0;
    const gravity = cfg.gravity ?? (heighted ? 0.15 : 0);

    // The config, once: samplers, ops, tint, and the numbers a particle draws (in the order it draws them).
    let draws = setSampler(S.X, cfg.x, 0) + setSampler(S.Y, cfg.y, 0);
    let mode;
    let spreadByValue = false;
    let spreadSampled = false;
    let dirX = 0;
    let dirY = 0;
    let spreadValue = 0;
    if (cfg.dirX != null && cfg.dirY != null && cfg.speed !== undefined) {
      mode = BY_DIRECTION;
      dirX = cfg.dirX;
      dirY = cfg.dirY;
      draws += setSampler(S.SPEED, cfg.speed, 0);
      if (cfg.spread != null) {
        if (typeof cfg.spread === 'number') {
          spreadByValue = true;
          spreadValue = cfg.spread;
          draws += 1;
        } else {
          spreadSampled = true;
          draws += setSampler(S.SPREAD, cfg.spread, 0);
        }
      }
    } else if (cfg.angleXY !== undefined && cfg.speed !== undefined) {
      mode = BY_ANGLE;
      draws += setSampler(S.ANGLE, cfg.angleXY, 0) + setSampler(S.SPEED, cfg.speed, 0);
    } else {
      mode = BY_AXES;
      draws += setSampler(S.VX, cfg.vx, 0) + setSampler(S.VY, cfg.vy, 0);
    }
    if (heighted) draws += setSampler(S.Z, cfg.z, 0) + setSampler(S.VZ, cfg.vz, 0);
    draws += setSampler(S.DRAG, cfg.drag, 0) + setSampler(S.LIFE, cfg.lifespan, 1000) + setSampler(S.DELAY, cfg.delay, 0);
    const scaleXY = cfg.scale == null && cfg.scaleX != null && cfg.scaleY != null;
    if (scaleXY) {
      draws += setOp(OP.SCALE_X, S.SCALE_X_FROM, S.SCALE_X_TO, cfg.scaleX, 1);
      draws += setOp(OP.SCALE_Y, S.SCALE_Y_FROM, S.SCALE_Y_TO, cfg.scaleY, 1);
    } else {
      draws += setOp(OP.SCALE_X, S.SCALE_X_FROM, S.SCALE_X_TO, cfg.scale ?? cfg.scaleX ?? cfg.scaleY, 1);
    }
    draws += setOp(OP.ALPHA, S.ALPHA_FROM, S.ALPHA_TO, cfg.alpha, 1);
    const tint = cfg.tint;
    let tintTween = false;
    let tintEase = PARTICLE_EASE.LERP;
    if (tint !== undefined && tint !== null && typeof tint !== 'number' && isFromToObject(tint)) {
      tintTween = true;
      tintEase = resolveEaseId(tint.ease);
      draws += setColor(TINT_FROM, tint.from ?? tint.start ?? 0xffffff, 0xffffff);
      draws += setColor(TINT_TO, tint.to ?? tint.end ?? 0xffffff, 0xffffff);
    } else {
      draws += setColor(TINT_FROM, tint, 0xffffff);
    }
    draws += setOp(OP.ROT, S.ROT_FROM, S.ROT_TO, cfg.rotation, 0);
    const spins = cfg.angularVelocity != null;
    if (spins) draws += setOp(OP.SPIN, S.SPIN_FROM, S.SPIN_TO, cfg.angularVelocity, 0);
    if (frameRandom) draws += 1;
    let easeBase = flags;
    easeBase |= OP_EASE[OP.SCALE_X] << PARTICLE_EASE_SHIFT.SCALEX;
    easeBase |= OP_EASE[scaleXY ? OP.SCALE_Y : OP.SCALE_X] << PARTICLE_EASE_SHIFT.SCALEY;
    easeBase |= OP_EASE[OP.ALPHA] << PARTICLE_EASE_SHIFT.ALPHA;
    easeBase |= tintEase << PARTICLE_EASE_SHIFT.TINT;
    easeBase |= OP_EASE[OP.ROT] << PARTICLE_EASE_SHIFT.ROT;
    if (spins) easeBase |= OP_EASE[OP.SPIN] << PARTICLE_EASE_SHIFT.ANGULAR_VELOCITY;
    const easeBits = easeBase >>> 0;
    const halfSize = CALL[HALF];

    const rec = ring.records;
    const bits = ring.recordBits;
    const cap = ring.capacity;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let birthMin = Infinity, endMax = -Infinity;

    for (let first = 0; first < n; first += BATCH) {
      const batch = n - first < BATCH ? n - first : BATCH;
      if (draws > 0) rngFill(RND, 0, batch * draws);
      let r = 0;
      for (let k = first; k < first + batch; k++) {
        const b = ((cursor + k) & (cap - 1)) * GPU_RECORD_FLOATS;
        const x0 = KIND[S.X] ? LO[S.X] + RND[r++] * SPAN[S.X] : LO[S.X];
        const y0 = KIND[S.Y] ? LO[S.Y] + RND[r++] * SPAN[S.Y] : LO[S.Y];
        let vx;
        let vy;
        if (mode === BY_DIRECTION) {
          const speed = KIND[S.SPEED] ? LO[S.SPEED] + RND[r++] * SPAN[S.SPEED] : LO[S.SPEED];
          let dx = dirX;
          let dy = dirY;
          if (spreadByValue || spreadSampled) {
            let ang;
            if (spreadByValue) ang = (RND[r++] * 2 - 1) * spreadValue;
            else ang = KIND[S.SPREAD] ? LO[S.SPREAD] + RND[r++] * SPAN[S.SPREAD] : LO[S.SPREAD];
            if (ang !== 0) {
              const c = Math.cos(ang);
              const s = Math.sin(ang);
              const rdx = dx * c - dy * s;
              dy = dx * s + dy * c;
              dx = rdx;
            }
          }
          vx = dx * speed;
          vy = dy * speed;
        } else if (mode === BY_ANGLE) {
          const angle = ((KIND[S.ANGLE] ? LO[S.ANGLE] + RND[r++] * SPAN[S.ANGLE] : LO[S.ANGLE]) * Math.PI) / 180;
          const speed = KIND[S.SPEED] ? LO[S.SPEED] + RND[r++] * SPAN[S.SPEED] : LO[S.SPEED];
          vx = speed * Math.cos(angle);
          vy = speed * Math.sin(angle);
        } else {
          vx = KIND[S.VX] ? LO[S.VX] + RND[r++] * SPAN[S.VX] : LO[S.VX];
          vy = KIND[S.VY] ? LO[S.VY] + RND[r++] * SPAN[S.VY] : LO[S.VY];
        }
        let z0 = 0;
        let vz = 0;
        if (heighted) {
          z0 = KIND[S.Z] ? LO[S.Z] + RND[r++] * SPAN[S.Z] : LO[S.Z];
          vz = KIND[S.VZ] ? LO[S.VZ] + RND[r++] * SPAN[S.VZ] : LO[S.VZ];
        }
        const drag = ((KIND[S.DRAG] ? LO[S.DRAG] + RND[r++] * SPAN[S.DRAG] : LO[S.DRAG]) * GPU_FRAME_MS) / 1000; // 1/s -> per frame
        const life = KIND[S.LIFE] ? LO[S.LIFE] + RND[r++] * SPAN[S.LIFE] : LO[S.LIFE];
        const delay = KIND[S.DELAY] ? LO[S.DELAY] + RND[r++] * SPAN[S.DELAY] : LO[S.DELAY];
        const birth = nowRel + (delay > 0 ? delay : 0);

        rec[b + GPU_REC.X0] = x0;
        rec[b + GPU_REC.Y0] = y0;
        rec[b + GPU_REC.VX] = vx;
        rec[b + GPU_REC.VY] = vy;
        rec[b + GPU_REC.Z0] = z0;
        rec[b + GPU_REC.VZ] = vz;
        rec[b + GPU_REC.GRAVITY] = gravity;
        rec[b + GPU_REC.DRAG] = drag;
        rec[b + GPU_REC.BIRTH] = birth;
        rec[b + GPU_REC.LIFE] = life;

        const sxFrom = KIND[S.SCALE_X_FROM] ? LO[S.SCALE_X_FROM] + RND[r++] * SPAN[S.SCALE_X_FROM] : LO[S.SCALE_X_FROM];
        const sxTo = OP_TWEEN[OP.SCALE_X]
          ? (KIND[S.SCALE_X_TO] ? LO[S.SCALE_X_TO] + RND[r++] * SPAN[S.SCALE_X_TO] : LO[S.SCALE_X_TO])
          : sxFrom;
        let syFrom = sxFrom;
        let syTo = sxTo;
        if (scaleXY) {
          syFrom = KIND[S.SCALE_Y_FROM] ? LO[S.SCALE_Y_FROM] + RND[r++] * SPAN[S.SCALE_Y_FROM] : LO[S.SCALE_Y_FROM];
          syTo = OP_TWEEN[OP.SCALE_Y]
            ? (KIND[S.SCALE_Y_TO] ? LO[S.SCALE_Y_TO] + RND[r++] * SPAN[S.SCALE_Y_TO] : LO[S.SCALE_Y_TO])
            : syFrom;
        }
        rec[b + GPU_REC.SCALE_X_FROM] = sxFrom;
        rec[b + GPU_REC.SCALE_X_TO] = sxTo;
        rec[b + GPU_REC.SCALE_Y_FROM] = syFrom;
        rec[b + GPU_REC.SCALE_Y_TO] = syTo;
        const scaleMax = Math.max(Math.abs(sxFrom), Math.abs(sxTo), Math.abs(syFrom), Math.abs(syTo));

        const alphaFrom = KIND[S.ALPHA_FROM] ? LO[S.ALPHA_FROM] + RND[r++] * SPAN[S.ALPHA_FROM] : LO[S.ALPHA_FROM];
        rec[b + GPU_REC.ALPHA_FROM] = alphaFrom;
        rec[b + GPU_REC.ALPHA_TO] = OP_TWEEN[OP.ALPHA]
          ? (KIND[S.ALPHA_TO] ? LO[S.ALPHA_TO] + RND[r++] * SPAN[S.ALPHA_TO] : LO[S.ALPHA_TO])
          : alphaFrom;

        const tintFrom = colorAt(TINT_FROM, r);
        if (TINT[TINT_FROM] !== 0) r++;
        let tintTo = tintFrom;
        if (tintTween) {
          tintTo = colorAt(TINT_TO, r);
          if (TINT[TINT_TO] !== 0) r++;
        }
        bits[b + GPU_REC.TINT_FROM_T] = tintFrom & 0xffffff;
        bits[b + GPU_REC.TINT_TO_T] = tintTo & 0xffffff;

        const rotFrom = KIND[S.ROT_FROM] ? LO[S.ROT_FROM] + RND[r++] * SPAN[S.ROT_FROM] : LO[S.ROT_FROM];
        const rotTo = OP_TWEEN[OP.ROT]
          ? (KIND[S.ROT_TO] ? LO[S.ROT_TO] + RND[r++] * SPAN[S.ROT_TO] : LO[S.ROT_TO])
          : rotFrom;
        rec[b + GPU_REC.ROT_FROM] = (rotFrom * Math.PI) / 180;
        rec[b + GPU_REC.ROT_TO] = (rotTo * Math.PI) / 180;
        if (spins) {
          const spinFrom = KIND[S.SPIN_FROM] ? LO[S.SPIN_FROM] + RND[r++] * SPAN[S.SPIN_FROM] : LO[S.SPIN_FROM];
          const spinTo = OP_TWEEN[OP.SPIN]
            ? (KIND[S.SPIN_TO] ? LO[S.SPIN_TO] + RND[r++] * SPAN[S.SPIN_TO] : LO[S.SPIN_TO])
            : spinFrom;
          rec[b + GPU_REC.SPIN_FROM] = (spinFrom * Math.PI) / 180;
          rec[b + GPU_REC.SPIN_TO] = (spinTo * Math.PI) / 180;
        } else {
          rec[b + GPU_REC.SPIN_FROM] = 0;
          rec[b + GPU_REC.SPIN_TO] = 0;
        }
        bits[b + GPU_REC.EASES_T] = easeBits;
        let frame0 = tex01;
        if (frameRandom) {
          // anim: 'random': one frame per particle, kept for its whole life
          const pick = (RND[r++] * frameRandom) | 0;
          frame0 = frameIds[pick < GPU_MAX_FRAMES ? pick : 0];
        }
        bits[b + GPU_REC.TEX01_T] = frame0;
        bits[b + GPU_REC.TEX23_T] = tex23;
        bits[b + GPU_REC.TEX45_T] = tex45;
        bits[b + GPU_REC.TEX67_T] = tex67;
        rec[b + GPU_REC.RESERVED] = 0;

        // Bounds, conservative: the path's extent over its life, padded by the largest sprite.
        const T = life / GPU_FRAME_MS;
        const pad = halfSize * scaleMax;
        TRAVEL[0] = x0;
        TRAVEL[1] = vx;
        TRAVEL[2] = 0;
        TRAVEL[3] = drag;
        TRAVEL[4] = T;
        travelExtent();
        if (EXTENT[0] - pad < minX) minX = EXTENT[0] - pad;
        if (EXTENT[1] + pad > maxX) maxX = EXTENT[1] + pad;
        TRAVEL[0] = y0;
        TRAVEL[1] = vy;
        TRAVEL[2] = heighted ? 0 : gravity;
        travelExtent();
        let lo = EXTENT[0];
        const hi = EXTENT[1];
        if (heighted) {
          TRAVEL[0] = z0;
          TRAVEL[1] = vz;
          TRAVEL[2] = gravity;
          travelExtent();
          if (EXTENT[0] < 0) lo += EXTENT[0];
        }
        if (lo - pad < minY) minY = lo - pad;
        if (hi + pad > maxY) maxY = hi + pad;
        if (birth < birthMin) birthMin = birth;
        if (birth + life > endMax) endMax = birth + life;
      }
    }

    const gw = ring.groups;
    const gb = ring.groupBits;
    const groupFlags = heighted ? GPU_GROUP_FLAG.HEIGHTED : 0;
    const epochGen = Atomics.load(header, GPU_RING.EPOCH_GEN) >>> 0;
    if (cfg.sortY !== undefined && cfg.sortY !== null) CALL[CENTER_Y] = cfg.sortY;
    else setCenterY(cfg.y);
    // E-161: a call soon after the one that opened the ring's last group joins it, where the group's place among
    // the entities cannot move: any layer that does not sort with them, a sorted one on the same row (the same
    // key), never a sorted look layer (its region is its groups' rectangle). The last group must be this epoch's,
    // end where this call's records start, carry the same flags, have room in the ring, and live a while yet.
    const lg = (((groupCursor - 1) >>> 0) & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
    if (
      now <= ring.joinUntil[0] &&
      ((gb[lg + GPU_GROUP.FIRST] + gb[lg + GPU_GROUP.COUNT]) >>> 0) === cursor &&
      gb[lg + GPU_GROUP.EPOCH_GEN] === epochGen &&
      gb[lg + GPU_GROUP.FLAGS] === groupFlags &&
      gb[lg + GPU_GROUP.COUNT] + n <= cap &&
      gw[lg + GPU_GROUP.END_F] > nowRel + GPU_GROUP_JOIN_LIVE_MS &&
      (!info.sortWithEntities ||
        (!info.look && Math.floor(gw[lg + GPU_GROUP.SORT_Y_F] + 0.5) === Math.floor(Math.fround(CALL[CENTER_Y]) + 0.5)))
    ) {
      // Widen, then grow, then publish: a reader that sees the new records sees the group that holds them.
      if (birthMin < gw[lg + GPU_GROUP.BIRTH_F]) gw[lg + GPU_GROUP.BIRTH_F] = birthMin;
      if (endMax > gw[lg + GPU_GROUP.END_F]) gw[lg + GPU_GROUP.END_F] = endMax;
      if (minX < gw[lg + GPU_GROUP.MIN_X_F]) gw[lg + GPU_GROUP.MIN_X_F] = minX;
      if (minY < gw[lg + GPU_GROUP.MIN_Y_F]) gw[lg + GPU_GROUP.MIN_Y_F] = minY;
      if (maxX > gw[lg + GPU_GROUP.MAX_X_F]) gw[lg + GPU_GROUP.MAX_X_F] = maxX;
      if (maxY > gw[lg + GPU_GROUP.MAX_Y_F]) gw[lg + GPU_GROUP.MAX_Y_F] = maxY;
      gb[lg + GPU_GROUP.COUNT] = gb[lg + GPU_GROUP.COUNT] + n;
      Atomics.store(header, GPU_RING.PUBLISHED, (cursor + n) | 0);
    } else {
      // Group row, then publish records before groups (a reader never sees a group whose records are unpublished).
      const g = (groupCursor & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
      gb[g + GPU_GROUP.FIRST] = cursor;
      gb[g + GPU_GROUP.COUNT] = n;
      gw[g + GPU_GROUP.BIRTH_F] = birthMin;
      gw[g + GPU_GROUP.END_F] = endMax;
      gw[g + GPU_GROUP.SORT_Y_F] = CALL[CENTER_Y];
      gw[g + GPU_GROUP.MIN_X_F] = minX;
      gw[g + GPU_GROUP.MIN_Y_F] = minY;
      gw[g + GPU_GROUP.MAX_X_F] = maxX;
      gw[g + GPU_GROUP.MAX_Y_F] = maxY;
      gb[g + GPU_GROUP.EPOCH_GEN] = epochGen;
      gb[g + GPU_GROUP.FLAGS] = groupFlags;
      gb[g + GPU_GROUP.RESERVED] = 0;
      Atomics.store(header, GPU_RING.PUBLISHED, (cursor + n) | 0);
      Atomics.store(header, GPU_RING.GROUPS, (groupCursor + 1) | 0);
      ring.joinUntil[0] = now + GPU_GROUP_JOIN_MS;
    }
    const endAbs = ring.epoch[0] + endMax;
    if (endAbs > ring.liveUntil[0]) ring.liveUntil[0] = endAbs;
    return n;
  }

  /** Writer side: skip groups that ended (CALL[NOW] is the call's clock). */
  static _advanceOldestLive(ring, groupCursor) {
    const now = CALL[NOW];
    const epoch = ring.epoch[0];
    const cap = ring.groupCapacity;
    if (((groupCursor - ring.oldestLive) >>> 0) > cap) ring.oldestLive = (groupCursor - cap) >>> 0;
    while (ring.oldestLive !== groupCursor) {
      const g = (ring.oldestLive & (cap - 1)) * GPU_GROUP_WORDS;
      if (epoch + ring.groups[g + GPU_GROUP.END_F] > now) break;
      ring.oldestLive = (ring.oldestLive + 1) >>> 0;
    }
  }

  /** A frame's half size (px) into CALL[HALF] when it is the largest so far; DEFAULT_HALF_SIZE when unknown. */
  static _noteFrameSize(id) {
    const sheet = SpriteSheetRegistry.getSpritesheetId?.('bigAtlas');
    const dims = sheet ? SpriteSheetRegistry.frameSizeOf(sheet, id) : null;
    const h = dims ? Math.max(dims.w, dims.h) * 0.5 : DEFAULT_HALF_SIZE;
    if (h > CALL[HALF]) CALL[HALF] = h;
  }

  /**
   * Texture ids for `cfg` into _frameIds (animation indices, as CPU particles store them), the frame count and the
   * `anim: 'random'` pick count into _frameCount / _frameRandom, the largest frame's half size into CALL[HALF].
   */
  static _resolveFrames(cfg) {
    const ids = this._frameIds;
    ids.fill(0);
    let count = 1;
    let random = 0;
    CALL[HALF] = 0;
    if (Array.isArray(cfg.frame) && cfg.spritesheet && cfg.animation !== undefined) {
      let wrote = 0;
      for (let f = 0; f < cfg.frame.length && wrote < GPU_MAX_FRAMES; f++) {
        const name = SpriteSheetRegistry.getFrameName(cfg.spritesheet, cfg.animation, cfg.frame[f]);
        if (!name) continue;
        ids[wrote] = SpriteSheetRegistry.getTextureId(name);
        this._noteFrameSize(ids[wrote]);
        wrote++;
      }
      if (wrote > 1 && cfg.anim === 'random') random = wrote;
      else if (wrote > 1) count = wrote;
      if (wrote === 0) this._noteFrameSize(0);
    } else {
      let name = cfg.texture;
      if (cfg.spritesheet && cfg.animation !== undefined) {
        name = SpriteSheetRegistry.getFrameName(cfg.spritesheet, cfg.animation, cfg.frame ?? 0);
      }
      ids[0] = name ? SpriteSheetRegistry.getTextureId(name) : 0;
      this._noteFrameSize(ids[0]);
    }
    if (!(CALL[HALF] > 0)) CALL[HALF] = DEFAULT_HALF_SIZE;
    this._frameCount = count;
    this._frameRandom = random;
  }

  /**
   * Where GPU particle `slot` of `layer`'s writer ring `ring` is now (debugging). Null when the slot holds nothing.
   * @param {string|number} layer
   * @param {number} ring writer slot
   * @param {number} slot record slot in that ring
   * @param {(rec: Float32Array, base: number, now: number) => object} evaluate gpuParticleEval.evaluateGpuParticle
   */
  static evaluate(layer, ring, slot, evaluate) {
    const info = this.layerOf(layer);
    const r = info?.rings[ring | 0];
    if (!r || slot < 0 || slot >= r.capacity) return null;
    return evaluate(r.records, slot * GPU_RECORD_FLOATS, Time.simNowMs - r.epoch[0]);
  }

  /**
   * Fill stats per writer ring of a layer: published records, overflows, capacity.
   * @param {string|number} layer
   */
  static stats(layer) {
    const info = this.layerOf(layer);
    if (!info) return null;
    return info.rings.map((r) => ({
      capacity: r.capacity,
      published: Atomics.load(r.header, GPU_RING.PUBLISHED) >>> 0,
      groups: Atomics.load(r.header, GPU_RING.GROUPS) >>> 0,
      overflows: Atomics.load(r.header, GPU_RING.OVERFLOW) >>> 0,
    }));
  }
}
