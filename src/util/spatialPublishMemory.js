// One shared WebAssembly.Memory for neighbor rows, latched poses, and candidate lists, and, with a
// grid spec, the grid cells and the per-worker state of the WASM candidate gather (E-78).
// The regions and their offsets come from the memory map (wasmMemoryMap.js); callers view them
// with those byte offsets. Entity ids of the scene's width: 16-bit, or 32-bit through the kernels' _u32 exports (W8b).

import { entityIdBytes } from './entityIdWidth.js';
import { createWasmMemory, spatialPatternTableBytes, spatialPublishRegions } from './wasmMemoryMap.js';

/** Largest circle-pattern radius, in cells, a spatial worker searches (visual ranges to ~1500 px at 128). */
export const SPATIAL_MAX_CELL_RADIUS = 12;

/**
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 * @param {{ totalCells: number, cellByteSize: number } | null} [grid] lays out the gather's regions too
 * @param {null | { memory: WebAssembly.Memory, baseByte: number }} [place] lay the regions in that memory from
 *   baseByte (Phase 4: the spatial part of Box2D's block) instead of making a memory of their own
 * @param {null | object} [aggregates] E-199: the scene's neighbour aggregates (resolveNeighborAggregates), whose
 *   regions are laid out after the rest; the result's `aggregates` is that spec with each region's byte
 * @returns {null | {
 *   memory: WebAssembly.Memory,
 *   buffer: SharedArrayBuffer,
 *   posByte: number,
 *   rangeByte: number,
 *   neighborByte: number,
 *   candByte: number,
 *   listByte: number,
 *   listStride: number,
 *   syncByte: number,
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
 *   aggregates: null | object,
 *   regions: Record<string, { byte: number, bytes: number, owner: string }>,
 * }}
 */
export function createSpatialPublishMemory(entityCount, maxNeighbors, spatialWorkers, grid = null, place = null, aggregates = null) {
  const layout = spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid, aggregates);
  if (!layout) return null;
  const gather = layout.gather;
  const base = place ? place.baseByte | 0 : 0;
  // Not in the block: the caller makes a memory of its own.
  if (place && ((base & 63) !== 0 || base + layout.bytes > place.memory.buffer.byteLength)) return null;
  // Every region's byte from the memory's start: the block's offset added when the regions sit in a block.
  const regions = {};
  for (const [name, region] of Object.entries(layout.regions)) regions[name] = base ? { ...region, byte: region.byte + base } : region;

  const memory = place
    ? place.memory
    : createWasmMemory(layout.pages, 'spatial publish memory', `(${entityCount} entities, maxNeighbors ${maxNeighbors})`,
      'lower spatial.maxNeighbors');
  return {
    memory,
    buffer: memory.buffer,
    posByte: regions.pos.byte,
    rangeByte: regions.range.byte,
    neighborByte: regions.rows.byte,
    candByte: regions.cand.byte,
    listByte: regions.lists.byte,
    listStride: layout.listStride,
    syncByte: regions.sync.byte,
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
    aggregates: aggregates ? neighborAggregateLayout(aggregates, regions, entityCount | 0) : null,
    regions,
  };
}

/**
 * E-199: the aggregates' spec with its regions' bytes, as the spatial workers write the table from it
 * (writeNeighborAggregateTable) and every worker views the columns (NeighborAggregates); 0 for an output no type asks
 * for. Structured-cloneable: it travels in gridMetadata.
 */
function neighborAggregateLayout(spec, regions, entityCount) {
  const at = (name) => (regions[name] ? regions[name].byte : 0);
  return {
    ...spec,
    entityCount,
    tableByte: at('aggTable'),
    classByte: at('aggClass'),
    separationXByte: at('aggSeparationX'),
    separationYByte: at('aggSeparationY'),
    separationCountByte: at('aggSeparationCount'),
    centroidXByte: at('aggCentroidX'),
    centroidYByte: at('aggCentroidY'),
    cohesionCountByte: at('aggCohesionCount'),
    averageVelocityXByte: at('aggAverageVelocityX'),
    averageVelocityYByte: at('aggAverageVelocityY'),
    nearestIndexByte: at('aggNearestIndex'),
    nearestDistanceSqByte: at('aggNearestDistanceSq'),
    nearestCountByte: at('aggNearestCount'),
  };
}

/** The regions' layout (spatialPublishRegions) for these counts, or null when the scene keeps plain buffers. */
function spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid, aggregates = null) {
  const idBytes = entityIdBytes();
  if (idBytes !== 2 && idBytes !== 4) return null;
  const count = entityCount | 0;
  const maxN = maxNeighbors | 0;
  if (count <= 0 || maxN < 0) return null;
  const gather = grid
    ? { gridBytes: (grid.totalCells | 0) * (grid.cellByteSize | 0), patternBytes: spatialPatternTableBytes(SPATIAL_MAX_CELL_RADIUS) }
    : null;
  return { ...spatialPublishRegions(count, maxN, spatialWorkers, gather, idBytes, aggregates), gather };
}

/** The bytes createSpatialPublishMemory's regions take, for a block reserved before the memory is made (Phase 4). */
export function spatialPublishMemoryBytes(entityCount, maxNeighbors, spatialWorkers, grid = null, aggregates = null) {
  const layout = spatialPublishLayout(entityCount, maxNeighbors, spatialWorkers, grid, aggregates);
  return layout ? layout.bytes : 0;
}
