import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { bindBullets, bulletWorld } from '../bench/bulletTickKernel.mjs';
import { BulletPool } from '../../src/core/bulletPool.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { Grid } from '../../src/core/grid.js';
import { readyBulletStamps, writeBulletColumns } from '../../src/core/bulletTickClient.js';

// E-76 W19, the bullet tick kernel (wasm/bulletTick.c). On the same bytes, one bullet_tick over the pool must
// leave the bullets, the active list, the impact records and the order of the returned slots exactly as the
// shipped BulletPool.tick (with Ray.linecastDir) leaves them; a bullet whose cast meets a compound polygon or a
// chain is handed back at its position.

const SIZE = { bullets: 4000, entities: 1500, cols: 24, rows: 16, cellSize: 128, perCell: 96, impacts: 256 };
const SHAPES = { box: 0, circle: 1, polygon: 2, chain: 3 };

function fill(w, seed, { odd = false } = {}) {
  const rng = mulberry32(seed);
  const v = w.views;
  const W = SIZE.cols * SIZE.cellSize;
  const H = SIZE.rows * SIZE.cellSize;
  for (let e = 0; e < SIZE.entities; e++) {
    const x = rng() * W;
    const y = rng() * H;
    const a = rng() * 6.3;
    v.tActive[e] = rng() < 0.95 ? 1 : 0;
    v.tX[e] = x;
    v.tY[e] = y;
    v.tRotC[e] = Math.cos(a);
    v.tRotS[e] = Math.sin(a);
    v.cActive[e] = rng() < 0.97 ? 1 : 0;
    v.cLayer[e] = (rng() * 8) | 0;
    v.cOffX[e] = rng() < 0.2 ? [0, -0, NaN][(rng() * 3) | 0] : (rng() - 0.5) * 6;
    v.cOffY[e] = rng() < 0.2 ? [0, -0, NaN][(rng() * 3) | 0] : (rng() - 0.5) * 6;
    const kind = rng();
    let half;
    if (kind < 0.4) {
      v.cShape[e] = SHAPES.circle;
      v.cRadius[e] = 4 + rng() * 30;
      half = v.cRadius[e] + 6;
    } else if (kind < 0.75) {
      v.cShape[e] = SHAPES.box;
      v.cWidth[e] = 6 + rng() * 60;
      v.cHeight[e] = 6 + rng() * 60;
      half = Math.max(v.cWidth[e], v.cHeight[e]) * 0.5 + 6;
    } else {
      v.cShape[e] = SHAPES.polygon;
      const n = 3 + ((rng() * 6) | 0);
      const r = 6 + rng() * 30;
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
      half = r + 6;
    }
    w.insert(e, x, y, half);
  }
  if (odd) {
    // A chain and a compound polygon: the kernel hands their bullets back.
    v.cShape[7] = SHAPES.chain;
    v.cShape[11] = SHAPES.polygon;
    v.cFixtureCount[11] = 2;
    v.tActive[7] = v.tActive[11] = v.cActive[7] = v.cActive[11] = 1;
  }
  for (let i = 0; i < SIZE.bullets; i++) {
    const a = rng() * 6.3;
    const speed = 200 + rng() * 2400;
    v.bActive[i] = rng() < 0.85 ? 1 : 0;
    v.bX[i] = rng() * W;
    v.bY[i] = rng() * H;
    // Some fly along an axis (the box test's 0 * Infinity), the rest anywhere.
    const axis = rng() < 0.05;
    v.bRotC[i] = axis ? 1 : Math.cos(a);
    v.bRotS[i] = axis ? 0 : Math.sin(a);
    v.bSpeed[i] = rng() < 0.01 ? 0 : speed;
    v.bVx[i] = v.bRotC[i] * speed;
    v.bVy[i] = v.bRotS[i] * speed;
    v.bDamage[i] = 1 + rng() * 20;
    v.bOwner[i] = (rng() * SIZE.entities) | 0;
    v.bShooter[i] = (rng() * 6) | 0;
  }
}

/** The bullets' bytes, so a run can start from the same state. */
function save(w) {
  const v = w.views;
  return ['bActive', 'bX', 'bY', 'bPrevX', 'bPrevY'].map((k) => [k, v[k].slice()]);
}
function restore(w, saved) {
  for (const [k, a] of saved) w.views[k].set(a);
}

