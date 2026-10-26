// The float32 shadow stamps (tests/fixtures/wasm/shadowStampF32.wasm, from wasm/test/shadowStampF32.c) against
// the shipped double kernel (shadowStamp.wasm, through shadowStampClient.js), on the render-queue memory the
// scene builds. The rows are copies, so the tolerance is about which (light, caster) pairs are written:
// tests/bench/shadowStampTolerance.mjs states it (a pair that differs is a tie within tau = 2^-23 (|lx| + |ly|)
// + 2^-22 d px of a light's selection boundary or range, or of another light of the same caster; an order that
// differs swaps tied values; every row is a bit-exact copy with its light's vec4).
//
// Frames: shadowStampWasm.test.js's random frames (every branch of the stamp), and frames built on ties at
// coordinates where float32 steps are 2^-11 to 2^-9 px: rings of casters around a light that keeps only some
// of them, casters on a light's range, casters as near to several lights with maxShadowsPerEntity, two lights
// that share a ring (a light's tie moves a caster's lights), and an outlier that forces the full scan.
// Each kernel runs capped (the frame's stamp cap) and uncapped (a stamp region with a row for every pair): the
// capped rows are a prefix of the uncapped ones, the uncapped ones are compared, and the f32x4 kernel writes
// what the scalar float32 kernel writes, bit for bit. Mutants: the float32 kernel with every range widened by
// 2^-12, a caster swapped for one that is not tied, a light vec4 one float step off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { compareStamps } from '../bench/shadowStampTolerance.mjs';
import { LIGHTS, PER_ENTITY, frame, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/shadowStampF32.wasm'));
const SF = GPU_CASTER_FLOATS;
const f32 = Math.fround;

async function bindVariants(s) {
  const k = await loadWasmKernel('shadowStampF32', KERNEL_URL, s.m.memory, ['stamp_light_range_f32', 'stamp_light_range_f32x4']);
  return {
    f32: { ...s.b, stampRange: k.stamp_light_range_f32 },
    f32x4: { ...s.b, stampRange: k.stamp_light_range_f32x4 },
  };
}

/** One call: the cursor and a copy of the rows and light indices it wrote. */
function runStamp(bound, spec, dst, rows) {
  const n = Math.min(dst.stampLightIdx.length, rows);
  dst.stamp.fill(NaN, 0, n * SF);
  dst.stampLightIdx.fill(0xa5a5, 0, n);
  const cursor = stampLightRangeWasm(bound, spec);
  assert.ok(cursor >= 0, 'the kernel took the call');
  return { cursor, stamp: dst.stamp.slice(0, cursor * SF), lightIdx: dst.stampLightIdx.slice(0, cursor) };
}

function sameOutput(a, b) {
  if (a.cursor !== b.cursor) return false;
  const wa = new Uint32Array(a.stamp.buffer);
  const wb = new Uint32Array(b.stamp.buffer);
  return wa.every((w, q) => w === wb[q]) && a.lightIdx.every((x, q) => x === b.lightIdx[q]);
}

/** A capped call writes the uncapped call's first rows, and stops where the cap and the base put it. */
function assertPrefix(capped, all, spec, label) {
  const base = spec.stampBase | 0;
  const cap = spec.stampCap | 0;
  const want = base >= cap ? base : Math.min(cap, all.cursor);
  assert.equal(capped.cursor, want, `${label}: capped cursor`);
  const wc = new Uint32Array(capped.stamp.buffer);
  const wa = new Uint32Array(all.stamp.buffer);
  for (let q = base * SF; q < capped.cursor * SF; q++) assert.equal(wc[q], wa[q], `${label}: capped row ${Math.floor(q / SF)}`);
  for (let k = base; k < capped.cursor; k++) assert.equal(capped.lightIdx[k], all.lightIdx[k], `${label}: capped light index ${k}`);
}

/**
 * Frames on ties. Lights sit 8 000 to 32 000 px out at coordinates float32 cannot hold, so the float32 kernel
 * rounds them (up to 2^-10 px) and its distances differ from the double ones by about that much.
 */
function tieFrame(r, k, caps, dst) {
  const kind = k % 4;
  const sun = dst.sun;
  let nSun = 0;
  const put = (x, y) => {
    if (nSun >= caps.maxSun) return;
    const b = nSun * SF;
    sun[b] = x;
    sun[b + 1] = y;
    for (let f = 2; f < SF; f++) sun[b + f] = r();
    nSun++;
  };
  const ring = (cx, cy, rho, n, jitter) => {
    const a0 = r() * Math.PI * 2;
    for (let j = 0; j < n; j++) {
      const a = a0 + (j / n) * Math.PI * 2;
      const d = rho + (r() - 0.5) * jitter;
      put(f32(cx + d * Math.cos(a)), f32(cy + d * Math.sin(a)));
    }
  };
  const lights = [];
  const at = () => 8000 + r() * 24000 + 0.123456789;
  let maxPerEntity = 0;
  let maxPerLight = 0;
  if (kind === 0) {
    // Selection ties: each light keeps `keep` of a ring, with a few casters nearer.
    const n = 1 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const lx = at();
      const ly = at();
      const rho = 60 + r() * 180;
      const keep = 4 + Math.floor(r() * 16);
      for (let q = 0; q < keep >> 1; q++) put(f32(lx + (r() - 0.5) * rho), f32(ly + (r() - 0.5) * rho));
      ring(lx, ly, rho, 24 + Math.floor(r() * 72), 0);
      lights.push({ x: lx, y: ly, intensity: 1, rangeSq: (rho * 1.6) ** 2, maxShadows: keep });
    }
    maxPerLight = r() < 0.5 ? 0 : 16;
  } else if (kind === 1) {
    // Range ties: casters on the range, 0.06 px in or out at most.
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const lx = at();
      const ly = at();
      const range = 80 + r() * 300;
      ring(lx, ly, range, 48 + Math.floor(r() * 80), 0.12);
      for (let q = 0; q < 16; q++) put(f32(lx + (r() - 0.5) * range), f32(ly + (r() - 0.5) * range));
      lights.push({ x: lx, y: ly, intensity: 1, rangeSq: range * range, maxShadows: 0 });
    }
  } else if (kind === 2) {
    // Per-caster ties: casters near a centre, lights on a ring around it.
    maxPerEntity = 1 + Math.floor(r() * PER_ENTITY);
    const cx = at();
    const cy = at();
    for (let q = 0; q < 40; q++) put(f32(cx + (r() - 0.5) * 0.01), f32(cy + (r() - 0.5) * 0.01));
    const n = 2 + Math.floor(r() * (LIGHTS - 2));
    const rho = 50 + r() * 200;
    const a0 = r() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      lights.push({ x: cx + rho * Math.cos(a), y: cy + rho * Math.sin(a), intensity: 1, rangeSq: (rho * 2) ** 2, maxShadows: 0 });
    }
  } else {
    // Two lights a few px apart on one ring, each keeping some of it, and maxShadowsPerEntity: a tie at one
    // light changes which lights a caster keeps.
    maxPerEntity = 1 + Math.floor(r() * 2);
    const pairs = 1 + Math.floor(r() * 4);
    for (let i = 0; i < pairs; i++) {
      const cx = at();
      const cy = at();
      const rho = 60 + r() * 150;
      ring(cx, cy, rho, 32 + Math.floor(r() * 48), 0);
      for (let q = 0; q < 2; q++) {
        lights.push({ x: cx + (r() - 0.5) * 0.004, y: cy + (r() - 0.5) * 0.004, intensity: 1, rangeSq: (rho * 1.5) ** 2, maxShadows: 6 + Math.floor(r() * 12) });
      }
    }
  }
  // Half the frames: an outlier 40 000 px away, past the grid's 128 x 128 cells (the full scan).
  if (k % 8 >= 4) put(f32(50000 + r()), f32(50000 + r()));
  sun.fill(0, nSun * SF, (nSun + 1) * SF);
  return {
    nSun,
    lights,
    maxPerLight,
    maxPerEntity,
    lightBegin: 0,
    lightStride: 1,
    stampCap: k % 5 === 4 ? Math.floor(r() * 200) : caps.maxStamp,
    stampBase: k % 9 === 8 ? 2 : 0,
  };
}

