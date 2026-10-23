// One shared WebAssembly.Memory for neighbor rows, latched poses, and candidate lists.
// The regions and their offsets come from the memory map (wasmMemoryMap.js); callers view them
// with those byte offsets. Uint16 entity ids only. Wider ids keep the plain SharedArrayBuffers.

import { entityIdBytes } from './entityIdWidth.js';
import { spatialPublishRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/**
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 * @returns {null | {
 *   memory: WebAssembly.Memory,
 *   buffer: SharedArrayBuffer,
 *   posByte: number,
 *   rangeByte: number,
 *   neighborByte: number,
 *   candByte: number,
 *   listByte: number,
 *   listStride: number,
 *   regions: Record<string, { byte: number, bytes: number, owner: string }>,
 * }}
 */
export function createSpatialPublishMemory(entityCount, maxNeighbors, spatialWorkers) {
  if (entityIdBytes() !== 2) return null;
  const count = entityCount | 0;
  const maxN = maxNeighbors | 0;
  if (count <= 0 || maxN < 0) return null;
  const layout = spatialPublishRegions(count, maxN, spatialWorkers);
  if (layout.pages > WASM_MAX_PAGES) return null;
  const { regions } = layout;

  try {
    const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
    return {
      memory,
      buffer: memory.buffer,
      posByte: regions.pos.byte,
      rangeByte: regions.range.byte,
      neighborByte: regions.rows.byte,
      candByte: regions.cand.byte,
      listByte: regions.lists.byte,
      listStride: layout.listStride,
      regions,
    };
  } catch {
    return null;
  }
}
