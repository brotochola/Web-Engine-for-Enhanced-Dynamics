// Loads the neighbor-publish module onto the scene's shared memory.
// Candidates and poses are already stored in that memory. The module writes
// neighbor rows in place. There is no result copy.

import { loadWasmKernel } from '../util/wasmKernel.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./spatialPublish.wasm', import.meta.url);

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