/** Every kernel on a frame: shipped, float32 and f32x4, capped and uncapped; the checks; the comparison. */
function checkFrame(s, v, f, label) {
  const { caps, dst, b, scratch } = s;
  const spec = specFor(f, dst, scratch);
  const all = { ...spec, stampCap: caps.maxStamp };
  const ref = runStamp(b, all, dst, caps.maxStamp);
  assert.ok(ref.cursor < caps.maxStamp, `${label}: the uncapped stamp never fills`);
  const rows = Math.min(caps.maxStamp, ref.cursor + 1024);
  assertPrefix(runStamp(b, spec, dst, rows), ref, spec, `${label} shipped`);
  const outs = {};
  for (const [name, bound] of Object.entries(v)) {
    outs[name] = runStamp(bound, all, dst, rows);
    assert.ok(outs[name].cursor < caps.maxStamp, `${label} ${name}: the uncapped stamp never fills`);
    assertPrefix(runStamp(bound, spec, dst, rows), outs[name], spec, `${label} ${name}`);
  }
  assert.ok(sameOutput(outs.f32x4, outs.f32), `${label}: f32x4 writes what the scalar float32 kernel writes`);
  const cmp = compareStamps(all, GPU_CASTER_LIGHT_FLOAT, ref, outs.f32);
  assert.ok(cmp.ok, `${label}: ${cmp.problems.slice(0, 4).join('; ')}`);
  return { cmp, spec, all, ref, out: outs.f32 };
}

function tallyOf() {
  return { frames: 0, identical: 0, orderOnly: 0, flipFrames: 0, flips: 0, orderSwaps: 0, tiedPairs: 0, rows: 0, worstFlipPx: 0, worstFlipTauPx: 0 };
}

