// E-315: the shadow stamp's ring walk. Written for PR #12's build (ring_gather_select: with maxShadowsPerEntity on, a
// light walks the stamp grid in square rings out from its cell and stops once it holds its lim nearest casters and no
// cell left can hold a nearer one, where the plain walk gathered every caster in range and quickselected lim of them);
// the shipped one is main's (wasm/shadowStamp.c ring_select for budgets up to KNN_MAX_LIM, radix_select past them,
// tests/node/shadowStampSelect.test.js), which these frames check the same way.
//
// "The same kept set": a light keeps every candidate (in range, in its cone) whose float distance² is under F, the
// lim-th smallest float distance² among all its candidates, and as many of those exactly at F as fill lim. Which of
// the casters exactly at F it keeps is the one thing the ring walk may choose differently from the plain walk (its
// quickselect sees the candidates in another order). So: frames without ties must stamp what the JS reference
// (tests/reference/shadowStamp.mjs, the plain walk) stamps, bit for bit; frames built on ties must keep that set.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { MAX, rng, setup } from '../helpers/shadowStampFrames.mjs';

/** Casters at random float positions on a side × side field; float 2 holds the caster's index (its id in a row). */
function fillCasters(r, sun, n, side, spot) {
  for (let c = 0; c < n; c++) {
    const b = c * GPU_CASTER_FLOATS;
    sun[b] = spot ? 1000 + 16 * Math.floor(r() * 8) : r() * side;
    sun[b + 1] = spot ? 1000 + 16 * Math.floor(r() * 8) : r() * side;
    sun[b + 2] = c;
    for (let f = 3; f < GPU_CASTER_FLOATS; f++) sun[b + f] = r();
  }
}

function specOf(dst, scratch, n, lights, maxPerLight, maxPerEntity) {
  return {
    sun: dst.sun,
    sunN: n,
    sunFloats: GPU_CASTER_FLOATS,
    lights,
    lightBegin: 0,
    lightEnd: lights.length,
    lightStride: 1,
    maxPerLight,
    maxPerEntity,
    used: null,
    ...scratch,
    stamp: dst.stamp,
    stampFloats: GPU_CASTER_FLOATS,
    stampCap: dst.stamp.length / GPU_CASTER_FLOATS,
    stampBase: 0,
    stampLightIdx: dst.stampLightIdx,
  };
}

function coneOn(r, L) {
  const a = r() * Math.PI * 2;
  const half = 0.3 + r() * 1.4;
  L.coneDirX = Math.cos(a);
  L.coneDirYW = Math.sin(a);
  L.coneCos = Math.cos(half);
  L.coneInvSpan = 1 / Math.max(Math.cos(half * 0.5) - L.coneCos, 0.002);
  L.invG2 = 1;
  return L;
}

/** The JS reference and the kernel on one call: the cursor, every stamp row and light index, bit for bit. */
function assertSameStamp(dst, b, spec, label) {
  const rows = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
  const idx = new Uint8Array(dst.stampLightIdx.buffer, dst.stampLightIdx.byteOffset, dst.stampLightIdx.byteLength);
  rows.fill(0xa5);
  idx.fill(0xa5);
  const jsCursor = stampLightRange(spec);
  const jsRows = rows.slice();
  const jsIdx = idx.slice();
  rows.fill(0xa5);
  idx.fill(0xa5);
  const cursor = stampLightRangeWasm(b, spec);
  assert.equal(cursor, jsCursor, `${label}: cursor`);
  assert.equal(rows.findIndex((x, i) => x !== jsRows[i]), -1, `${label}: stamp rows`);
  assert.equal(idx.findIndex((x, i) => x !== jsIdx[i]), -1, `${label}: light indices`);
  return cursor;
}

test('the ring walk stamps what the plain walk stamps on dense fields without ties, cone lights too', async () => {
  const { dst, b, scratch } = await setup();
  const r = rng(0x315);
  let rows = 0;
  for (let k = 0; k < 24; k++) {
    const side = [2000, 4000, 7000][k % 3];
    fillCasters(r, dst.sun, MAX, side, false);
    const lights = [];
    for (let i = 0; i < 24; i++) {
      const range = 300 + r() * 1500;
      const L = { x: r() * side, y: r() * side, intensity: 0.5 + r(), rangeSq: range * range, maxShadows: r() < 0.3 ? 1 + Math.floor(r() * 80) : 0 };
      if (i === 0) L.x = -400; // a light off the grid: its cell is clamped into its range's rectangle
      if (k % 2 === 1 && r() < 0.5) coneOn(r, L);
      if (k % 4 === 3 && r() < 0.3) L.shade = r();
      lights.push(L);
    }
    rows += assertSameStamp(dst, b, specOf(dst, scratch, MAX, lights, [64, 8, 200][k % 3], 1 + (k % 3)), `frame ${k}`);
  }
  assert.ok(rows > 20000, `the frames stamp rows (${rows})`);
});

