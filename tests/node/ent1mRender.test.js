import test from 'node:test';
import assert from 'node:assert/strict';

import { OPAQUE_MAX_ROWS, opaquePoseTextureRows } from '../../src/render/opaquePass.js';
import { bindPainterRadix, createWasmPainterState, orderPainterSlotsWasm } from '../../src/render/painterRadixClient.js';
import { poseBlockFloats, POSE_ROW_FLOATS, staticsTextureHeight } from '../../src/render/spriteIndexed.js';
import { MAX_ENTITIES_U32 } from '../../src/util/entityIdWidth.js';
import { layoutRegions, painterStateLayout, painterStateRegions } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { createPainterState, orderPainterSlots } from '../reference/painterJs.mjs';

// DX-ENT1M: the render side of a million sprites. The render queue keeps no entity id (its rows are draw items), so
// what a million entities reach there is the queue's rows: the painter's order over 1 048 575 rows (painterRadix.wasm,
// the shipped variant, on a state laid out as the render-queue memory lays it), the depth each row's slot gets, and the
// textures the rows' poses and statics go up in.

const N = MAX_ENTITIES_U32;

/** floatBitsToOrd: the float order as an unsigned order. */
function ordOf(u) {
  return (u ^ ((u >> 31) | 0x80000000)) >>> 0;
}

/** The stable order by key: each row's (ordinal, row) as one exact double, sorted. */
function stableOrder(keysU32, n) {
  const composite = new Float64Array(n);
  for (let i = 0; i < n; i++) composite[i] = ordOf(keysU32[i]) * 1048576 + i;
  composite.sort();
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = composite[i] % 1048576;
  return out;
}

function firstDifference(a, b, n) {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

test('the painter orders 1 048 575 rows: the stable sort by key first, then the JS painter\'s order after moves', async () => {
  const map = layoutRegions([
    { name: 'guard', bytes: 64, owner: 'test' },
    ...painterStateRegions('painter', N, 'test'),
    { name: 'keys', bytes: N * 4, owner: 'test' },
  ]);
  const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
  const binding = await bindPainterRadix(memory, painterStateLayout(map.regions, 'painter', N));
  const state = createWasmPainterState(binding);
  const keysF32 = new Float32Array(memory.buffer, map.regions.keys.byte, N);
  const keysU32 = new Uint32Array(memory.buffer, map.regions.keys.byte, N);
  const rng = mulberry32(0x1e6);
  // Y-sort keys across a tall world, on half pixels so many rows tie (the stable order keeps them in row order).
  for (let i = 0; i < N; i++) keysF32[i] = Math.round((rng() * 9000 - 1500) * 2) / 2;

  // The JS painter the kernel replaced (tests/reference/painterJs.mjs), on its own state over the same keys: after a
  // reinsert a moved row's place among equal keys is the merge's, so the order to match is the painter's, not a sort.
  const js = createPainterState(N);
  const check = (label, order) => {
    const want = orderPainterSlots(js, null, N, keysU32);
    const at = firstDifference(order, want, N);
    if (at >= 0) assert.fail(`${label}: draw slot ${at} holds row ${order[at]}, not ${want[at]}`);
    const seen = new Uint8Array(N);
    let prev = 0;
    for (let k = 0; k < N; k++) {
      const row = order[k];
      if (seen[row]) assert.fail(`${label}: row ${row} drawn twice`);
      seen[row] = 1;
      const ord = ordOf(keysU32[row]);
      if (ord < prev) assert.fail(`${label}: draw slot ${k}'s key is below the one before it`);
      prev = ord;
    }
  };
  const first = orderPainterSlotsWasm(state, null, N, keysU32);
  const stable = stableOrder(keysU32, N);
  const at = firstDifference(first, stable, N);
  if (at >= 0) assert.fail(`first sort: draw slot ${at} holds row ${first[at]}, not ${stable[at]}`);
  check('first sort', first);

  // A few keys move (the reinsert), the last rows among them.
  for (let k = 0; k < 2000; k++) {
    const i = k < 4 ? N - 1 - k : (rng() * N) | 0;
    keysF32[i] = Math.round((rng() * 9000 - 1500) * 2) / 2;
  }
  check('2000 moved', orderPainterSlotsWasm(state, null, N, keysU32));

  // Most keys move (a full sort again).
  for (let i = 0; i < N; i++) if (rng() < 0.6) keysF32[i] -= 3.5;
  check('most moved', orderPainterSlotsWasm(state, null, N, keysU32));
});

test('at 1 048 575 rows each slot keeps its own depth, and the rows\' textures stay within WebGL 2\'s 2048 rows', () => {
  // gpuPack.c: a row at draw slot k gets 1 - (k + 1) / denom in double, stored as a float32; denom is the queue's rows
  // plus one (pixiWorker, preRenderWorker: depthDenom = renderQueueMaxItems; InstancedSpriteBatch adds the one). The
  // opaque pass compares them in a 24-bit depth buffer over window depth 0.5 to 1 (opaquePass.js).
  const denom = N + 1;
  const inv = 1 / denom;
  let prev = 2;
  let prevWindow = 2 ** 24 + 1;
  for (let k = 0; k < N; k++) {
    const depth = Math.fround(1 - (k + 1) * inv);
    if (!(depth < prev)) assert.fail(`slot ${k}: depth ${depth} is not below slot ${k - 1}'s ${prev}`);
    const windowDepth = Math.floor(((depth + 1) / 2) * 2 ** 24);
    if (!(windowDepth < prevWindow)) assert.fail(`slot ${k}: the depth buffer holds it as slot ${k - 1}`);
    prev = depth;
    prevWindow = windowDepth;
  }
  assert.ok(prev >= 0, 'every depth inside the clip range');
  assert.ok(N <= OPAQUE_MAX_ROWS, 'a million rows keep the opaque pass');
  // The pose textures (by row, E-201, and the opaque pass's copy of a pose batch's stream) and the statics texture.
  assert.ok((4 * poseBlockFloats(N)) / POSE_ROW_FLOATS <= 2048, 'the by-row pose texture');
  assert.ok(opaquePoseTextureRows(N, 6) <= 2048, 'the opaque pass\'s pose texture (6 words a row)');
  assert.ok(staticsTextureHeight(N) <= 2048, 'the statics texture');
  // A row's slot rides as a float (aInstSlot, the keyed pack's statics row): exact under 2^24.
  assert.equal(Math.fround(N - 1), N - 1);
});
