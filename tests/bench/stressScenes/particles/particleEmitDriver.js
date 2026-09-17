import WEED from '/src/index.js';

const { GameObject, ParticleEmitter } = WEED;

const EMIT_PER_TICK = 3600;
const POSITION_SLOTS = 2048;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 64;

/**
 * Fixed-rate emitFlat burst. Scratch is per-worker: logic0 gets onSpawned,
 * other logic workers lazy-init in tick from `this.index` + static emitPerTick.
 */
export class ParticleEmitDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];
  static emitPerTick = EMIT_PER_TICK;

  onSpawned({ seed, emitPerTick } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._initScratch({
      seed: seed != null ? seed : this.index,
      emitPerTick: emitPerTick != null ? emitPerTick : this.constructor.emitPerTick,
    });
  }

  _initScratch({ seed, emitPerTick } = {}) {
    if (this._positions) return;
    this._seed = (seed != null ? seed : this.index) >>> 0;
    this._emitPerTick = (emitPerTick != null ? emitPerTick : this.constructor.emitPerTick) | 0;
    this._cursor = 0;
    this._sink = 0;
    this._positions = new Float32Array(POSITION_SLOTS * 2);
    const rng = this._mulberry32(this._seed);
    for (let i = 0; i < this._positions.length; i += 2) {
      this._positions[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._positions[i + 1] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
    }
  }

  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  tick() {
    this._initScratch();
    const positions = this._positions;
    const cursor = this._cursor;
    const k = (cursor % POSITION_SLOTS) * 2;
    const cx = positions[k];
    const cy = positions[k + 1];

    this._sink += ParticleEmitter.emitFlat({
      count: this._emitPerTick,
      x: { min: cx - 40, max: cx + 40 },
      y: { min: cy - 40, max: cy + 40 },
      vx: { min: -30, max: 30 },
      vy: { min: -30, max: 30 },
      lifespan: { min: 150, max: 400 },
      scale: { min: 0.4, max: 1 },
    });

    this._cursor = cursor + 1;
  }
}

export class ParticleEmitDriver32 extends ParticleEmitDriver {
  static emitPerTick = 32;
}