function state(w, active, impacts, nImpacts, returned) {
  const v = w.views;
  const f32 = (a) => Array.from(new Uint32Array(a.slice().buffer));
  return {
    active: Array.from(v.bActive),
    x: f32(v.bX), y: f32(v.bY), prevX: f32(v.bPrevX), prevY: f32(v.bPrevY),
    list: Array.from(active.subarray(0, active[0] + 1)),
    impacts: f32(impacts.subarray(0, nImpacts * 6)),
    returned,
  };
}

async function compare(seed, { dtRatio = 1, odd = false } = {}) {
  const w = bulletWorld(SIZE);
  fill(w, seed, { odd });
  const start = save(w);
  const realReturn = BulletPool.returnToPool;
  try {
    // JS: the shipped tick.
    const jsReturned = [];
    BulletPool.returnToPool = (i) => jsReturned.push(i);
    const activeJs = new Uint16Array(SIZE.bullets + 1);
    const header = new Int32Array(2);
    const impactsJs = new Float32Array(SIZE.impacts * 6);
    BulletPool.tick(dtRatio, activeJs, header, impactsJs, SIZE.impacts);
    const js = state(w, activeJs, impactsJs, header[0], jsReturned);

    // The kernel, from the same bytes.
    restore(w, start);
    const b = await bindBullets(w);
    assert.equal(writeBulletColumns(b, BulletComponent, Transform, Collider, w.views.activeOut, w.views.impacts, Grid), true);
    const res = b.results;
    res[0] = 1;
    res[1] = 0;
    res[2] = SIZE.impacts;
    res[3] = 0;
    readyBulletStamps(b, SIZE.bullets);
    const stop = b.tick(b.tableByte, 0, SIZE.bullets, dtRatio * (1 / 60), Grid.invCellSize, Grid.cellSize,
      Grid.gridWidth, Grid.gridHeight, Grid.cellByteSize, -1);
    w.views.activeOut[0] = res[0] - 1;
    const wasm = state(w, w.views.activeOut, w.views.impacts, res[1], Array.from(b.returned.subarray(0, res[3])));
    return { js, wasm, stop, header };
  } finally {
    BulletPool.returnToPool = realReturn;
  }
}

test('bullet_tick leaves the bullets, the active list, the impacts and the returned slots as BulletPool.tick does', async () => {
  for (const [seed, dtRatio] of [[11, 1], [12, 0.37], [13, 2.5]]) {
    const { js, wasm, stop, header } = await compare(seed, { dtRatio });
    assert.equal(stop, SIZE.bullets, 'no bullet went back to the JS');
    assert.ok(js.returned.length > 50, `the case hits (${js.returned.length})`);
    assert.ok(header[0] > 10, 'impacts were written');
    assert.deepEqual(wasm, js);
  }
});

test('bullet_tick hands a bullet back at its position when its cast meets a chain or a compound polygon', async () => {
  const w = bulletWorld(SIZE);
  fill(w, 21, { odd: true });
  const v = w.views;
  // Aim bullet 0 at entity 7 (the chain) from just outside it, inside the same cell.
  v.bActive.fill(0);
  v.bActive[0] = 1;
  v.bX[0] = v.tX[7] - 2;
  v.bY[0] = v.tY[7];
  v.bRotC[0] = 1;
  v.bRotS[0] = 0;
  v.bSpeed[0] = 60;
  v.bOwner[0] = 0;
  const b = await bindBullets(w);
  assert.equal(writeBulletColumns(b, BulletComponent, Transform, Collider, v.activeOut, v.impacts, Grid), true);
  b.results.set([1, 0, SIZE.impacts, 0]);
  readyBulletStamps(b, SIZE.bullets);
  const x0 = v.bX[0];
  const stop = b.tick(b.tableByte, 0, SIZE.bullets, 1 / 60, Grid.invCellSize, Grid.cellSize, Grid.gridWidth,
    Grid.gridHeight, Grid.cellByteSize, -1);
  assert.equal(stop, 0, 'the tick stopped at bullet 0');
  assert.equal(v.bX[0], x0, 'nothing was written for it');
  assert.deepEqual(Array.from(b.results), [1, 0, SIZE.impacts, 0]);
});
