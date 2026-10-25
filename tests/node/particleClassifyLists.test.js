// E-129: the JS integrate's classify lists. updateParticlePhysicsBuffers keeps its 16-bit module lists when it is
// given none (every caller up to 65 535 slots); particleClassifyLists gives those same lists up to 65 535 slots
// and 32-bit ones past that. With 32-bit lists:
// - a 12 000-slot pool integrates to the same bytes, frame after frame, as with the module's lists;
// - a 70 000-slot pool whose slots 65 536 and up mirror slots 0 to 4 463 integrates each mirror as its original
//   (with 16-bit lists the high slots' indices would wrap onto the low ones): the same columns, both returned to
//   the pool or stamped together.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { particleClassifyLists, updateParticlePhysicsBuffers } from '../reference/particleIntegrate.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { copyParticle, liveSlots, particleBytes, randomParticle, sameParticle } from '../helpers/particlePoolStates.mjs';

const pc = ParticleComponent;
const DT_RATIOS = [1, 1.37, 0.83, 2.5];

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

test('particleClassifyLists: the module lists up to 65 535 slots, 32-bit lists past it', () => {
  const [f, h] = particleClassifyLists(65535);
  assert.ok(f instanceof Uint16Array && h instanceof Uint16Array && f.length === 65536 && h.length === 65536);
  const [f2, h2] = particleClassifyLists(100);
  assert.ok(f2 === f && h2 === h, 'one pair of module lists, the ones updateParticlePhysicsBuffers takes by default');
  const [w, wh] = particleClassifyLists(65536);
  assert.ok(w instanceof Uint32Array && wh instanceof Uint32Array && w.length === 65536 && wh !== w);
});

test('32-bit classify lists integrate a 16-bit pool to the same bytes as the module lists', () => {
  const N = 12000;
  pc.initializeArrays(new SharedArrayBuffer(pc.getBufferSize(N)), N);
  const r = mulberry32(0x129c);
  for (let i = 0; i < N; i++) randomParticle(r, i);
  const start = particleBytes(N);
  const [wf, wh] = particleClassifyLists(70000);
  const run = (lists) => {
    const cols = Object.keys(pc.ARRAY_SCHEMA);
    cols.forEach((name, c) => new Uint8Array(pc[name].buffer, pc[name].byteOffset, start[c].length).set(start[c]));
    const indices = new Uint32Array(N);
    const stamp = new Uint32Array(N);
    const out = [];
    const dead = recordReturns(() => {
      for (let f = 0; f < 12; f++) {
        const count = liveSlots(N, indices);
        const res = updateParticlePhysicsBuffers(pc, indices, count, 16.7 * DT_RATIOS[f % 4], DT_RATIOS[f % 4], true, stamp, ...lists);
        out.push(res.activeCount, res.stampedCount, ...stamp.subarray(0, res.stampedCount));
      }
    });
    return { bytes: particleBytes(N), out, dead };
  };
  const a = run([]);
  const b = run([wf, wh]);
  assert.deepEqual(b.out, a.out, 'the counts and stamps');
  assert.deepEqual(b.dead, a.dead, 'the returns, in order');
  a.bytes.forEach((col, c) => assert.equal(Buffer.compare(col, b.bytes[c]), 0, `column ${Object.keys(pc.ARRAY_SCHEMA)[c]}`));
});

test('32-bit classify lists integrate slots past 65 535 as the slots they mirror', () => {
  const N = 70000;
  const LOW = N - 65536;
  pc.initializeArrays(new SharedArrayBuffer(pc.getBufferSize(N)), N);
  const r = mulberry32(0x129d);
  for (let i = 0; i < N; i++) pc.active[i] = 0;
  for (let i = 0; i < LOW; i++) {
    randomParticle(r, i, 0.9);
    copyParticle(i, i + 65536);
  }
  const lists = particleClassifyLists(N);
  const indices = new Uint32Array(N);
  const stamp = new Uint32Array(N);
  let stamped = 0;
  const dead = recordReturns(() => {
    for (let f = 0; f < 10; f++) {
      const count = liveSlots(N, indices);
      const res = updateParticlePhysicsBuffers(pc, indices, count, 16.7 * DT_RATIOS[f % 4], DT_RATIOS[f % 4], true, stamp, ...lists);
      // Each stamp in slot order: a low slot, then its mirror; they hold their slots like the dead.
      for (let s = 0; s < res.stampedCount; s++) stamp[s] < 65536 ? stamped++ : stamped--;
    }
  });
  for (let i = 0; i < LOW; i++) assert.equal(sameParticle(i, i + 65536), null, `slot ${i} and its mirror`);
  const low = dead.filter((i) => i < 65536).sort((a, b) => a - b);
  const high = dead.filter((i) => i >= 65536).map((i) => i - 65536).sort((a, b) => a - b);
  assert.ok(low.length > 100, `${low.length} returns`);
  assert.deepEqual(high, low, 'every returned slot with its mirror');
  assert.equal(stamped, 0, 'every stamped slot with its mirror');
});
