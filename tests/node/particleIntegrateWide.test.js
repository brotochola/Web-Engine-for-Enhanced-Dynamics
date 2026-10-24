// E-129: the particle integrates for a pool past 65 535 slots (wasm/particleIntegrate.c's _u32 exports, whose
// active, stamp, dead and trig lists and flat / heighted scratch are u32), on a shared memory laid out as the
// particle memory lays it out, through the shipped wrapper (integrateParticlesWasm: the dead list back to the pool
// in order, Math.cos / Math.sin for the trig list), with the pool's returns recorded in order. Twelve frames of
// dtRatios 1, 1.37, 0.83 and 2.5 from states that take every branch of the integrate:
// - on 70 000 slots, live across the whole range: integrate_batch_u32 leaves the bytes the JS integrate leaves
//   with 32-bit classify lists (particleClassifyLists), the same returns in order and the same stamps;
//   integrate_batch_f32x4_u32 the same integers and returns, its floats within integrateF32Tolerance;
// - on 12 000 slots: each u32 export leaves the bytes, returns and stamps of its 16-bit export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { particleClassifyLists, updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';
import { PARTICLE_LUT_ENTRIES } from '../../src/util/particleMemory.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { bindParticleIntegrate, integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { compareIntegrateStates, INTEGRATE_COMPARED_COLUMNS, integrateF32Tolerance } from '../bench/particleIntegrateWasmMicrobench.mjs';
import { instantiateKernel } from '../bench/wasmKernelHelpers.mjs';
import { liveSlots, particleBytes, randomParticle } from '../helpers/particlePoolStates.mjs';

const pc = ParticleComponent;
const N = 70000;
const SMALL = 12000;
const FRAMES = 12;
const DT_RATIOS = [1, 1.37, 0.83, 2.5];
const COLS = Object.keys(pc.ARRAY_SCHEMA);

/** The particle memory's regions for `n` slots of `bytes` each (as particleMemoryRegions lays them out). */
function lists(prefix, n, bytes) {
  return [
    { name: `${prefix}active`, bytes: (n + 2) * bytes },
    { name: `${prefix}stamp`, bytes: n * bytes },
    { name: `${prefix}flat`, bytes: Math.max(n, bytes === 2 ? 65536 : 0) * bytes },
    { name: `${prefix}heighted`, bytes: Math.max(n, bytes === 2 ? 65536 : 0) * bytes },
    { name: `${prefix}dead`, bytes: n * bytes },
    { name: `${prefix}trig`, bytes: n * bytes },
    { name: `${prefix}trigAngle`, bytes: n * 8 },
    { name: `${prefix}results`, bytes: 16 },
  ];
}
const map = layoutRegions([
  { name: 'component', bytes: pc.getBufferSize(N) },
  ...lists('w', N, 4),
  ...lists('n', SMALL, 2),
  { name: 'luts', bytes: 3 * PARTICLE_LUT_ENTRIES * 4 },
  { name: 'columns', bytes: 256 },
]);
const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
const buffer = memory.buffer;
pc.initializeArrays(buffer, N);
const R = map.regions;
const layoutOf = (p, bytes) => ({
  activeListByte: R[`${p}active`].byte,
  indicesByte: R[`${p}active`].byte + bytes,
  stampByte: R[`${p}stamp`].byte,
  flatByte: R[`${p}flat`].byte,
  heightedByte: R[`${p}heighted`].byte,
  deadByte: R[`${p}dead`].byte,
  trigByte: R[`${p}trig`].byte,
  trigAngleByte: R[`${p}trigAngle`].byte,
  resultsByte: R[`${p}results`].byte,
  lutByte: R.luts.byte,
  columnsByte: R.columns.byte,
});
const L32 = layoutOf('w', 4);
const L16 = layoutOf('n', 2);
// The shipped bind writes the column table and the EXPO tables; the bindings below take its place for each width.
await bindParticleIntegrate(memory, L16, pc, SMALL);
const k = instantiateKernel('particleIntegrate', memory);

function binding(name, L, Slot, n) {
  return {
    integrate: k[name],
    layout: L,
    lutSize: PARTICLE_LUT_ENTRIES - 1,
    indices: new Slot(buffer, L.indicesByte, n),
    stamp: new Slot(buffer, L.stampByte, n),
    dead: new Slot(buffer, L.deadByte, n),
    trig: new Slot(buffer, L.trigByte, n),
    trigAngle: new Float64Array(buffer, L.trigAngleByte, n),
    results: new Int32Array(buffer, L.resultsByte, 4),
    out: { activeCount: 0, stampedCount: 0 },
  };
}

/** returnToPool recorded instead of a free list (the pool is filled without the emitter). */
function recordReturns(fn) {
  const dead = [];
  const saved = Object.getOwnPropertyDescriptor(ParticleEmitter, 'returnToPool');
  ParticleEmitter.returnToPool = (i) => dead.push(i);
  try {
    fn();
  } finally {
    Object.defineProperty(ParticleEmitter, 'returnToPool', saved);
  }
  return dead;
}

