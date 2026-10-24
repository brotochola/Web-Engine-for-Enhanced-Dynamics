import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { bindBullets, bulletWorld } from '../bench/bulletTickKernel.mjs';
import { BulletPool } from '../../src/core/bulletPool.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';

// E-76 W19: BulletPool.tick with the kernel bound (the particle worker's path) leaves the pool exactly as the JS
// tick does: the bullets, the active list, the impacts and their header, and the slots returned to the pool in
// order. Some polygons are compound, so bullets go back to the JS mid-walk and the kernel resumes after them.

const SIZE = { bullets: 3000, entities: 1200, cols: 20, rows: 14, cellSize: 128, perCell: 96, impacts: 128 };

function fill(w, seed) {
  const rng = mulberry32(seed);
  const v = w.views;
  const W = SIZE.cols * SIZE.cellSize;
  const H = SIZE.rows * SIZE.cellSize;
  for (let e = 0; e < SIZE.entities; e++) {
    const x = rng() * W;
    const y = rng() * H;
    const a = rng() * 6.3;
    v.tActive[e] = 1;
    v.tX[e] = x;
    v.tY[e] = y;
    v.tRotC[e] = Math.cos(a);
    v.tRotS[e] = Math.sin(a);
    v.cActive[e] = 1;
    const kind = rng();
    let half;
    if (kind < 0.45) {
      v.cShape[e] = 1;
      v.cRadius[e] = 4 + rng() * 26;
      half = v.cRadius[e];
    } else if (kind < 0.8) {
      v.cShape[e] = 0;
      v.cWidth[e] = 6 + rng() * 50;
      v.cHeight[e] = 6 + rng() * 50;
      half = Math.max(v.cWidth[e], v.cHeight[e]) * 0.5;
    } else {
      v.cShape[e] = 2;
      const n = 3 + ((rng() * 5) | 0);
      const r = 6 + rng() * 24;
      v.cPolyCount[e] = n;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 1) / n) * Math.PI * 2;
        const x0 = Math.cos(a0) * r;
        const y0 = Math.sin(a0) * r;
        const ex = Math.cos(a1) * r - x0;
        const ey = Math.sin(a1) * r - y0;
        const l = Math.sqrt(ex * ex + ey * ey);
        v.cPvx[e * 8 + k] = x0;
        v.cPvy[e * 8 + k] = y0;
        v.cPnx[e * 8 + k] = ey / l;
        v.cPny[e * 8 + k] = -ex / l;
      }
      // A compound polygon: the kernel hands its bullets back (with no fixture pool the JS takes the outline).
      if (rng() < 0.3) v.cFixtureCount[e] = 2;
      half = r;
    }
    w.insert(e, x, y, half + 4);
  }
  for (let i = 0; i < SIZE.bullets; i++) {
    const a = rng() * 6.3;
    const speed = 300 + rng() * 2000;
    v.bActive[i] = rng() < 0.9 ? 1 : 0;
    v.bX[i] = rng() * W;
    v.bY[i] = rng() * H;
    v.bRotC[i] = Math.cos(a);
    v.bRotS[i] = Math.sin(a);
    v.bSpeed[i] = speed;
    v.bVx[i] = v.bRotC[i] * speed;
    v.bVy[i] = v.bRotS[i] * speed;
    v.bDamage[i] = 1 + rng() * 9;
    v.bOwner[i] = (rng() * SIZE.entities) | 0;
    v.bShooter[i] = (rng() * 4) | 0;
  }
}

function snapshot(w, active, header, impacts, returned) {
  const v = w.views;
  const f32 = (a) => Array.from(new Uint32Array(a.slice().buffer));
  return {
    bullets: [v.bActive, v.bX, v.bY, v.bPrevX, v.bPrevY].map((a) => (a instanceof Float32Array ? f32(a) : Array.from(a))),
    active: Array.from(active.subarray(0, active[0] + 1)),
    header: Array.from(header),
    impacts: f32(impacts.subarray(0, header[0] * 6)),
    returned,
  };
}

test('BulletPool.tick with the kernel bound leaves the pool as the JS tick does, hand-backs included', async () => {
  assert.equal(ColliderFixture.active ?? null, null, 'no fixture pool: a compound polygon is cast on its outline');
  const realReturn = BulletPool.returnToPool;
  try {
    for (const [seed, dtRatio] of [[5, 1], [6, 1.7]]) {
      const run = async (withKernel) => {
        const w = bulletWorld(SIZE);
        fill(w, seed);
        BulletPool._wasm = withKernel ? await bindBullets(w) : null;
        const returned = [];
        BulletPool.returnToPool = (i) => returned.push(i);
        const active = new Uint16Array(SIZE.bullets + 1);
        const header = new Int32Array(2);
        const impacts = new Float32Array(SIZE.impacts * 6);
        let calls = 0;
        if (withKernel) {
          const tick = BulletPool._wasm.tick;
          BulletPool._wasm.tick = (...a) => { calls++; return tick(...a); };
        }
        BulletPool.tick(dtRatio, active, header, impacts, SIZE.impacts);
        return { state: snapshot(w, active, header, impacts, returned), calls };
      };
      const js = await run(false);
      const wasm = await run(true);
      assert.ok(wasm.calls > 3, `the kernel ran and resumed after hand-backs (${wasm.calls} calls)`);
      assert.ok(js.state.returned.length > 30, 'bullets hit');
      assert.deepEqual(wasm.state, js.state);
    }
  } finally {
    BulletPool._wasm = null;
    BulletPool.returnToPool = realReturn;
  }
});

test('BulletPool.tick keeps the JS for a 32-bit pool, kernel options, or an impact cap past its region', async () => {
  const w = bulletWorld(SIZE);
  fill(w, 9);
  const k = await bindBullets(w);
  let calls = 0;
  const tick = k.tick;
  k.tick = (...a) => { calls++; return tick(...a); };
  BulletPool._wasm = k;
  const realReturn = BulletPool.returnToPool;
  BulletPool.returnToPool = () => {};
  try {
    BulletPool.tick(1, new Uint32Array(SIZE.bullets + 1), new Int32Array(2), new Float32Array(SIZE.impacts * 6), SIZE.impacts);
    BulletPool.tick(1, new Uint16Array(SIZE.bullets + 1), null, null, 0, { speed: null });
    BulletPool.tick(1, new Uint16Array(SIZE.bullets + 1), new Int32Array(2), new Float32Array(9999 * 6), 9999);
    assert.equal(calls, 0);
  } finally {
    BulletPool._wasm = null;
    BulletPool.returnToPool = realReturn;
  }
});
