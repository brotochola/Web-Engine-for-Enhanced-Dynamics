import WEED from '/src/index.js';

const { GameObject, Decal, enums } = WEED;
const { DECAL_STAMPS_BLEND_MODE } = enums;

const STAMPS_PER_TICK = 64;
const WORLD_W = 1920;
const WORLD_H = 1080;

/**
 * Fires a fixed-size, seeded burst of Decal.stamp calls each
 * tick — deterministic workload so DECAL_STAMP_MS / STEP_MS stay comparable
 * across runs. Mixes blend modes, tint, scale and alpha.
 */
export class DecalStampDriver extends GameObject {
  static components = [];

  onSpawned({ seed = 0xdec411 } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._a = seed >>> 0;
    this._sink = 0;
  }

  _rng() {
    let a = this._a;
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this._a = a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  tick() {
    let sink = this._sink;

    for (let i = 0; i < STAMPS_PER_TICK; i++) {
      const x = this._rng() * WORLD_W;
      const y = this._rng() * WORLD_H;
      const scale = 0.4 + this._rng() * 1.6;
      const alpha = 0.4 + this._rng() * 0.6;
      const tint = ((this._rng() * 0xffffff) | 0) >>> 0;
      const blendMode = i % 3 === 0 ? DECAL_STAMPS_BLEND_MODE.multiply : DECAL_STAMPS_BLEND_MODE.normal;

      sink += Decal.stamp({
        texture: 'blood',
        x,
        y,
        scaleX: scale,
        scaleY: scale,
        tint,
        alpha,
        blendMode,
      });
    }

    this._sink = sink;
  }
}
