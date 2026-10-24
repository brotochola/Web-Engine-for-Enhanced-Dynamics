// The float32 mesh corner rewrites (tests/fixtures/wasm/meshCornersF32.wasm, from wasm/test/meshCornersF32.c)
// against the shipped kernel (meshCorners.wasm, through meshCornersClient.js), on meshCornersWasm.test.js's
// 800 random frames (fans and index lists, UV rows or not, the UV generations, torn spans, odd strides, NaN
// payloads, zeros, infinities, subnormals). The rewrite computes nothing, so the stated tolerance (corner
// positions within 1e-3 px) is met with room: each frame's return code and every word of the row region
// (corners, and the words the rewrite must leave alone) are the shipped kernel's bit for bit, for
// rewrite_corners_f32 and rewrite_corners_f32x4. The bench scene's eight variants hash alike in
// meshCornersWasm.test.js. Mutants caught: the f32x4 kernel reading y for x, and every vertex 2e-3 px off.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MESH_CORNER_SLOTS, rewriteCornersWasm } from '../../src/render/meshCornersClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { FRAMES, frameCall, rng, setup } from '../helpers/meshCornerFrames.mjs';

const KERNEL_URL = new URL('../fixtures/wasm/meshCornersF32.wasm', import.meta.url);
const TOLERANCE_PX = 1e-3;

/**
 * The largest difference between two row regions, word by word as floats: 0 where the bits match, |a - b|
 * where both are numbers, Infinity where one is NaN and the other not (or both NaN with other bits).
 */
function worstDifference(refWords, outWords) {
  const a = new Float32Array(refWords.buffer, refWords.byteOffset, refWords.length);
  const b = new Float32Array(outWords.buffer, outWords.byteOffset, outWords.length);
  let worst = 0;
  let at = -1;
  for (let q = 0; q < refWords.length; q++) {
    if (refWords[q] === outWords[q]) continue;
    const d = Number.isNaN(a[q]) || Number.isNaN(b[q]) ? Infinity : Math.abs(a[q] - b[q]);
    if (d > worst || at < 0) {
      worst = d;
      at = q;
    }
  }
  return { worst, at };
}

