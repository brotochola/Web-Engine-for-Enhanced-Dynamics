// GPU particles: emitted from any writer thread into LAYER_KIND.GPU_PARTICLES layers, then computed entirely in the
// renderer's vertex shader from what they were born with (gpuParticleEval.js is the same math in JS). Nothing reads
// them back: they do not collide, cannot be queried, are not saved, and cost nothing per frame on the CPU.
//
// Memory (gpuParticleLayout.js): each GPU layer has one SharedArrayBuffer with one ring per writer thread (main,
// each logic worker, the particle worker). A writer only ever touches its own ring, so there are no locks: it
// writes records and a group row, then publishes the counts. ParticleEmitter.emitGpu is the public entry point.

import { Layer } from './layer.js';
import { Time } from './timeScale.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { LAYER_KIND } from '../util/configDefaults.js';
import { randomRange, rng } from '../util/utils.js';
import { PARTICLE_EASE_SHIFT, resolveParticleColorOp, resolveParticleOp } from '../util/particleTween.js';
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
} from '../util/gpuParticleLayout.js';

/** A ring with nothing alive moves its epoch to now when it is this far behind (keeps float32 births precise). */
const EPOCH_REBASE_MS = 60000;
/** Bounds padding when a frame's size is unknown, px per unit of scale. */
const DEFAULT_HALF_SIZE = 32;

/** CPU emit keys GPU particles do not have; each is reported once. */
const UNSUPPORTED_KEYS = [
  'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact', 'bounces', 'bounciness', 'bounceFriction',
  'lightIntensity', 'layers', 'renderOnly', 'blendMode', 'rotC', 'rotS', 'wind', 'turbulence',
];

// Bounds scratch: [min, max] of one axis (a module Float64Array, so no doubles are boxed across calls).
const EXTENT = new Float64Array(2);

/**
 * Min and max of gpuTravel over [0, T] frames into EXTENT: the ends, and the turning point when it is inside.
 */
function travelExtent(p0, v0, a, d, T) {
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

/** One ring's views. The writer's own counters live here too (only the owning realm writes them). */
function bindRing(sab, r) {
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
    liveUntil: -Infinity,
  };
}

