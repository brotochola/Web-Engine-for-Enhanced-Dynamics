import WEED from '/src/index.js';

const { GameObject, BulletPool } = WEED;

const SPAWN_PER_TICK = 320;
const POSITION_SLOTS = 256;
const SPEED = 1500;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 200;

/**
 * Fires a fixed-rate bullet burst from cycling origins toward random unit dirs.
 * Walls in BulletStressScene keep them in-world; pool stays full after warmup.
 */
export class BulletStressDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ seed = 0xb011e7 } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._seed = seed >>> 0;
    this._cursor = 0;
    this._sink = 0;
    this._positions = new Float32Array(POSITION_SLOTS * 2);
    this._dirs = new Float32Array(POSITION_SLOTS * 2);
    const rng = this._mulberry32(this._seed);
    for (let i = 0; i < POSITION_SLOTS; i++) {
      this._positions[i * 2] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._positions[i * 2 + 1] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
      const ang = rng() * Math.PI * 2;
      this._dirs[i * 2] = Math.cos(ang);
      this._dirs[i * 2 + 1] = Math.sin(ang);
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
    const positions = this._positions;
    const dirs = this._dirs;
    const ownerId = this.index;
    let cursor = this._cursor;
    let spawned = 0;
    for (let n = 0; n < SPAWN_PER_TICK; n++) {
      const slot = cursor % POSITION_SLOTS;
      const i = BulletPool.spawn({
        x: positions[slot * 2],
        y: positions[slot * 2 + 1],
        vx: dirs[slot * 2] * SPEED,
        vy: dirs[slot * 2 + 1] * SPEED,
        damage: 1,
        ownerId,
        shooterEntityType: 0,
      });
      if (i < 0) break;
      spawned++;
      cursor++;
    }
    this._cursor = cursor;
    this._sink += spawned;
  }
}
