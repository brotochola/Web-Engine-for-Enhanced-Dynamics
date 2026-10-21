import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureCompoundSolid } from '../../src/render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { mulberry32 } from '../bench/benchMath.js';

// Review G1. ensureCompoundSolid counted edges in a Map keyed by strings, one
// string and one object per edge per rebuild. It counts them in a reused
// typed-array table now. The outline must come out exactly as before: same
// segments, same order (first seen), same float ends.

const NONE = 0xffff;
const V = MAX_POLYGON_VERTICES;
const QUANT = 1000;

/** The Map version, as it was. */
function referenceOutline(f) {
  const map = new Map();
  let cur = f.headIdx;
  let guard = 0;
  while (cur !== NONE && guard++ < f.poolMax) {
    const count = f.vertCount[cur] | 0;
    if (f.active[cur] && count >= 3 && count <= V) {
      const base = cur * V;
      for (let i = 0; i < count; i++) {
        const j = i + 1 < count ? i + 1 : 0;
        const ax = f.vx[base + i];
        const ay = f.vy[base + i];
        const bx = f.vx[base + j];
        const by = f.vy[base + j];
        const iax = Math.round(ax * QUANT);
        const iay = Math.round(ay * QUANT);
        const ibx = Math.round(bx * QUANT);
        const iby = Math.round(by * QUANT);
        if (iax === ibx && iay === iby) continue;
        const key = ibx < iax || (ibx === iax && iby < iay)
          ? `${ibx},${iby},${iax},${iay}`
          : `${iax},${iay},${ibx},${iby}`;
        const prev = map.get(key);
        if (prev) prev.n++;
        else map.set(key, { n: 1, x0: ax, y0: ay, x1: bx, y1: by });
      }
    }
    cur = f.next[cur];
  }
  const out = [];
  for (const e of map.values()) if (e.n === 1) out.push(e.x0, e.y0, e.x1, e.y1);
  return Float32Array.from(out);
}

/** A random compound: jittered grid triangles, some removed, inactive, duplicated or bent. */
function randomCompound(seed, cols, rows, opts = {}) {
  const r = mulberry32(seed);
  const cell = opts.cell ?? 10;
  const ox = opts.ox ?? 100;
  const oy = opts.oy ?? 200;
  const P = (c, k) => [ox + c * cell + (r() - 0.5) * cell * 0.3, oy + k * cell + (r() - 0.5) * cell * 0.3];
  const pts = [];
  for (let k = 0; k <= rows; k++) for (let c = 0; c <= cols; c++) pts.push(P(c, k));
  const tris = [];
  for (let k = 0; k < rows; k++) {
    for (let c = 0; c < cols; c++) {
      const a = k * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      if (r() > 0.12) tris.push([pts[a], pts[b], pts[e]]);
      if (r() > 0.12) tris.push([pts[a], pts[e], pts[d]]);
    }
  }
  if (opts.duplicates) for (let i = 0; i < tris.length; i += 7) tris.push(tris[i]);
  const n = tris.length + 3;
  const vx = new Float32Array(n * V);
  const vy = new Float32Array(n * V);
  const vertCount = new Uint8Array(n);
  const active = new Uint8Array(n);
  const next = new Uint16Array(n);
  for (let f = 0; f < n; f++) {
    const t = tris[f];
    if (t) {
      for (let i = 0; i < 3; i++) {
        vx[f * V + i] = t[i][0];
        vy[f * V + i] = t[i][1];
      }
      vertCount[f] = 3;
      active[f] = r() > 0.05 ? 1 : 0;
    } else if (f === tris.length) {
      // A degenerate quad: two repeated corners, and two ends 0.0002 apart.
      const q = [[0, 0], [0, 0], [5, 0], [5, 0.0002], [5, 5]];
      for (let i = 0; i < q.length; i++) {
        vx[f * V + i] = ox + q[i][0];
        vy[f * V + i] = oy - 20 + q[i][1];
      }
      vertCount[f] = q.length;
      active[f] = 1;
    } else {
      vertCount[f] = f === tris.length + 1 ? 2 : V + 1; // skipped either way
      active[f] = 1;
    }
    next[f] = f + 1 < n ? f + 1 : NONE;
  }
  return { headIdx: 0, poolMax: n, head: new Uint16Array([0]), next, active, vertCount, vx, vy };
}

let revision = 1;
function outline(f, entity, wantFill) {
  const s = ensureCompoundSolid(
    entity, revision++, f.head, f.next, f.active, f.vertCount, f.vx, f.vy, f.headIdx, f.poolMax, wantFill,
  );
  return { seg: s.seg.slice(0, s.segCount * 4), segCount: s.segCount, fillVerts: s.fillVerts };
}

test('the outline matches the Map version: count, order and ends', () => {
  const shapes = [
    [1, 2, 1, {}],
    [2, 6, 4, {}],
    [3, 16, 8, { duplicates: true }],
    [4, 12, 12, { ox: -5000, oy: -7000, cell: 3.3 }],
    [5, 30, 20, { ox: 90000, oy: 120000 }],
    [6, 48, 24, { duplicates: true }], // grows the table past its first size
  ];
  for (const [seed, cols, rows, opts] of shapes) {
    const f = randomCompound(seed, cols, rows, opts);
    const want = referenceOutline(f);
    for (const wantFill of [false, true]) {
      const got = outline(f, seed, wantFill);
      assert.equal(got.segCount * 4, want.length, `seed ${seed} fill ${wantFill}: segment count`);
      assert.deepEqual(Array.from(got.seg), Array.from(want), `seed ${seed} fill ${wantFill}: segments`);
    }
  }
});

test('a small body after a large one starts from an empty table', () => {
  const big = randomCompound(11, 40, 30, {});
  outline(big, 100, false);
  const small = randomCompound(12, 2, 1, {});
  const got = outline(small, 101, false);
  assert.deepEqual(Array.from(got.seg), Array.from(referenceOutline(small)));
});

test('bodies far apart in the entity pool each keep their own cached outline', () => {
  // V5: the cache fills the gap below a new high index with nulls so it stays a
  // packed array; a null slot must still read as "no outline yet".
  const f = randomCompound(21, 6, 4, {});
  const call = (entity, rev) => ensureCompoundSolid(
    entity, rev, f.head, f.next, f.active, f.vertCount, f.vx, f.vy, f.headIdx, f.poolMax, true,
  );
  const far = call(9000, 50);
  const mid = call(4500, 50);
  const near = call(3, 50);
  assert.notEqual(far, mid);
  assert.notEqual(mid, near);
  assert.equal(call(9000, 50), far, 'same revision: the cached object');
  assert.equal(call(4500, 50), mid);
  assert.equal(call(3, 50), near);
  const fresh = call(8999, 50);
  assert.notEqual(fresh, far, 'a gap slot builds its own');
  assert.equal(fresh.segCount, far.segCount);
  assert.deepEqual(Array.from(fresh.seg.slice(0, fresh.segCount * 4)), Array.from(referenceOutline(f)));
});