function restore(state) {
  COLS.forEach((name, c) => new Uint8Array(pc[name].buffer, pc[name].byteOffset, state[c].length).set(state[c]));
}

/** FRAMES frames from `start` on n slots: `step(list, count, deltaTime, dtRatio)` returns the stamps. */
function run(start, n, list, step) {
  restore(start);
  const stamps = [];
  const counts = [];
  const dead = recordReturns(() => {
    for (let f = 0; f < FRAMES; f++) {
      const dtRatio = DT_RATIOS[f % DT_RATIOS.length];
      const count = liveSlots(n, list);
      const s = step(list, count, (1000 / 60) * dtRatio, dtRatio);
      counts.push(count, s.length);
      stamps.push(...s);
    }
  });
  return { bytes: particleBytes(n), stamps, counts, dead, list: list.slice(0, liveSlots(n, list)) };
}

function wasmStep(b) {
  return (list, count, deltaTime, dtRatio) => {
    const out = integrateParticlesWasm(b, pc, count, deltaTime, dtRatio, true);
    return Array.from(b.stamp.subarray(0, out.stampedCount));
  };
}

function sameRun(a, b, what) {
  assert.deepEqual(b.counts, a.counts, `${what}: the counts`);
  assert.deepEqual(b.dead, a.dead, `${what}: the returns, in order`);
  assert.deepEqual(b.stamps, a.stamps, `${what}: the stamps`);
  a.bytes.forEach((col, c) => assert.equal(Buffer.compare(col, b.bytes[c]), 0, `${what}: column ${COLS[c]}`));
}

/** A run's state as compareIntegrateStates reads it. */
function stateOf(r, n) {
  const out = { freeList: [], freeListTop: [] };
  for (const name of INTEGRATE_COMPARED_COLUMNS) {
    const c = COLS.indexOf(name);
    const live = pc[name];
    out[name] = new live.constructor(r.bytes[c].buffer, 0, n * (live.length / pc.active.length));
  }
  return out;
}

test('the u32 integrates past 65 535 slots: the JS integrate exactly, float32 within its tolerance', () => {
  const r = mulberry32(0x129e);
  for (let i = 0; i < N; i++) randomParticle(r, i, 0.8);
  let high = 0;
  for (let i = 65536; i < N; i++) high += pc.active[i];
  assert.ok(high > 3000, `${high} live slots past 65 535`);
  const start = particleBytes(N);
  const [flat, heighted] = particleClassifyLists(N);
  const jsStamp = new Uint32Array(N);
  const js = run(start, N, new Uint32Array(N), (list, count, deltaTime, dtRatio) => {
    const out = updateParticlePhysicsBuffers(pc, list, count, deltaTime, dtRatio, true, jsStamp, flat, heighted);
    return Array.from(jsStamp.subarray(0, out.stampedCount));
  });
  const b32 = binding('integrate_batch_u32', L32, Uint32Array, N);
  const wasm = run(start, N, b32.indices, wasmStep(b32));
  sameRun(js, wasm, 'integrate_batch_u32');
  assert.ok(js.dead.some((i) => i > 65535) && js.stamps.some((i) => i > 65535), 'returns and stamps past 65 535');
  const f32 = run(start, N, b32.indices, wasmStep(binding('integrate_batch_f32x4_u32', L32, Uint32Array, N)));
  assert.deepEqual(f32.counts, js.counts, 'float32: the counts');
  assert.deepEqual(f32.dead, js.dead, 'float32: the returns, in order');
  assert.deepEqual(f32.stamps, js.stamps, 'float32: the stamps');
  const worst = {};
  const bad = compareIntegrateStates(stateOf(js, N), stateOf(f32, N), js.list, js.list.length, worst, integrateF32Tolerance(FRAMES));
  assert.equal(bad, null, 'integrate_batch_f32x4_u32 within integrateF32Tolerance');
});

test('on a pool of 16-bit size each u32 integrate leaves what its 16-bit integrate leaves', () => {
  const r = mulberry32(0x129f);
  for (let i = 0; i < SMALL; i++) randomParticle(r, i, 0.8);
  const start = particleBytes(SMALL);
  for (const [narrow, wide] of [['integrate_batch', 'integrate_batch_u32'], ['integrate_batch_f32x4', 'integrate_batch_f32x4_u32']]) {
    const b16 = binding(narrow, L16, Uint16Array, SMALL);
    const b32 = binding(wide, L32, Uint32Array, SMALL);
    const a = run(start, SMALL, b16.indices, wasmStep(b16));
    const b = run(start, SMALL, b32.indices, wasmStep(b32));
    assert.ok(a.dead.length > 100 && a.stamps.length > 10, `${narrow}: ${a.dead.length} returns, ${a.stamps.length} stamps`);
    sameRun(a, b, wide);
  }
});
