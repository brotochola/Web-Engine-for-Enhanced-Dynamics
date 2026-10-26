// E-76 W22, float32: sway_decorations_f32x4 (wasm/decorationSway.c) against sway_decorations, its double sway,
// which decorationSwayWasm.test.js ties to the JS sway bit for bit, on that test's
// frames (tests/helpers/decorationSwayScenarios.mjs: Predator's grass, then random decorations through every
// branch, bucket grids from 2 to 70 000, chunks of 1, 37 and 1024, the 32-bit parents), each through the bench's
// wrapper (swayDecorationsWasm: the per-bucket Math.sin / Math.cos before, Math.sin / Math.cos for the trig list
// after). Each frame starts from the shipped kernel's bytes; the sway writes rotC and rotS from the base rotation
// every frame and keeps no float32 state of its own (bucket choice and impulse phase stay double), so frame by
// frame is the whole story. compareSwayStates (decorationSwayWasmMicrobench.mjs) must pass:
// - every column, the snapshot, the phase and bucket tables and the cache exactly as shipped (any NaN for NaN);
// - rotC and rotS within swayF32Slack: 2^-21 · (1 + |amplitude|) · (1 + |baseRotC| + |baseRotS|), 1.2e-6 for
//   Predator's grass (4e-5 px at the tip of a 30 px blade);
// - the same trig list, its sway angles within 2^-21 · (1 + |amplitude|), except a decoration whose angle is
//   within that of 0.08 rad, which may cross the JS's own step there (cos 0.08 against 1, the jump every blade
//   makes when its sway passes 0.08 rad) a frame early or late;
// - except where swayF32Free holds nothing to compare: an infinite or NaN amplitude or base rotation, or a loop
//   amplitude past 6.6e6 rad, where the shipped rotation is Math.cos of an angle no rounding defines (these
//   frames sway amplitudes of 3e38); how many of those differ goes to the diagnostics.
// Two mutants must fail: the skew cosine 1.5 off by 1e-4 and the small-angle bound 0.08 moved to 0.07, both in
// the binary (a mutant's sway_decorations_f32x4 against the unchanged binary's sway_decorations).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareSwayStates,
  setupSwayKernel,
  SWAY_F32_EXPORTS,
  SWAY_SLOTS,
  swayDecorationsWasm,
} from '../bench/decorationSwayWasmMicrobench.mjs';
import {
  DT,
  frameDelta,
  K_MAX,
  LIST_CAPS,
  N,
  PHASES,
  pickSnapshot,
  rng,
  scramble,
  setGrid,
  stateViews,
  useWideParents,
} from '../helpers/decorationSwayScenarios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_CAP_SLOT = SWAY_SLOTS.indexOf('listCap');
const BINARY = fs.readFileSync(path.join(root, 'src/wasm/engine.wasm'));

/** The float32 sways of `bytes` (the fixture, or a mutant of it) on `memory`, by variant. */
function kernelsOf(bytes, memory) {
  const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
  return Object.fromEntries(Object.entries(SWAY_F32_EXPORTS).map(([v, name]) => [v, exports[name]]));
}

/**
 * The scenario frames with the shipped kernel, then each float32 variant of `bytes` from the same bytes.
 * Returns the first violation and what was seen.
 */
async function runFrames(bytes = BINARY) {
  const s = await setupSwayKernel({ n: N, k: 100, kMax: K_MAX, listCap: 1024, seed: 0x5ee0 });
  const w = s.worker;
  const shipped = s.b.sway;
  const kernels = kernelsOf(bytes, s.memory);
  const r = rng(0xdec0);
  const mem = new Uint8Array(s.buffer, 0, s.layout.bytes);
  const trigOf = (n) => ({ trig: s.b.trig.slice(0, Math.max(n, 0)), value: s.b.trigValue.slice(0, Math.max(n, 0)) });
  const stats = Object.fromEntries(Object.keys(kernels).map((v) => [v, { stepFlips: 0, worst: 0 }]));
  let frame = 0;
  let listed = 0;
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
      s.b.sway = shipped;
      const n = swayDecorationsWasm(s.b, w, deltaTime);
      listed += Math.max(n, 0);
      const refTrig = trigOf(n);
      const ref = mem.slice();
      const refCacheK = w._swayBucketCacheK;
      for (const [v, fn] of Object.entries(kernels)) {
        mem.set(before);
        w._swayBucketCacheK = cacheK;
        s.b.sway = fn;
        const m = swayDecorationsWasm(s.b, w, deltaTime);
        const got = mem.slice();
        const bad = w._swayBucketCacheK !== refCacheK ? 'the cache grid differs'
          : compareSwayStates(stateViews(s), ref, got, refTrig, trigOf(m), stats[v]);
        if (bad) return { violation: `${v}, ${p.name} frame ${f} (deltaTime ${deltaTime}): ${bad}`, stats, frame, listed };
      }
      mem.set(ref);
      w._swayBucketCacheK = refCacheK;
    }
  }
  s.b.sway = shipped;
  return { violation: null, stats, frame, listed };
}

test('float32 sways stay within tolerance of the shipped kernel, frame after frame', async (t) => {
  const r = await runFrames();
  assert.equal(r.violation, null);
  assert.ok(r.frame > 100 && r.listed > 0, `${r.frame} frames, ${r.listed} trig-list entries`);
  for (const [v, st] of Object.entries(r.stats)) {
    t.diagnostic(`${v}: rotation error at most ${(st.worstAbs ?? 0).toExponential(2)}, ${(st.worst * 100).toFixed(0)} % of its slack; ${st.stepFlips} decorations across the 0.08 rad step; ${st.free ?? 0} free rotations (3e38 amplitudes, infinite bases) that differ`);
  }
});

/** The bytes of `v` as a little-endian float64, or as the `i32.const` of a float32's bits (signed LEB128). */
function f64Bytes(v) {
  return new Uint8Array(new Float64Array([v]).buffer);
}
function f32StoreBytes(v) {
  let bits = new Int32Array(new Float32Array([v]).buffer)[0];
  const out = [0x41];
  for (;;) {
    const byte = bits & 0x7f;
    bits >>= 7;
    const done = (bits === 0 && (byte & 0x40) === 0) || (bits === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return new Uint8Array(out);
  }
}

/** `bytes` with every occurrence of `pat` replaced by `rep` (the same length). */
function patch(bytes, pat, rep) {
  assert.equal(pat.length, rep.length);
  const out = new Uint8Array(bytes);
  let hits = 0;
  for (let k = 0; k + pat.length <= out.length; k++) {
    if (pat.every((b, j) => out[k + j] === b)) {
      out.set(rep, k);
      hits++;
      k += pat.length - 1;
    }
  }
  return { bytes: out, hits };
}

test('the tolerance catches a wrong skew cosine and a moved small-angle bound', async () => {
  for (const m of [
    // The kernel stores the constant 1.5f as the i32 of its bits.
    { pat: f32StoreBytes(1.5), rep: f32StoreBytes(1.5001), caught: /rotC\[/, what: 'the skew cosine 1.5' },
    { pat: f64Bytes(0.08), rep: f64Bytes(0.07), caught: /trig list only/, what: 'the small-angle bound' },
  ]) {
    const { bytes, hits } = patch(BINARY, m.pat, m.rep);
    assert.ok(hits >= 2, `${m.what} is in the binary (${hits} found)`);
    const r = await runFrames(bytes);
    assert.match(String(r.violation), m.caught, m.what);
  }
});
