import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_SPRITE_FLOATS,
  packInstancedRows,
  writeGpuSpriteRow,
  gatherInstancedRows,
  makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import {
  spriteYSortKey,
  zSortBand,
  orderSortKey,
  createPainterState,
  orderPainterSlots,
} from '../../src/util/sortIndexByKey.js';

const Y_SORT_K = 128;

/** foot-Y band the spatial scan would stamp. Last band eats the top edge. */
function yBandIndex(footY, worldHeight, workerCount) {
  const n = workerCount | 0;
  if (n <= 1) return 0;
  const h = worldHeight > 0 ? worldHeight : 1;
  let b = (n * footY / h) | 0;
  if (b < 0) b = 0;
  else if (b >= n) b = n - 1;
  return b;
}

function keysU32Of(sortKey) {
  return new Uint32Array(sortKey.buffer, sortKey.byteOffset, sortKey.length);
}

function rewritePackedDepth(dst, n, depthDenom) {
  const denom = depthDenom > 0 ? depthDenom : 1;
  for (let k = 0; k < n; k++) {
    dst[k * GPU_SPRITE_FLOATS + 8] = 1.0 - (k + 1) / denom;
  }
}

function makeSoA(n, xs, ys, extras = {}) {
  const q = {
    count: n,
    x: new Float32Array(xs),
    y: new Float32Array(ys),
    scaleX: extras.scaleX || new Float32Array(n).fill(1),
    scaleY: extras.scaleY || new Float32Array(n).fill(1),
    rotC: extras.rotC || new Float32Array(n).fill(1),
    rotS: extras.rotS || new Float32Array(n).fill(0),
    alpha: extras.alpha || new Float32Array(n).fill(1),
    tint: extras.tint || new Uint32Array(n).fill(0xffffff),
    textureId: extras.textureId || new Uint16Array(n).fill(1),
    anchorX: extras.anchorX || new Float32Array(n).fill(0.5),
    anchorY: extras.anchorY || new Float32Array(n).fill(1),
    type: extras.type || new Uint8Array(n),
    sortKey: extras.sortKey || new Float32Array(n),
    alphaCutOff: extras.alphaCutOff || new Uint8Array(n),
    tileMulX: extras.tileMulX || new Float32Array(n),
    tileMulY: extras.tileMulY || new Float32Array(n),
    tileOffsetU: extras.tileOffsetU || new Uint16Array(n),
    tileOffsetV: extras.tileOffsetV || new Uint16Array(n),
  };
  return q;
}

test('writeGpuSpriteRow matches packInstancedRows on 16 floats (H-born row)', () => {
  const q = makeSoA(2, [12, 90], [34, 8], {
    scaleX: new Float32Array([2, 1]),
    scaleY: new Float32Array([3, 4]),
    rotC: new Float32Array([0.8, 1]),
    rotS: new Float32Array([0.6, 0]),
    alpha: new Float32Array([0.25, 1]),
    tint: new Uint32Array([0x112233, 0x445566]),
    textureId: new Uint16Array([7, 9]),
    alphaCutOff: new Uint8Array([40, 0]),
    tileMulX: new Float32Array([0.5, 0]),
    tileMulY: new Float32Array([0.25, 0]),
    tileOffsetU: new Uint16Array([32768, 0]),
  });
  const packed = new Float32Array(2 * GPU_SPRITE_FLOATS);
  const packedU32 = new Uint32Array(packed.buffer);
  const ctx = makePackContext(q, { depthDenom: 2 }, 2);
  packInstancedRows(q, ctx, packed, packedU32, GPU_SPRITE_FLOATS, 2, false);

  const direct = new Float32Array(2 * GPU_SPRITE_FLOATS);
  const directU32 = new Uint32Array(direct.buffer);
  for (let i = 0; i < 2; i++) {
    writeGpuSpriteRow(direct, directU32, i, {
      x: q.x[i], y: q.y[i], sx: q.scaleX[i], sy: q.scaleY[i],
      ax: q.anchorX[i], ay: q.anchorY[i], rc: q.rotC[i], rs: q.rotS[i],
      a: q.alpha[i], tint: q.tint[i], tex: q.textureId[i],
      invX: q.tileMulX[i], invY: q.tileMulY[i],
      u: q.tileOffsetU[i] * (1 / 65535), v: 0, cut: q.alphaCutOff[i],
    }, { depthDenom: 2 });
  }
  assert.deepEqual(Array.from(direct), Array.from(packed));
});