test('the ring walk stops early: a light gathers a fraction of the casters in its range', async () => {
  const { dst, b, scratch } = await setup();
  const r = rng(0x5150);
  const side = 4000;
  fillCasters(r, dst.sun, MAX, side, false);
  const d64 = new Float64Array(b.buffer, b.layout.dist64Byte, b.maxSun);
  const L = { x: 2000.25, y: 1900.5, intensity: 1, rangeSq: 3000 * 3000, maxShadows: 0 };
  let inRange = 0;
  for (let c = 0; c < MAX; c++) {
    const dx = dst.sun[c * GPU_CASTER_FLOATS] - L.x;
    const dy = dst.sun[c * GPU_CASTER_FLOATS + 1] - L.y;
    if (dx * dx + dy * dy <= L.rangeSq) inRange++;
  }
  d64.fill(-1);
  const spec = specOf(dst, scratch, MAX, [L], 64, 1);
  assertSameStamp(dst, b, spec, 'one light');
  d64.fill(-1);
  stampLightRangeWasm(b, spec);
  // The shipped ring walk (main's E-315, ring_select: budgets up to KNN_MAX_LIM) keeps its candidates in its own sorted
  // buffer and gathers nothing: the gather, which writes each candidate's double distance into dist64, did not run.
  assert.ok(inRange > 1000, `the light has many casters in range (${inRange})`);
  assert.equal(d64[0], -1, 'the ring walk decided the light without the gather');
});

test('on frames built on ties the ring walk keeps the lim nearest, ties at the lim-th aside', async () => {
  const { dst, b, scratch } = await setup();
  const r = rng(0x7135);
  const rows = new Float32Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.length);
  let checked = 0;
  for (let k = 0; k < 40; k++) {
    const n = 400 + Math.floor(r() * (MAX - 400));
    fillCasters(r, dst.sun, n, 0, true);
    const L = { x: 1000 + 8 * Math.floor(r() * 16), y: 1000 + 8 * Math.floor(r() * 16), intensity: 1, rangeSq: 400 * 400, maxShadows: 0 };
    if (k % 2) coneOn(r, L);
    const lim = 1 + Math.floor(r() * 120);
    // One light and one shadow a caster: the rows are that light's kept casters, one each.
    const kept = stampLightRangeWasm(b, specOf(dst, scratch, n, [L], lim, 1));
    const fd = [];
    for (let c = 0; c < n; c++) {
      const dx = dst.sun[c * GPU_CASTER_FLOATS] - L.x;
      const dy = dst.sun[c * GPU_CASTER_FLOATS + 1] - L.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > L.rangeSq) continue;
      if (L.coneCos !== undefined) {
        const dot = dx * L.coneDirX + dy * L.coneDirYW;
        const c2 = L.coneCos * L.coneCos * d2;
        const inside = d2 === 0 || (L.coneCos >= 0 ? dot > 0 && dot * dot > c2 : dot >= 0 || dot * dot < c2);
        if (!inside) continue;
      }
      fd.push({ c, f: Math.fround(d2) });
    }
    const want = Math.min(lim, fd.length);
    assert.equal(kept, want, `frame ${k}: kept count`);
    if (fd.length <= lim) continue;
    const F = fd.map((e) => e.f).sort((a, b2) => a - b2)[lim - 1];
    const keptIds = new Set();
    for (let row = 0; row < kept; row++) keptIds.add(rows[row * GPU_CASTER_FLOATS + 2]);
    assert.equal(keptIds.size, kept, `frame ${k}: each caster once`);
    const fOf = new Map(fd.map((e) => [e.c, e.f]));
    for (const e of fd) if (e.f < F) assert.ok(keptIds.has(e.c), `frame ${k}: caster ${e.c} under the lim-th kept`);
    for (const id of keptIds) assert.ok(fOf.get(id) <= F, `frame ${k}: caster ${id} past the lim-th kept`);
    checked++;
  }
  assert.ok(checked > 20, `frames that select (${checked})`);
});
