// One shared WebAssembly.Memory for neighbor rows, latched poses, and candidate lists, and, with a
// grid spec, the grid cells and the per-worker state of the WASM candidate gather (E-78).
// The regions and their offsets come from the memory map (wasmMemoryMap.js); callers view them
// with those byte offsets. Uint16 entity ids only. Wider ids keep the plain SharedArrayBuffers.

import { entityIdBytes } from './entityIdWidth.js';
import { spatialPatternTableBytes, spatialPublishRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/** Largest circle-pattern radius, in cells, a spatial worker searches (visual ranges to ~1500 px at 128). */
export const SPATIAL_MAX_CELL_RADIUS = 12;

/**
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 * @param {{ totalCells: number, cellByteSize: number } | null} [grid] lays out the gather's regions too
 * @returns {null | {
 *   memory: WebAssembly.Memory,
 *   buffer: SharedArrayBuffer,
 *   posByte: number,
 *   rangeByte: number,
 *   neighborByte: number,
 *   candByte: number,
 *   listByte: number,
 *   listStride: number,
 *   gridByte: number,
 *   markerByte: number,
 *   markerStride: number,
 *   truncatedByte: number,
 *   truncatedStride: number,
 *   rebuildByte: number,
 *   rebuildStride: number,
 *   orderByte: number,
 *   orderStride: number,
 *   patternByte: number,
 *   patternBytes: number,
 *   regions: Record<string, { byte: number, bytes: number, owner: string }>,
 * }}
 */
export function createSpatialPublishMemory(entityCount, maxNeighbors, spatialWorkers, grid = null) {
  if (entityIdBytes() !== 2) return null;
  const count = entityCount | 0;
  const maxN = maxNeighbors | 0;
  if (count <= 0 || maxN < 0) return null;
  const gather = grid
    ? { gridBytes: (grid.totalCells | 0) * (grid.cellByteSize | 0), patternBytes: spatialPatternTableBytes(SPATIAL_MAX_CELL_RADIUS) }
    : null;
  const layout = spatialPublishRegions(count, maxN, spatialWorkers, gather);
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
      // 0 without a grid spec: no gather regions.
      gridByte: gather ? regions.grid.byte : 0,
      markerByte: gather ? regions.markers.byte : 0,
      markerStride: gather ? layout.markerStride : 0,
      truncatedByte: gather ? regions.truncated.byte : 0,
      truncatedStride: gather ? layout.truncatedStride : 0,
      rebuildByte: gather ? regions.rebuilds.byte : 0,
      rebuildStride: gather ? layout.rebuildStride : 0,
      orderByte: gather ? regions.orders.byte : 0,
      orderStride: gather ? layout.orderStride : 0,
      patternByte: gather ? regions.patterns.byte : 0,
      patternBytes: gather ? regions.patterns.bytes : 0,
      regions,
    };
  } catch {
    return null;
  }
}
