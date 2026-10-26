// E-129: the decoration sways for a pool past 65 535 decorations (wasm/decorationSway.c's _u32 exports: the
// frame's snapshot and the chunk list u32, the trig list's impulse at bit 31). On the sway parity frames
// (tests/helpers/decorationSwayScenarios.mjs: Predator's grass, then random decorations through every branch,
// grids from 2 to 70 000 buckets, chunks of 1, 37 and 1024, the 32-bit parents), with the snapshot and list laid
// out as u32 (setupSwayKernel's slotBytes 4), through the bench's wrapper (swayDecorationsWasm), each frame from
// the same bytes:
// - sway_decorations_u32 writes what the particle worker's JS sway writes, bit for bit (any NaN for a NaN);
// - sway_decorations_f32x4_u32 stays within compareSwayStates' tolerance (the float32 test's) of it;
// - each u32 export lists the trig entries of its 16-bit export, the impulse bit moved from 16 to 31.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareSwayStates, setupSwayKernel, SWAY_SLOTS, swayDecorationsWasm, TRIG_IMPULSE } from '../bench/decorationSwayWasmMicrobench.mjs';
import { instantiateKernel } from '../bench/wasmKernelHelpers.mjs';
import { updateDecorationSwayJs } from '../reference/decorationSwayJs.mjs';
import { DT, frameDelta, K_MAX, LIST_CAPS, N, PHASES, pickSnapshot, rng, scramble, setGrid, stateViews, useWideParents } from '../helpers/decorationSwayScenarios.mjs';

const LIST_CAP_SLOT = SWAY_SLOTS.indexOf('listCap');
const WIDE_BITS = { indexMask: 0x7fffffff, impulseBit: 0x80000000 };

/** The first element that differs: a float as Object.is sees it (any NaN for a NaN), the rest exactly. */
function firstDiff(a, b) {
  const float = a instanceof Float32Array;
  for (let i = 0; i < a.length; i++) {
    if (float ? !(Object.is(a[i], b[i]) || (Number.isNaN(a[i]) && Number.isNaN(b[i]))) : a[i] !== b[i]) return i;
  }
  return -1;
}

/**
 * The parity frames on a u32 sway setup: `each(frame)` gets the JS's bytes and runs the kernels from the frame's
 * bytes (`frame.kernel(fn)` returns the bytes and the raw trig list it leaves).
 */
async function frames(each) {
  const s = await setupSwayKernel({ n: N, k: 100, kMax: K_MAX, listCap: 1024, seed: 0x5ee0, slotBytes: 4 });
  const w = s.worker;
  const k = instantiateKernel('decorationSway', s.memory);
  const mem = new Uint8Array(s.buffer, 0, s.layout.bytes);
  const r = rng(0xdec1);
  let frame = 0;
  for (const p of PHASES) {
    if (p.wide) useWideParents(s);
    if (w._swayBuckets !== p.k) setGrid(s, p.k);
    for (let f = 0; f < p.frames; f++, frame++) {
      s.b.table[LIST_CAP_SLOT] = LIST_CAPS[frame % LIST_CAPS.length];
      let deltaTime = DT;
      if (!p.predator) {
        scramble(r, s, p.k, f === 0 ? 1 : 0.25, p.wide);
        pickSnapshot(r, s);
        deltaTime = frameDelta(r);
      }
      w.accumulatedTime += DT;
      const before = mem.slice();
      const cacheK = w._swayBucketCacheK;
      updateDecorationSwayJs(w, deltaTime);
      const js = mem.slice();
      const jsCacheK = w._swayBucketCacheK;
      // `narrow`: a 16-bit sway, whose trig list the JS finishes with the impulse at bit 16.
      const kernel = (fn, prepare = null, narrow = false) => {
        mem.set(before);
        w._swayBucketCacheK = cacheK;
        if (prepare) prepare();
        const saved = { sway: s.b.sway, mask: s.b.trigIndexMask, impulse: s.b.trigImpulse };
        s.b.sway = fn;
        if (narrow) {
          s.b.trigIndexMask = 0xffff;
          s.b.trigImpulse = TRIG_IMPULSE;
        }
        const n = swayDecorationsWasm(s.b, w, deltaTime);
        s.b.sway = saved.sway;
        s.b.trigIndexMask = saved.mask;
        s.b.trigImpulse = saved.impulse;
        const trig = { trig: s.b.trig.slice(0, Math.max(n, 0)), value: s.b.trigValue.slice(0, Math.max(n, 0)) };
        return { bytes: mem.slice(), trig, cacheK: w._swayBucketCacheK };
      };
      each({ s, k, js, jsCacheK, kernel, before, name: `${p.name} frame ${f}` });
      mem.set(js);
      w._swayBucketCacheK = jsCacheK;
    }
  }
  return frame;
}

test('the u32 sways: the JS sway exactly, float32 within its tolerance, the 16-bit trig lists', async (t) => {
  const stats = { stepFlips: 0, worst: 0 };
  let listed = 0;
  const count = await frames(({ s, k, js, jsCacheK, kernel, before, name }) => {
    const views = stateViews(s);
    const wide = kernel(k.sway_decorations_u32);
    assert.equal(wide.cacheK, jsCacheK, `${name}: the cache grid`);
    for (const [view, v] of views) {
      const a = new v.constructor(js.buffer, v.byteOffset, v.length);
      const b = new v.constructor(wide.bytes.buffer, v.byteOffset, v.length);
      const at = firstDiff(a, b);
      assert.equal(at, -1, `${name}: ${view}[${at}]: JS ${a[at]}, kernel ${b[at]}`);
    }
    listed += wide.trig.trig.length;
    const f32 = kernel(k.sway_decorations_f32x4_u32);
    assert.equal(compareSwayStates(views, wide.bytes, f32.bytes, wide.trig, f32.trig, stats, WIDE_BITS), null, `${name}: float32`);
    // Each 16-bit sway on the same frame, from a u16 snapshot written over the u32 one (the u16 list fits the
    // u32 list's region): the same decoration columns, and its trig list with the impulse bit moved.
    const snap = s.worker._activeDecorationSnapshot;
    const narrowSnap = new Uint16Array(s.buffer, s.regions.snapshot.byte, snap.length);
    const ids = new Uint32Array(before.buffer, snap.byteOffset, snap.length).slice();
    for (const [narrowFn, wideRun] of [[k.sway_decorations, wide], [k.sway_decorations_f32x4, f32]]) {
      const narrow = kernel(narrowFn, () => narrowSnap.set(ids), true);
      for (const [view, v] of views) {
        if (view === 'snapshot') continue;
        const a = new v.constructor(wideRun.bytes.buffer, v.byteOffset, v.length);
        const b = new v.constructor(narrow.bytes.buffer, v.byteOffset, v.length);
        const at = firstDiff(a, b);
        assert.equal(at, -1, `${name}: ${view}[${at}]: u32 ${a[at]}, u16 ${b[at]}`);
      }
      const mapped = Array.from(narrow.trig.trig, (e) => (e & TRIG_IMPULSE ? (e & 0xffff) + 0x80000000 : e));
      assert.deepEqual(mapped, Array.from(wideRun.trig.trig), `${name}: the trig entries`);
      assert.deepEqual(Array.from(narrow.trig.value), Array.from(wideRun.trig.value), `${name}: the trig values`);
    }
  });
  assert.ok(count > 100 && listed > 0, `${count} frames, ${listed} trig entries`);
  t.diagnostic(`float32: rotation error at most ${(stats.worst * 100).toFixed(0)} % of its slack, ${stats.stepFlips} across the 0.08 rad step`);
});
