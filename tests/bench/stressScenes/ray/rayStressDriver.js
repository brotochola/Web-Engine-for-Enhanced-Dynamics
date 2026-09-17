import WEED from '/src/index.js';

const { GameObject, Ray, Transform, Collider, RigidBody, Box2d } = WEED;

const CASTS_PER_TICK = 512;
const PAIR_COUNT = 1024;
const LONG_RAY_COUNT = 512;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 64;

/**
 * Fires a fixed mix of casts each tick against static obstacles.
 * backend: 'weedjs' (default) uses Ray.*; 'box2d' uses sync Box2d.castRayClosest SAB.
 * Workload is seeded/cyclic so RAYCAST_MS stays comparable across runs.
 */
export class RayStressDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ seed = 0xc0de1234, backend = 'weedjs' } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._seed = seed >>> 0;
    this._backend = backend === 'box2d' ? 'box2d' : 'weedjs';
    this._cursor = 0;
    this._sink = 0;
    this._ready = false;
    this._indices = null;
    this._pairs = new Uint32Array(PAIR_COUNT * 2);
    this._longRays = new Float32Array(LONG_RAY_COUNT * 4);
    this._rayOut = {
      hit: false,
      entityIndex: -1,
      fraction: 0,
      hitX: 0,
      hitY: 0,
    };
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

  _ensureWorkload() {
    if (this._ready) return true;
    const active = [];
    const len = Transform.active.length;
    const hasStatic = RigidBody.static != null;
    for (let i = 0; i < len; i++) {
      if (!(Transform.active[i] && Collider.active[i])) continue;
      // Prefer static RigidBody obstacles; fall back to any collider if schema missing.
      if (hasStatic && !RigidBody.static[i]) continue;
      active.push(i);
    }
    if (active.length < 2) return false;

    this._indices = new Uint32Array(active);
    const n = this._indices.length;
    const rng = this._mulberry32(this._seed);
    for (let i = 0; i < this._pairs.length; i++) {
      this._pairs[i] = this._indices[(rng() * n) | 0];
    }
    for (let i = 0; i < this._longRays.length; i += 4) {
      this._longRays[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._longRays[i + 1] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
      this._longRays[i + 2] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._longRays[i + 3] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
    }
    this._ready = true;
    return true;
  }

  _box2dClosest(ox, oy, ex, ey) {
    const out = this._rayOut;
    Box2d.castRayClosest(ox, oy, ex - ox, ey - oy, out);
    return out.hit ? out.entityIndex : -1;
  }

  _tickWeedjs(pairs, rays, cursor, half) {
    let sink = this._sink;
    for (let i = 0; i < half; i++) {
      const k = ((cursor + i) % PAIR_COUNT) * 2;
      const a = pairs[k];
      const b = pairs[k + 1];
      if (Ray.hasLineOfSight(a, b)) sink++;
      const los = Ray.linecastBetweenEntities(a, b);
      if (los.blocked) sink++;
    }
    for (let i = 0; i < half; i++) {
      const k = ((cursor + i) % LONG_RAY_COUNT) * 4;
      sink += Ray.cast(rays[k], rays[k + 1], rays[k + 2], rays[k + 3]);
      const hits = Ray.castAll(
        rays[k],
        rays[k + 1],
        rays[k + 2],
        rays[k + 3],
        Infinity,
        4,
      );
      sink += hits.length;
    }
    this._sink = sink;
  }

  _tickBox2d(pairs, rays, cursor, half) {
    let sink = this._sink;
    for (let i = 0; i < half; i++) {
      const k = ((cursor + i) % PAIR_COUNT) * 2;
      const a = pairs[k];
      const b = pairs[k + 1];
      const ax = Transform.x[a];
      const ay = Transform.y[a];
      const bx = Transform.x[b];
      const by = Transform.y[b];
      // Two closest casts ≈ LOS + linecastBetweenEntities cost shape.
      const h1 = this._box2dClosest(ax, ay, bx, by);
      if (h1 === -1) sink++;
      const h2 = this._box2dClosest(ax, ay, bx, by);
      if (h2 !== -1) sink++;
    }
    for (let i = 0; i < half; i++) {
      const k = ((cursor + i) % LONG_RAY_COUNT) * 4;
      const hit = this._box2dClosest(rays[k], rays[k + 1], rays[k + 2], rays[k + 3]);
      sink += hit;
      // Second cast stands in for castAll(maxHits=4) volume (closest-only API).
      const hit2 = this._box2dClosest(rays[k], rays[k + 1], rays[k + 2], rays[k + 3]);
      if (hit2 !== -1) sink++;
    }
    this._sink = sink;
  }

  tick() {
    if (!this._ensureWorkload()) return;

    const pairs = this._pairs;
    const rays = this._longRays;
    const cursor = this._cursor;
    const half = CASTS_PER_TICK >> 2;

    if (this._backend === 'box2d') {
      this._tickBox2d(pairs, rays, cursor, half);
    } else {
      this._tickWeedjs(pairs, rays, cursor, half);
    }

    this._cursor = (cursor + half) % PAIR_COUNT;
  }
}
