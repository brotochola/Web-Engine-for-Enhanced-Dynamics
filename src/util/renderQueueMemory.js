// The render-queue memory (E-76 W9): the render queue's and the GPU queue's two buffers each, as
// regions of one shared WebAssembly.Memory, with the pack kernel's scratch after them. Pre-render
// writes the queue and packs it there (gpuPack.wasm reads the rows where they were written); Pixi
// views both queues at the regions' byte offsets, as it views plain SharedArrayBuffers at 0.

import { renderQueueMemoryRegions } from './wasmMemoryMap.js';
import { GPU_PACK_COLUMNS } from '../render/gpuPackClient.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/** Column tables the pack keeps: the two queue buffers, with room to spare. */
export const GPU_PACK_TABLE_SLOTS = 4;

/**
 * @param {number} maxItems the render queue's rows
 * @param {number} queueBytes computeBufferSize(maxItems)
 * @param {number} gpuQueueBytes computeGpuQueueBufferSize(caps)
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }}
 */
export function createRenderQueueMemory(maxItems, queueBytes, gpuQueueBytes) {
  const n = maxItems | 0;
  if (n <= 0) return null;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const map = renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes);
  if (map.pages > WASM_MAX_PAGES) return null;
  const r = map.regions;
  try {
    const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
    return {
      memory,
      buffer: memory.buffer,
      // Plain numbers, so the layout posts to workers as it is.
      layout: {
        queueAByte: r.queueA.byte,
        queueBByte: r.queueB.byte,
        gpuAByte: r.gpuA.byte,
        gpuBByte: r.gpuB.byte,
        indexByte: r.packIndices.byte,
        indexCap: n,
        inverseByte: r.packInverse.byte,
        tableByte: r.packTables.byte,
        tableSlots: GPU_PACK_TABLE_SLOTS,
        particlesByte: r.packResults.byte,
      },
    };
  } catch {
    return null;
  }
}
