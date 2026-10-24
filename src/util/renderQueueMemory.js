// The render-queue memory (E-76 W9): the render queue's and the GPU queue's two buffers each, as
// regions of one shared WebAssembly.Memory, with the pack kernel's scratch after them. Pre-render
// writes the queue and packs it there (gpuPack.wasm reads the rows where they were written); Pixi
// views both queues at the regions' byte offsets, as it views plain SharedArrayBuffers at 0.
// E-112 (W4a): with an emit spec it also holds the SpriteRenderer, ShadowCaster and DecorationComponent
// blocks and pre-render's emit state, so the emit kernel reads every column where the scene keeps it.

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
 * @param {null | { entities: number, spriteBytes: number, casterBytes: number, decorationBytes: number }} [emit]
 *   the emit's regions too (renderQueueMemoryRegions); a component with 0 bytes gets no block (byte -1)
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, any> }}
 */
export function createRenderQueueMemory(maxItems, queueBytes, gpuQueueBytes, emit = null) {
  const n = maxItems | 0;
  if (n <= 0) return null;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const map = renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit);
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
        emit: emit ? emitLayout(r, emit.entities | 0) : null,
      },
    };
  } catch {
    return null;
  }
}

/** Byte offsets of the emit's regions; -1 for a component block the scene does not have. */
function emitLayout(r, entities) {
  const block = (region) => (region.bytes > 0 ? region.byte : -1);
  return {
    entities,
    spriteRendererByte: block(r.spriteRenderer),
    shadowCasterByte: block(r.shadowCaster),
    decorationByte: block(r.decorations),
    frameByte: r.emitFrame.byte,
    accumByte: r.emitAccum.byte,
    lastTextureByte: r.emitLastTexture.byte,
    collectorTypeByte: r.emitCollectorType.byte,
    collectorIndexByte: r.emitCollectorIndex.byte,
    collectorYByte: r.emitCollectorY.byte,
    proxyByte: r.emitProxy.byte,
    frameCountByte: r.emitFrameCount.byte,
    frameStartByte: r.emitFrameStart.byte,
    frameWidthByte: r.emitFrameWidth.byte,
    frameHeightByte: r.emitFrameHeight.byte,
    endsByte: r.emitEnds.byte,
    warnsByte: r.emitWarns.byte,
    foreignByte: r.emitForeign.byte,
    resultsByte: r.emitResults.byte,
    tableByte: r.emitTable.byte,
  };
}
