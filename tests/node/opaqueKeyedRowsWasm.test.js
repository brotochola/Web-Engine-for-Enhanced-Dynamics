// E-479: the opaque pass's rows of a by-row keyed frame, from the kernel (gpuPack.c opaque_keyed_rows): the rows the
// JavaScript it replaced wrote (tests/reference/opaqueKeyedRowsJs.mjs), bit for bit, whatever is opaque, and their cover.
import test from 'node:test';
import assert from 'node:assert/strict';

import { opaqueKeyedRowsWasm } from '../../src/render/gpuPackClient.js';
import { OPAQUE_FRAME_MASK } from '../../src/render/opaquePass.js';
import { runOpaqueRowsJs, setupOpaqueRows } from '../bench/opaqueKeyedRowsMicrobench.mjs';

const bits = (a, n) => Array.from(new Uint32Array(a.buffer, a.byteOffset, n));

/** Both builders on `s`'s first `n` slots: the same count and rows; the covers within the kernel's float32 sums. */
function same(s, n, what) {
  const m = runOpaqueRowsJs(s, n);
  const cover = s.cover[0];
  const rows = bits(s.out, m * 3);
  s.outShared.fill(-7);
  s.cover[0] = -1;
  const got = opaqueKeyedRowsWasm(s.pack, s.q, s.rows, s.slots, n, s.texels, s.area, OPAQUE_FRAME_MASK, s.tables, s.outShared, s.cover);
  assert.equal(got, m, `${what}: rows`);
  assert.deepEqual(bits(s.outShared, m * 3), rows, `${what}: the rows`);
  assert.ok(Math.abs(s.cover[0] - cover) <= 1e-6 * Math.max(1, cover), `${what}: cover ${s.cover[0]} against ${cover}`);
  // Without a cover asked for: the same rows, the cover left alone.
  s.outShared.fill(-7);
  s.cover[0] = -1;
  assert.equal(opaqueKeyedRowsWasm(s.pack, s.q, s.rows, s.slots, n, s.texels, s.area, OPAQUE_FRAME_MASK, s.tables, s.outShared, null), m);
  assert.deepEqual(bits(s.outShared, m * 3), rows, `${what}: the rows without a cover`);
  assert.equal(s.cover[0], -1);
  return m;
}

test('the kernel writes the rows the JavaScript did, at every count of slots', async () => {
  for (const kind of ['bunny', 'mixed', 'none']) {
    const s = await setupOpaqueRows({ n: 2000, kind, seed: 0x91 });
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 63, 64, 65, 1999, 2000]) same(s, n, `${kind} ${n}`);
  }
});

test('an alpha at the packed 255 line, past 1, below 0 and NaN', async () => {
  const s = await setupOpaqueRows({ n: 64, kind: 'bunny', seed: 3 });
  const line = new Float32Array([254.5 / 255]);
  const u = new Uint32Array(line.buffer);
  const around = [];
  for (let d = -6; d <= 6; d++) {
    const v = new Uint32Array([u[0] + d]);
    around.push(new Float32Array(v.buffer)[0]);
  }
  const values = [...around, 0, 1, 1.5, 3, -1, NaN, Infinity, -Infinity, 254 / 255, 0.999];
  for (let i = 0; i < 64; i++) s.q.alpha[i] = values[i % values.length];
  const m = same(s, 64, 'alphas');
  assert.ok(m > 0 && m < 64);
});

test('a texture past the frames, a frame of each kind of texels and an area table shorter than the frames', async () => {
  const s = await setupOpaqueRows({ n: 500, kind: 'mixed', seed: 11, frames: 40 });
  for (let t = 0; t < 40; t++) s.texels[t] = t % 16;
  for (let i = 0; i < 500; i++) {
    s.q.alpha[i] = 1;
    s.q.textureId[i] = i % 7 === 0 ? 65535 : i % 45;
    s.q.scaleX[i] = (i % 5) - 2;
  }
  s.area = s.area.subarray(0, 20);
  assert.ok(same(s, 500, 'frames') > 0);
  s.texels = s.texels.subarray(0, 0);
  assert.equal(same(s, 500, 'no frames'), 0);
});

test('views outside the memory and tables that do not fit are refused, nothing written', async () => {
  const s = await setupOpaqueRows({ n: 32, kind: 'bunny', seed: 5 });
  const call = (o) => opaqueKeyedRowsWasm(s.pack, s.q, o.rows ?? s.rows, o.slots ?? s.slots, 32, o.texels ?? s.texels, s.area,
    OPAQUE_FRAME_MASK, o.tables ?? s.tables, o.out ?? s.outShared, null);
  s.outShared.fill(-7);
  assert.equal(call({ rows: new Float32Array(32) }), -1);
  assert.equal(call({ out: new Float32Array(96) }), -1);
  assert.equal(call({ out: s.outShared.subarray(0, 95) }), -1);
  assert.equal(call({ tables: s.tables.subarray(0, s.area.length) }), -1);
  assert.ok(s.outShared.every((v) => v === -7));
  assert.equal(call({}), 32);
});