export class GpuParticles {
  /** This realm's ring in every GPU layer (gpuParticleLayout writer slots); -1 = this thread cannot emit. */
  static writerSlot = -1;
  /** Writer rings per GPU layer (gpuWriterCount): main, each logic worker, the particle worker. */
  static writers = 0;
  /** @type {Array<null | { id: number, name: string, sab: SharedArrayBuffer, layout: object, rings: object[], sortWithEntities: boolean, pixelSnap: boolean, maxParticles: number }>} */
  static _layers = [];
  static _warned = new Set();
  static _opA = { from: 0, to: 0, tween: false, ease: 0 };
  static _opB = { from: 0, to: 0, tween: false, ease: 0 };
  static _frameIds = new Uint16Array(GPU_MAX_FRAMES);

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
        pixelSnap: config.pixelSnap === true,
        maxParticles: caps.reduce((a, b) => a + b, 0),
      });
    }
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
    this._layers[info.id] = { ...info, rings };
  }

  /** Posted to workers with the scene's init data. */
  static getSerializableData() {
    return { writers: this.writers, layers: this._layers.filter(Boolean).map(({ rings, ...rest }) => rest) };
  }

  /** Workers: bind the memories the main thread made. */
  static initializeFromBuffers(data) {
    this._layers = [];
    this._warned.clear();
    this.writers = data?.writers | 0;
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

  /** Debug builds warn once per message. */
  static _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(msg);
  }

  /**
   * Emit GPU particles (ParticleEmitter.emitGpu). Returns how many were written.
   * @param {object} cfg
   */
  static emit(cfg) {
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
      if (cfg[key] !== undefined) {
        this._warnOnce(`key:${key}`, `ParticleEmitter.emitGpu: "${key}" is not supported by GPU particles and is ignored`);
      }
    }
    const count = Math.round(randomRange(cfg.count, 1));
    if (!(count > 0)) return 0;
    const n = count > ring.capacity ? ring.capacity : count;

    // Epoch: births are float32 ms after it, so a quiet ring moves it to now.
    const header = ring.header;
    const now = Time.simNowMs;
    if (now >= ring.liveUntil && (now - ring.epoch[0] > EPOCH_REBASE_MS || Atomics.load(header, GPU_RING.EPOCH_GEN) === 0)) {
      ring.epoch[0] = now;
      Atomics.add(header, GPU_RING.EPOCH_GEN, 1);
    }
    const nowRel = now - ring.epoch[0];

    // Overflow: records still alive about to be overwritten.
    const cursor = Atomics.load(header, GPU_RING.PUBLISHED) >>> 0;
    const groupCursor = Atomics.load(header, GPU_RING.GROUPS) >>> 0;
    this._advanceOldestLive(ring, groupCursor, now);
    if (ring.oldestLive !== groupCursor) {
      const g = (ring.oldestLive & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
      const firstLive = ring.groupBits[g + GPU_GROUP.FIRST] >>> 0;
      const groupsFull = ((groupCursor - ring.oldestLive) >>> 0) >= ring.groupCapacity;
      if (((cursor + n - firstLive) >>> 0) > ring.capacity || groupsFull) Atomics.add(header, GPU_RING.OVERFLOW, 1);
    }

    const heighted = cfg.heighted === true;
    const textures = this._resolveFrames(cfg);
    const frameCount = textures.count;
    const halfSize = textures.halfSize;
    let flags = (heighted ? GPU_FLAG.HEIGHTED : 0) | ((frameCount - 1) << GPU_FLAG.FRAMES_SHIFT);
    if (cfg.flipX) flags |= GPU_FLAG.FLIP_X;
    if (cfg.flipY) flags |= GPU_FLAG.FLIP_Y;
    const frameIds = this._frameIds;
    const tex01 = (frameIds[0] | (frameIds[1] << 16)) >>> 0;
    const tex23 = (frameIds[2] | (frameIds[3] << 16)) >>> 0;
    const tex45 = (frameIds[4] | (frameIds[5] << 16)) >>> 0;
    const tex67 = (frameIds[6] | (frameIds[7] << 16)) >>> 0;
    const defaultGravity = heighted ? 0.15 : 0;
    const gravity = cfg.gravity ?? defaultGravity;

    const rec = ring.records;
    const bits = ring.recordBits;
    const cap = ring.capacity;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let birthMin = Infinity, endMax = -Infinity;
    const opA = this._opA;
    const opB = this._opB;

    for (let k = 0; k < n; k++) {
      const b = ((cursor + k) & (cap - 1)) * GPU_RECORD_FLOATS;
      const x0 = randomRange(cfg.x, 0);
      const y0 = randomRange(cfg.y, 0);
      let vx;
      let vy;
      if (cfg.dirX != null && cfg.dirY != null && cfg.speed !== undefined) {
        const speed = randomRange(cfg.speed, 0);
        let dx = cfg.dirX;
        let dy = cfg.dirY;
        if (cfg.spread != null) {
          const ang = typeof cfg.spread === 'number' ? (rng() * 2 - 1) * cfg.spread : randomRange(cfg.spread, 0);
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
      } else if (cfg.angleXY !== undefined && cfg.speed !== undefined) {
        const angle = (randomRange(cfg.angleXY, 0) * Math.PI) / 180;
        const speed = randomRange(cfg.speed, 0);
        vx = speed * Math.cos(angle);
        vy = speed * Math.sin(angle);
      } else {
        vx = randomRange(cfg.vx, 0);
        vy = randomRange(cfg.vy, 0);
      }
      const z0 = heighted ? randomRange(cfg.z, 0) : 0;
      const vz = heighted ? randomRange(cfg.vz, 0) : 0;
      const drag = (randomRange(cfg.drag, 0) * GPU_FRAME_MS) / 1000; // 1/s -> per frame
      const life = randomRange(cfg.lifespan, 1000);
      const delay = randomRange(cfg.delay, 0);
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

      let easeBits = 0;
      let scaleMax;
      if (cfg.scale == null && cfg.scaleX != null && cfg.scaleY != null) {
        const ox = resolveParticleOp(cfg.scaleX, 1, opA);
        rec[b + GPU_REC.SCALE_X_FROM] = ox.from;
        rec[b + GPU_REC.SCALE_X_TO] = ox.to;
        easeBits |= ox.ease << PARTICLE_EASE_SHIFT.SCALEX;
        const oy = resolveParticleOp(cfg.scaleY, 1, opB);
        rec[b + GPU_REC.SCALE_Y_FROM] = oy.from;
        rec[b + GPU_REC.SCALE_Y_TO] = oy.to;
        easeBits |= oy.ease << PARTICLE_EASE_SHIFT.SCALEY;
        scaleMax = Math.max(Math.abs(ox.from), Math.abs(ox.to), Math.abs(oy.from), Math.abs(oy.to));
      } else {
        const os = resolveParticleOp(cfg.scale ?? cfg.scaleX ?? cfg.scaleY, 1, opA);
        rec[b + GPU_REC.SCALE_X_FROM] = os.from;
        rec[b + GPU_REC.SCALE_X_TO] = os.to;
        rec[b + GPU_REC.SCALE_Y_FROM] = os.from;
        rec[b + GPU_REC.SCALE_Y_TO] = os.to;
        easeBits |= (os.ease << PARTICLE_EASE_SHIFT.SCALEX) | (os.ease << PARTICLE_EASE_SHIFT.SCALEY);
        scaleMax = Math.max(Math.abs(os.from), Math.abs(os.to));
      }
      const oa = resolveParticleOp(cfg.alpha, 1, opA);
      rec[b + GPU_REC.ALPHA_FROM] = oa.from;
      rec[b + GPU_REC.ALPHA_TO] = oa.to;
      easeBits |= oa.ease << PARTICLE_EASE_SHIFT.ALPHA;
      const oc = resolveParticleColorOp(cfg.tint, 0xffffff, opA);
      bits[b + GPU_REC.TINT_FROM_T] = oc.from & 0xffffff;
      bits[b + GPU_REC.TINT_TO_T] = oc.to & 0xffffff;
      easeBits |= oc.ease << PARTICLE_EASE_SHIFT.TINT;
      const or = resolveParticleOp(cfg.rotation, 0, opA);
      rec[b + GPU_REC.ROT_FROM] = (or.from * Math.PI) / 180;
      rec[b + GPU_REC.ROT_TO] = (or.to * Math.PI) / 180;
      easeBits |= or.ease << PARTICLE_EASE_SHIFT.ROT;
      if (cfg.angularVelocity != null) {
        const ov = resolveParticleOp(cfg.angularVelocity, 0, opA);
        rec[b + GPU_REC.SPIN_FROM] = (ov.from * Math.PI) / 180;
        rec[b + GPU_REC.SPIN_TO] = (ov.to * Math.PI) / 180;
        easeBits |= ov.ease << PARTICLE_EASE_SHIFT.ANGULAR_VELOCITY;
      } else {
        rec[b + GPU_REC.SPIN_FROM] = 0;
        rec[b + GPU_REC.SPIN_TO] = 0;
      }
      bits[b + GPU_REC.EASES_T] = (easeBits | flags) >>> 0;
      let frame0 = tex01;
      if (textures.random) {
        // anim: 'random': one frame per particle, kept for its whole life
        const pick = (rng() * textures.random) | 0;
        frame0 = frameIds[pick < GPU_MAX_FRAMES ? pick : 0];
      }
      bits[b + GPU_REC.TEX01_T] = frame0;
      bits[b + GPU_REC.TEX23_T] = tex23;
      bits[b + GPU_REC.TEX45_T] = tex45;
      bits[b + GPU_REC.TEX67_T] = tex67;
      rec[b + GPU_REC.RESERVED] = 0;

      // Bounds, conservative: the path's extent over its life, padded by the largest sprite.
      const T = life / GPU_FRAME_MS;
      travelExtent(x0, vx, 0, drag, T);
      const pad = halfSize * scaleMax;
      if (EXTENT[0] - pad < minX) minX = EXTENT[0] - pad;
      if (EXTENT[1] + pad > maxX) maxX = EXTENT[1] + pad;
      travelExtent(y0, vy, heighted ? 0 : gravity, drag, T);
      let lo = EXTENT[0];
      const hi = EXTENT[1];
      if (heighted) {
        travelExtent(z0, vz, gravity, drag, T);
        if (EXTENT[0] < 0) lo += EXTENT[0];
      }
      if (lo - pad < minY) minY = lo - pad;
      if (hi + pad > maxY) maxY = hi + pad;
      if (birth < birthMin) birthMin = birth;
      if (birth + life > endMax) endMax = birth + life;
    }

    // Group row, then publish records before groups (a reader never sees a group whose records are unpublished).
    const g = (groupCursor & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
    const gw = ring.groups;
    const gb = ring.groupBits;
    gb[g + GPU_GROUP.FIRST] = cursor;
    gb[g + GPU_GROUP.COUNT] = n;
    gw[g + GPU_GROUP.BIRTH_F] = birthMin;
    gw[g + GPU_GROUP.END_F] = endMax;
    const sortY = cfg.sortY ?? centerOf(cfg.y);
    gw[g + GPU_GROUP.SORT_Y_F] = sortY;
    gw[g + GPU_GROUP.MIN_X_F] = minX;
    gw[g + GPU_GROUP.MIN_Y_F] = minY;
    gw[g + GPU_GROUP.MAX_X_F] = maxX;
    gw[g + GPU_GROUP.MAX_Y_F] = maxY;
    gb[g + GPU_GROUP.EPOCH_GEN] = Atomics.load(header, GPU_RING.EPOCH_GEN) >>> 0;
    gb[g + GPU_GROUP.FLAGS] = heighted ? GPU_GROUP_FLAG.HEIGHTED : 0;
    gb[g + GPU_GROUP.RESERVED] = 0;
    Atomics.store(header, GPU_RING.PUBLISHED, (cursor + n) | 0);
    Atomics.store(header, GPU_RING.GROUPS, (groupCursor + 1) | 0);
    const endAbs = ring.epoch[0] + endMax;
    if (endAbs > ring.liveUntil) ring.liveUntil = endAbs;
    return n;
  }

  /** Writer side: skip groups that ended. */
  static _advanceOldestLive(ring, groupCursor, now) {
    const epoch = ring.epoch[0];
    const cap = ring.groupCapacity;
    if (((groupCursor - ring.oldestLive) >>> 0) > cap) ring.oldestLive = (groupCursor - cap) >>> 0;
    while (ring.oldestLive !== groupCursor) {
      const g = (ring.oldestLive & (cap - 1)) * GPU_GROUP_WORDS;
      if (epoch + ring.groups[g + GPU_GROUP.END_F] > now) break;
      ring.oldestLive = (ring.oldestLive + 1) >>> 0;
    }
  }

  /**
   * Texture ids for `cfg` into _frameIds (animation indices, as CPU particles store them). Returns the frame
   * count, a random pick count (`anim: 'random'`) and the largest frame's half size, px.
   */
  static _resolveFrames(cfg) {
    const ids = this._frameIds;
    ids.fill(0);
    let count = 1;
    let random = 0;
    let half = 0;
    const sizeOf = (id) => {
      const sheet = SpriteSheetRegistry.getSpritesheetId?.('bigAtlas');
      const dims = sheet ? SpriteSheetRegistry.frameSizeOf(sheet, id) : null;
      const h = dims ? Math.max(dims.w, dims.h) * 0.5 : DEFAULT_HALF_SIZE;
      if (h > half) half = h;
    };
    if (Array.isArray(cfg.frame) && cfg.spritesheet && cfg.animation !== undefined) {
      let wrote = 0;
      for (let f = 0; f < cfg.frame.length && wrote < GPU_MAX_FRAMES; f++) {
        const name = SpriteSheetRegistry.getFrameName(cfg.spritesheet, cfg.animation, cfg.frame[f]);
        if (!name) continue;
        ids[wrote] = SpriteSheetRegistry.getTextureId(name);
        sizeOf(ids[wrote]);
        wrote++;
      }
      if (wrote > 1 && cfg.anim === 'random') random = wrote;
      else if (wrote > 1) count = wrote;
      if (wrote === 0) sizeOf(0);
    } else {
      let name = cfg.texture;
      if (cfg.spritesheet && cfg.animation !== undefined) {
        name = SpriteSheetRegistry.getFrameName(cfg.spritesheet, cfg.animation, cfg.frame ?? 0);
      }
      ids[0] = name ? SpriteSheetRegistry.getTextureId(name) : 0;
      sizeOf(ids[0]);
    }
    return { count, random, halfSize: half || DEFAULT_HALF_SIZE };
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

function centerOf(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const lo = Number.isFinite(v.min) ? v.min : 0;
    const hi = Number.isFinite(v.max) ? v.max : lo;
    return (lo + hi) * 0.5;
  }
  return 0;
}
