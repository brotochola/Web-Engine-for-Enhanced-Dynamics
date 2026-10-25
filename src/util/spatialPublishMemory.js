// One shared WebAssembly.Memory for neighbor rows, latched poses, and candidate lists, and, with a
// grid spec, the grid cells and the per-worker state of the WASM candidate gather (E-78).
// The regions and their offsets come from the memory map (wasmMemoryMap.js); callers view them
// with those byte offsets. Entity ids of the scene's width: 16-bit, or 32-bit through the kernels' _u32 exports (W8b).

import { entityIdBytes } from './entityIdWidth.js';
import { spatialPatternTableBytes, spatialPublishRegions } from './wasmMemoryMap.js';

// The modules' import accepts up to 32768 pages (2 GB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 32768;

/** Largest circle-pattern radius, in cells, a spatial worker searches (visual ranges to ~1500 px at 128). */
export const SPATIAL_MAX_CELL_RADIUS = 12;

/**
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 * @param {{ totalCells: number, cellByteSize: number } | null} [grid] lays out the gather's regions too
 * @param {null | { memory: WebAssembly.Memory, baseByte: number }} [place] lay the regions in that memory from
 *   baseByte (Phase 4: the spatial part of Box2D's block) instead of making a memory of their own
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
export function createSpatialPublishMemory(entityCount, maxNeighbors, spatialWorkers, grid = null, place = null) {
  const layout = spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid);
  if (!layout) return null;
  const gather = layout.gather;
  const base = place ? place.baseByte | 0 : 0;
  if (place) {
    // Not in the block: the caller makes a memory of its own.
    if ((base & 63) !== 0 || base + layout.bytes > place.memory.buffer.byteLength) return null;
  } else if (layout.pages > WASM_MAX_PAGES) {
    throw new Error(
      `spatial publish memory: ${Math.ceil(layout.pages / 16)} MB (${entityCount} entities, maxNeighbors ${maxNeighbors}) is past the ` +
        `${WASM_MAX_PAGES / 16} MB a kernel memory can take; lower spatial.maxNeighbors`,
    );
  }
  // Every region's byte from the memory's start: the block's offset added when the regions sit in a block.
  const regions = {};
  for (const [name, region] of Object.entries(layout.regions)) regions[name] = base ? { ...region, byte: region.byte + base } : region;

  try {
    const memory = place ? place.memory : new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
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
  } catch (err) {
    if (place) return null;
    throw new Error(`spatial publish memory: the browser would not make ${Math.ceil(layout.pages / 16)} MB (${err?.message ?? err})`, { cause: err });
  }
}

/** The regions' layout (spatialPublishRegions) for these counts, or null when the scene keeps plain buffers. */
function spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid) {
  const idBytes = entityIdBytes();
  if (idBytes !== 2 && idBytes !== 4) return null;
  const count = entityCount | 0;
  const maxN = maxNeighbors | 0;
  if (count <= 0 || maxN < 0) return null;
  const gather = grid
    ? { gridBytes: (grid.totalCells | 0) * (grid.cellByteSize | 0), patternBytes: spatialPatternTableBytes(SPATIAL_MAX_CELL_RADIUS) }
    : null;
  return { ...spatialPublishRegions(count, maxN, spatialWorkers, gather, idBytes), gather };
}

/** The bytes createSpatialPublishMemory's regions take, for a block reserved before the memory is made (Phase 4). */
export function spatialPublishMemoryBytes(entityCount, maxNeighbors, spatialWorkers, grid = null) {
  const layout = spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid);
  return layout ? layout.bytes : 0;
}
