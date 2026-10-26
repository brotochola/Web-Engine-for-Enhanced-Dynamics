// Loads the neighbor-publish module onto the scene's shared memory.
// Candidates and poses are already stored in that memory. The module writes
// neighbor rows in place. There is no result copy.

import { EntityIdArray, entityIdBytes } from '../util/entityIdWidth.js';
import { loadWasmKernel } from '../util/wasmKernel.js';
import { engineWasmUrl } from '../wasm/engine.js';


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
  // W8b: the _u32 exports for 32-bit entity ids (the lists, candidate rows and grid cells hold ids of that width).
  const wide = entityIdBytes() === 4;
  const names = wide ? ['gather_batch_u32', 'order_batch_by_cell_u32'] : ['gather_batch', 'order_batch_by_cell'];
  const k = await loadWasmKernel('spatialGather', engineWasmUrl, memory, names);
  const gather = k[names[0]];
  const order = k[names[1]];
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
    rebuild: new (EntityIdArray())(buffer, rebuildByte, count),
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
  // W8b: publish_batch_u32 for 32-bit entity ids.
  const name = entityIdBytes() === 4 ? 'publish_batch_u32' : 'publish_batch';
  const publish = (await loadWasmKernel('spatialPublish', engineWasmUrl, memory, [name]))[name];
  const count = entityCount | 0;
  const stride = 1 + (maxNeighbors | 0);
  // Each spatial worker's batch list is its own slice, on its own cache lines.
  const listByte = (layout.listByte | 0) + (workerIndex | 0) * (layout.listStride | 0);
  const buffer = memory.buffer;
  const pub = {
    range: new Float32Array(buffer, layout.rangeByte, count),
    list: new (EntityIdArray())(buffer, listByte, count),
    cand: new (EntityIdArray())(buffer, layout.candByte, count * stride),
    publish,
    listByte,
    queued: 0,
  };
  return pub;
}
