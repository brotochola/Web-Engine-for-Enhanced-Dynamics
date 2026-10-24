// W2b step A: the visibility memory laid at an offset in another memory (createVisibilityMemory's place, for
// Box2D's block) holds the same regions, and the shipped sweep bound there draws every light's polygon as it
// does on a memory of its own, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { OCC_CIRCLE, OCC_POLY, writeOrientedBoxVerts } from '../../src/render/visibility/angularSweep.js';
import { bindVisibilitySweep } from '../../src/render/visibility/visibilitySweepClient.js';
import { createVisibilityMemory, visibilityMemoryBytes } from '../../src/util/visibilityMemory.js';
import { mulberry32 } from '../bench/benchMath.js';

const OPTS = { maxOccluders: 256, poolVerts: 256 * 8, maxVerts: 256, entities: 2000, fixtures: 0 };

/** A light among random boxes and circles, written into vm's gather scratch: its occluder count. */
function loadLight(vm, rng, lx, ly) {
  const v = vm.views;
  let pool = 0;
  const n = 20 + Math.floor(rng() * 60);
  for (let o = 0; o < n; o++) {
    const x = lx + (rng() - 0.5) * 600;
    const y = ly + (rng() - 0.5) * 600;
    if (rng() < 0.4) {
      v.kind[o] = OCC_CIRCLE;
      v.cx[o] = x;
      v.cy[o] = y;
      v.cr[o] = 4 + rng() * 30;
      v.vertStart[o] = 0;
      v.vertCount[o] = 0;
    } else {
      const a = rng() * Math.PI * 2;
      v.kind[o] = OCC_POLY;
      v.vertStart[o] = pool;
      writeOrientedBoxVerts(v.vertsX, v.vertsY, pool, x, y, 8 + rng() * 60, 8 + rng() * 60, Math.cos(a), Math.sin(a), 0, 0);
      v.vertCount[o] = 4;
      pool += 4;
    }
  }
  return n;
}

async function lights(vm, f32) {
  const k = await bindVisibilitySweep(vm, { maxVerts: OPTS.maxVerts, f32 });
  const rng = mulberry32(0xb2b);
  const out = [];
  for (let l = 0; l < 200; l++) {
    const lx = 500 + rng() * 1000;
    const ly = 400 + rng() * 800;
    const occ = loadLight(vm, rng, lx, ly);
    const n = k.sweep(k.tableByte, lx, ly, 150 + rng() * 250, occ, 0);
    out.push([n, ...vm.views.outX.subarray(0, n), ...vm.views.outY.subarray(0, n)]);
  }
  return out;
}

test('the visibility regions placed in another memory sit at the offset, the same sizes', () => {
  const own = createVisibilityMemory(OPTS);
  const bytes = visibilityMemoryBytes(OPTS);
  const host = new WebAssembly.Memory({ initial: Math.ceil((bytes + (1 << 20)) / 65536), maximum: 8192, shared: true });
  const placed = createVisibilityMemory(OPTS, { memory: host, baseByte: 1 << 20 });
  assert.equal(placed.memory, host);
  assert.equal(placed.layout.baseByte, 1 << 20);
  for (const [key, value] of Object.entries(own.layout)) {
    if (key.endsWith('Byte') && key !== 'baseByte') assert.equal(placed.layout[key], value + (1 << 20), key);
  }
  for (const [name, view] of Object.entries(own.views)) {
    assert.equal(placed.views[name].length, view.length, name);
    assert.equal(placed.views[name].byteOffset, view.byteOffset + (1 << 20), name);
  }
  assert.equal(createVisibilityMemory(OPTS, { memory: host, baseByte: (1 << 20) + 8 }), null, 'not on a cache line');
  assert.equal(createVisibilityMemory(OPTS, { memory: host, baseByte: host.buffer.byteLength - 64 }), null, 'past the end');
});

test('the shipped sweep on placed regions draws what it draws on a memory of its own', async () => {
  const bytes = visibilityMemoryBytes(OPTS);
  for (const f32 of [true, false]) {
    const own = createVisibilityMemory(OPTS);
    const host = new WebAssembly.Memory({ initial: Math.ceil((bytes + (3 << 20)) / 65536), maximum: 8192, shared: true });
    new Uint8Array(host.buffer).fill(0x5a); // the host's other bytes are not the visibility memory's zeros
    const placed = createVisibilityMemory(OPTS, { memory: host, baseByte: 3 << 20 });
    new Uint8Array(host.buffer, 3 << 20, bytes).fill(0);
    const a = await lights(own, f32);
    const b = await lights(placed, f32);
    assert.deepEqual(b, a, f32 ? 'f32' : 'simd');
    assert.ok(a.some((p) => p[0] > 32), 'lights with occluders in view');
  }
});