function add(t, cmp) {
  t.frames++;
  t.rows += cmp.rows;
  t.tiedPairs += cmp.tiedPairs;
  t.orderSwaps += cmp.orderSwaps;
  t.flips += cmp.flips;
  if (cmp.identical) t.identical++;
  else if (cmp.flips === 0) t.orderOnly++;
  else t.flipFrames++;
  if (cmp.worstFlipPx > t.worstFlipPx) {
    t.worstFlipPx = cmp.worstFlipPx;
    t.worstFlipTauPx = cmp.worstFlipTauPx;
  }
}

test('the float32 stamps keep the shipped stamp\'s pairs on its random frames', async (t) => {
  const s = await setup({ allPairs: true });
  const v = await bindVariants(s);
  const r = rng(0x5ea1);
  const tally = tallyOf();
  for (let k = 0; k < 240; k++) {
    const f = frame(r, k, s.caps, s.dst);
    add(tally, checkFrame(s, v, f, `frame ${k}`).cmp);
  }
  assert.ok(tally.rows > 100000, `the frames stamp something (${tally.rows} rows)`);
  // Away from built ties a flip needs two distances within ~1e-4 px of each other: none here.
  assert.ok(tally.flips <= 2, `flips ${tally.flips}`);
  t.diagnostic(`random frames: ${JSON.stringify(tally)}`);
});

test('the float32 stamps flip only tied pairs on frames built on ties', async (t) => {
  const s = await setup({ allPairs: true });
  const v = await bindVariants(s);
  const r = rng(0xf32);
  const byKind = [tallyOf(), tallyOf(), tallyOf(), tallyOf()];
  for (let k = 0; k < 160; k++) {
    const f = tieFrame(r, k, s.caps, s.dst);
    add(byKind[k % 4], checkFrame(s, v, f, `tie frame ${k} (kind ${k % 4})`).cmp);
  }
  const total = byKind.reduce((a, b) => a + b.flips, 0);
  // The comparison is exercised: float32 does flip ties here, and each kind has some.
  for (const kind of [0, 1, 3]) assert.ok(byKind[kind].tiedPairs > 0, `kind ${kind} builds ties at its lights`);
  assert.ok(byKind[0].flips > 0 && byKind[1].flips > 0, `selection and range ties flip (${byKind[0].flips}, ${byKind[1].flips})`);
  assert.ok(byKind[2].flips + byKind[2].orderSwaps + byKind[3].flips > 0, 'per-caster ties flip or swap');
  t.diagnostic(`tie frames, ${total} flips: ${byKind.map((x, kind) => `kind ${kind} ${JSON.stringify(x)}`).join('; ')}`);
});

test('the comparison catches a kernel or a row that is off by more than a tie', async () => {
  const s = await setup({ allPairs: true });
  const v = await bindVariants(s);
  const r = rng(0xbad);
  let widened = 0;
  let caught = 0;
  for (let k = 1; k < 64; k += 4) {
    // Range ties (kind 1): the float32 kernel on lights whose range is 2^-12 wider (about 0.04 px).
    const f = tieFrame(r, k, s.caps, s.dst);
    const { all, ref } = checkFrame(s, v, f, `mutant frame ${k}`);
    const wide = { ...all, lights: all.lights.map((L) => ({ ...L, rangeSq: L.rangeSq * (1 + 2 ** -12) ** 2 })) };
    const out = runStamp(v.f32, wide, s.dst, s.caps.maxStamp);
    if (out.cursor === ref.cursor) continue;
    widened++;
    if (!compareStamps(all, GPU_CASTER_LIGHT_FLOAT, ref, out).ok) caught++;
  }
  assert.ok(widened > 0, 'the wider range stamps more casters');
  assert.equal(caught, widened, 'every wider-range stamp is caught');

  // A caster swapped for one the light did not keep and is not tied with it: the farthest caster of a
  // selection frame with the outlier (kind 0, k = 4).
  const f0 = tieFrame(r, 4, s.caps, s.dst);
  const one = checkFrame(s, v, f0, 'swap frame');
  const rows = one.out.stamp;
  const L = one.all.lights[one.out.lightIdx[0]];
  const sun = s.dst.sun;
  let far = -1;
  let farD = -1;
  for (let c = 0; c < f0.nSun; c++) {
    const dx = sun[c * SF] - L.x;
    const dy = sun[c * SF + 1] - L.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > farD) {
      far = c;
      farD = d;
    }
  }
  const swapped = { ...one.out, stamp: rows.slice() };
  for (let q = 0; q < GPU_CASTER_LIGHT_FLOAT; q++) swapped.stamp[q] = sun[far * SF + q];
  const bad = compareStamps(one.all, GPU_CASTER_LIGHT_FLOAT, one.ref, swapped);
  assert.ok(!bad.ok && /not a tie/.test(bad.problems.join()), `a far caster in a light's rows is caught: ${bad.problems[0]}`);

  // A light vec4 one float step off.
  const nudged = { ...one.out, stamp: rows.slice() };
  const w = new Uint32Array(nudged.stamp.buffer);
  w[GPU_CASTER_LIGHT_FLOAT] += 1;
  const off = compareStamps(one.all, GPU_CASTER_LIGHT_FLOAT, one.ref, nudged);
  assert.ok(!off.ok && /light vec4/.test(off.problems.join()), 'a light vec4 one step off is caught');
});