test('the float32 corner rewrites write what the shipped kernel writes, bit for bit', async (t) => {
  const s = await setup();
  const k = await loadWasmKernel('meshCornersF32', KERNEL_URL, s.memory, ['rewrite_corners_f32', 'rewrite_corners_f32x4']);
  const variants = {
    f32: { ...s.b, rewrite: k.rewrite_corners_f32, calls: 0, declined: 0 },
    f32x4: { ...s.b, rewrite: k.rewrite_corners_f32x4, calls: 0, declined: 0 },
  };
  const r = rng(0x3e5c);
  const pattern = new Uint32Array(s.outWords.length);
  const codes = { 0: 0, 1: 0, '-1': 0 };
  const worst = { f32: 0, f32x4: 0 };
  for (let f = 0; f < FRAMES; f++) {
    const { mode, n, views, stride, last, genNow, lastUvGen, uvGenNow } = frameCall(r, s, f, pattern);
    s.outWords.set(pattern);
    const code = rewriteCornersWasm(s.b, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
    const ref = s.outWords.slice();
    codes[code]++;
    for (const [name, bound] of Object.entries(variants)) {
      s.outWords.set(pattern);
      const declined = bound.declined;
      const got = rewriteCornersWasm(bound, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
      assert.equal(bound.declined, declined, `frame ${f} ${name}: the kernel took the call`);
      assert.equal(got, code, `frame ${f} (mode ${mode}, stride ${stride}) ${name}: return code`);
      const d = worstDifference(ref, s.outWords);
      assert.ok(d.worst <= TOLERANCE_PX, `frame ${f} ${name}: word ${d.at} off by ${d.worst}`);
      worst[name] = Math.max(worst[name], d.worst);
      const at = s.outWords.findIndex((w, q) => w !== ref[q]);
      assert.equal(at, -1, `frame ${f} (mode ${mode}, stride ${stride}) ${name}: word ${at}: 0x${(s.outWords[at] >>> 0).toString(16)}, shipped 0x${(ref[at] >>> 0).toString(16)}`);
    }
  }
  for (const [c, hits] of Object.entries(codes)) assert.ok(hits > 0, `no frame returned ${c}`);
  for (const [name, bound] of Object.entries(variants)) assert.ok(bound.calls > 0, `${name} ran`);
  t.diagnostic(`${FRAMES} frames, codes ${JSON.stringify(codes)}; worst corner difference f32 ${worst.f32} px, f32x4 ${worst.f32x4} px`);
});

test('a kernel that reads the wrong column, or a corner 2e-3 px off, is caught', async () => {
  const s = await setup();
  const k = await loadWasmKernel('meshCornersF32', KERNEL_URL, s.memory, ['rewrite_corners_f32x4']);
  const bound = { ...s.b, rewrite: k.rewrite_corners_f32x4, calls: 0, declined: 0 };
  const r = rng(0x3e5c);
  const pattern = new Uint32Array(s.outWords.length);
  // Frame 0 rewrites rows (mode 0: fans and index lists, finite corners mostly).
  const { n, views, stride, last, genNow, lastUvGen, uvGenNow } = frameCall(r, s, 0, pattern);
  s.outWords.set(pattern);
  assert.equal(rewriteCornersWasm(s.b, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow), 1);
  const ref = s.outWords.slice();
  assert.ok(ref.some((w, q) => w !== pattern[q]), 'the frame writes corners');
  // The x and y columns swapped in the table: the kernel copies y for x.
  const VX = MESH_CORNER_SLOTS.indexOf('vertexX');
  const VY = MESH_CORNER_SLOTS.indexOf('vertexY');
  const t = s.b.table;
  [t[VX], t[VY]] = [t[VY], t[VX]];
  s.outWords.set(pattern);
  rewriteCornersWasm(bound, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
  [t[VX], t[VY]] = [t[VY], t[VX]];
  assert.ok(worstDifference(ref, s.outWords).worst > TOLERANCE_PX, 'x and y swapped');
  // Every vertex 2e-3 px to the right of where the shipped kernel read it (a finite corner moves).
  const vx = s.geom.vertexX;
  const saved = vx.slice();
  for (let q = 0; q < vx.length; q++) if (Number.isFinite(vx[q]) && Math.abs(vx[q]) < 256) vx[q] += 2e-3;
  s.outWords.set(pattern);
  rewriteCornersWasm(bound, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
  vx.set(saved);
  const d = worstDifference(ref, s.outWords);
  assert.ok(d.worst > TOLERANCE_PX && d.worst < 4e-3, `a corner 2e-3 px off is caught (${d.worst} px)`);
});

test('the comparison catches a corner off by more than the tolerance, and any other word', () => {
  const ref = new Uint32Array(48);
  const rows = new Float32Array(ref.buffer);
  for (let q = 0; q < rows.length; q++) rows[q] = 100 + q * 0.25;
  rows[7] = NaN;
  const off = new Float32Array(rows);
  off[2] += 2e-3;
  const d = worstDifference(ref, new Uint32Array(off.buffer));
  assert.ok(d.worst > TOLERANCE_PX && d.at === 2, `a corner 2e-3 px off: ${d.worst} at ${d.at}`);
  const nan = new Float32Array(rows);
  nan[3] = NaN;
  assert.equal(worstDifference(ref, new Uint32Array(nan.buffer)).worst, Infinity, 'a NaN for a number');
  const pose = new Uint32Array(ref);
  pose[9] ^= 1;
  assert.notEqual(pose.findIndex((w, q) => w !== ref[q]), -1, 'a pose word one bit off');
  assert.ok(worstDifference(ref, pose).worst > 0, 'and its difference is not 0');
});