test('gather then rewrite depth matches packInstancedRows in painter order', () => {
  const n = 4;
  const ys = [40, 10, 30, 20];
  const q = makeSoA(n, [1, 2, 3, 4], ys);
  for (let i = 0; i < n; i++) q.sortKey[i] = spriteYSortKey(ys[i], Y_SORT_K);

  const emit = new Float32Array(n * GPU_SPRITE_FLOATS);
  const emitU32 = new Uint32Array(emit.buffer);
  for (let i = 0; i < n; i++) {
    writeGpuSpriteRow(emit, emitU32, i, {
      x: q.x[i], y: q.y[i], sx: 1, sy: 1, ax: 0.5, ay: 1, rc: 1, rs: 0,
      a: 1, tint: 0xffffff, tex: 1, invX: 0, invY: 0, u: 0, v: 0, cut: 0,
    }, { depthDenom: n });
  }

  const idx = new Uint32Array([0, 1, 2, 3]);
  const painter = createPainterState(n);
  const order = orderPainterSlots(painter, idx, n, keysU32Of(q.sortKey));
  const gathered = new Float32Array(n * GPU_SPRITE_FLOATS);
  gatherInstancedRows(emit, gathered, order, n, GPU_SPRITE_FLOATS, GPU_SPRITE_FLOATS);
  rewritePackedDepth(gathered, n, n + 1);

  const packed = new Float32Array(n * GPU_SPRITE_FLOATS);
  const packedU32 = new Uint32Array(packed.buffer);
  const ctx = makePackContext(q, { indices: order, indexCount: n, depthDenom: n }, n);
  packInstancedRows(q, ctx, packed, packedU32, GPU_SPRITE_FLOATS, n, false);
  assert.deepEqual(Array.from(gathered), Array.from(packed));
  assert.deepEqual(Array.from(order.subarray(0, n)), [1, 3, 2, 0]);
});

test('Y-band lists: one owner, no missing ids, concat covers the cull set', () => {
  const worldHeight = 1000;
  const nWorkers = 2;
  const ids = [7, 3, 9, 1, 5, 11, 4];
  const footY = [10, 100, 499, 500, 750, 999.9, 0];
  const bands = [[], []];
  for (let i = 0; i < ids.length; i++) {
    bands[yBandIndex(footY[i], worldHeight, nWorkers)].push(ids[i]);
  }
  const seen = new Set();
  for (const b of bands) {
    for (const id of b) {
      assert.equal(seen.has(id), false);
      seen.add(id);
    }
  }
  assert.equal(seen.size, ids.length);
  for (const id of ids) assert.equal(seen.has(id), true);
  assert.ok(bands[0].length > 0 && bands[1].length > 0);
});

test('concat of per-band painters equals global painter when zIndex is 0', () => {
  const worldHeight = 800;
  const nWorkers = 2;
  const n = 16;
  const ys = new Float32Array(n);
  const sortKey = new Float32Array(n);
  const band = zSortBand(worldHeight);
  for (let i = 0; i < n; i++) {
    ys[i] = (i * 47) % worldHeight;
    sortKey[i] = orderSortKey(spriteYSortKey(ys[i], Y_SORT_K), 0, true, band);
  }
  const keysU32 = keysU32Of(sortKey);
  const idxAll = new Uint32Array(n);
  for (let i = 0; i < n; i++) idxAll[i] = i;
  const global = createPainterState(n);
  const globalOrder = Array.from(orderPainterSlots(global, idxAll, n, keysU32).subarray(0, n));

  const lists = [[], []];
  for (let i = 0; i < n; i++) lists[yBandIndex(ys[i], worldHeight, nWorkers)].push(i);
  const concat = [];
  for (let b = 0; b < nWorkers; b++) {
    const local = new Uint32Array(lists[b]);
    const st = createPainterState(n);
    const ordered = orderPainterSlots(st, local, local.length, keysU32);
    for (let k = 0; k < local.length; k++) concat.push(ordered[k]);
  }
  assert.deepEqual(concat, globalOrder);
});

test('concat of per-band painters mismatches global when zIndex crosses bands', () => {
  const worldHeight = 800;
  const nWorkers = 2;
  const n = 4;
  const ys = new Float32Array([100, 700, 110, 710]);
  const zIndex = [1, 0, 1, 0];
  const sortKey = new Float32Array(n);
  const band = zSortBand(worldHeight);
  for (let i = 0; i < n; i++) {
    sortKey[i] = orderSortKey(spriteYSortKey(ys[i], Y_SORT_K), zIndex[i], true, band);
  }
  const keysU32 = keysU32Of(sortKey);
  const idxAll = new Uint32Array([0, 1, 2, 3]);
  const global = createPainterState(n);
  const globalOrder = Array.from(orderPainterSlots(global, idxAll, n, keysU32).subarray(0, n));

  const lists = [[], []];
  for (let i = 0; i < n; i++) lists[yBandIndex(ys[i], worldHeight, nWorkers)].push(i);
  const concat = [];
  for (let b = 0; b < nWorkers; b++) {
    const local = new Uint32Array(lists[b]);
    const st = createPainterState(n);
    const ordered = orderPainterSlots(st, local, local.length, keysU32);
    for (let k = 0; k < local.length; k++) concat.push(ordered[k]);
  }
  assert.notDeepEqual(concat, globalOrder);
});
