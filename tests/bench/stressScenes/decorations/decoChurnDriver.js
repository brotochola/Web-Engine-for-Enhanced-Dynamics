import WEED from '/src/index.js';

const { GameObject, Decoration } = WEED;

const POSITION_SLOTS = 256;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 80;

/**
 * Fixed-rate deco spawn/despawn so the compact-list CAS contends with copyActiveSnapshot.
 * Scratch is per-worker (onSpawned is logic0-only). Fill to liveCap, then churn.
 */
export class DecoChurnDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];
  static spawnPerTick = 8;
  static despawnPerTick = 8;
  static liveCap = 500;

  onSpawned({ seed, spawnPerTick, despawnPerTick, liveCap } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._initScratch({ seed, spawnPerTick, despawnPerTick, liveCap });
  }

  _initScratch({ seed, spawnPerTick, despawnPerTick, liveCap } = {}) {
    if (this._positions) return;
    this._seed = (seed != null ? seed : this.index) >>> 0;
    this._spawnPerTick = (spawnPerTick != null ? spawnPerTick : this.constructor.spawnPerTick) | 0;
    this._despawnPerTick = (despawnPerTick != null ? despawnPerTick : this.constructor.despawnPerTick) | 0;
    this._liveCap = (liveCap != null ? liveCap : this.constructor.liveCap) | 0;
    this._cursor = 0;
    this._live = [];
    this._positions = new Float32Array(POSITION_SLOTS * 2);
    const rng = this._mulberry32(this._seed);
    for (let i = 0; i < POSITION_SLOTS; i++) {
      this._positions[i * 2] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._positions[i * 2 + 1] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
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
    const live = this._live;
    if (live.length >= this._liveCap) {
      for (let n = 0; n < this._despawnPerTick; n++) {
        if (!live.length) break;
        Decoration.despawn(live.pop());
      }
    }
    const positions = this._positions;
    let cursor = this._cursor;
    for (let n = 0; n < this._spawnPerTick; n++) {
      if (live.length >= this._liveCap) break;
      const slot = cursor % POSITION_SLOTS;
      const i = Decoration.spawn({
        x: positions[slot * 2],
        y: positions[slot * 2 + 1],
        texture: 'ball',
        scaleX: 0.2,
        scaleY: 0.2,
        alpha: 0.9,
        anchorX: 0.5,
        anchorY: 1,
        sway: true,
        swayAmplitude: 0.05,
        swayFrequency: 1.4,
      });
      if (i < 0) break;
      live.push(i);
      cursor++;
    }
    this._cursor = cursor;
  }
}
