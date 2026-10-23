// Loads the neighbor-publish module onto the scene's shared memory.
// Candidates and poses are already stored in that memory. The module writes
// neighbor rows in place. There is no result copy.

import { loadWasmKernel } from '../util/wasmKernel.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./spatialPublish.wasm', import.meta.url);
const gatherUrl = new URL('./spatialGather.wasm', import.meta.url);

/**
 * The WASM candidate gather (E-78) for spatial worker `workerIndex`: its kernel and its slices of
 * the publish memory. Writes the worker's circle patterns into the shared table (every spatial
 * worker writes the same bytes) and returns where the table's index starts.
 * @param {WebAssembly.Memory} memory
 * @param {{ markerByte: number, markerStride: number, truncatedByte: number, truncatedStride: number, rebuildByte: number, rebuildStride: number, orderByte: number, orderStride: number, patternByte: number, patternBytes: number }} layout
 * @param {number} workerIndex
 * @param {number} entityCount
 * @param {Int32Array[]} circlePatterns [dr, dc] pairs per radius, 0..maxCellRadius
 * @param {number} maxCellRadius
 */
export async function bindSpatialGather(memory, layout, workerIndex, entityCount, circlePatterns, maxCellRadius) {
  const { gather_batch: gather, order_batch_by_cell: order } = await loadWasmKernel('spatialGather', gatherUrl, memory, [
    'gather_batch',
    'order_batch_by_cell',
  ]);
  const count = entityCount | 0;
  const w = workerIndex | 0;
  const buffer = memory.buffer;
  // The table: every radius's pairs in turn, then [first pair, pair count] per radius, on its line.
  let pairs = 0;
  for (let r = 0; r <= maxCellRadius; r++) pairs += circlePatterns[r].length >> 1;
  const patternByte = layout.patternByte | 0;
  const patternIndexByte = patternByte + Math.ceil((pairs * 8) / 64) * 64;
  if (patternIndexByte + (maxCellRadius + 1) * 8 > patternByte + (layout.patternBytes | 0)) {
    throw new Error('spatial circle patterns exceed their region');
  }
  const table = new Int32Array(buffer, patternByte, pairs * 2);
  const index = new Int32Array(buffer, patternIndexByte, (maxCellRadius + 1) * 2);
  let at = 0;
  for (let r = 0; r <= maxCellRadius; r++) {
    const p = circlePatterns[r];
    index[r * 2] = at >> 1;
    index[r * 2 + 1] = p.length >> 1;
    table.set(p, at);
    at += p.length;
  }
  const markerByte = (layout.markerByte | 0) + w * (layout.markerStride | 0);
  const truncatedByte = (layout.truncatedByte | 0) + w * (layout.truncatedStride | 0);
  const rebuildByte = (layout.rebuildByte | 0) + w * (layout.rebuildStride | 0);
  const orderByte = (layout.orderByte | 0) + w * (layout.orderStride | 0);
  return {
    gather,
    // Without its scratch region the order kernel would write at byte 0: no ordering then.
    order: layout.orderByte ? order : null,
    marker: new Int32Array(buffer, markerByte, count),
    truncated: new Uint8Array(buffer, truncatedByte, count),
    rebuild: new Uint16Array(buffer, rebuildByte, count),
    markerByte,
    truncatedByte,
    rebuildByte,
    orderByte,
    patternByte,
    patternIndexByte,
  };
}

/**
 * @param {WebAssembly.Memory} memory
 * @param {{ posByte: number, rangeByte: number, neighborByte: number, candByte: number, listByte: number, listStride: number }} layout
 * @param {number} workerIndex
 * @param {number} entityCount
 * @param {number} maxNeighbors
 */
export async function bindSpatialPublish(memory, layout, workerIndex, entityCount, maxNeighbors) {
  const { publish_batch: publish } = await loadWasmKernel('spatialPublish', wasmUrl, memory, ['publish_batch']);
  const count = entityCount | 0;
  const stride = 1 + (maxNeighbors | 0);
  // Each spatial worker's batch list is its own slice, on its own cache lines.
  const listByte = (layout.listByte | 0) + (workerIndex | 0) * (layout.listStride | 0);
  const buffer = memory.buffer;
  const pub = {
    range: new Float32Array(buffer, layout.rangeByte, count),
    list: new Uint16Array(buffer, listByte, count),
    cand: new Uint16Array(buffer, layout.candByte, count * stride),
    publish,
    listByte,
    queued: 0,
  };
  return pub;
}
