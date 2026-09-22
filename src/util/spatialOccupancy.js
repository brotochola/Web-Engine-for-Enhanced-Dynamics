// Worker-local grid occupancy. Each spatial worker stores only the cells it owns.
// A shared cell list would race: one body can span rows owned by different workers.
//
// OCC_FAT means the span did not fit in OCC_SPAN. The caller reinserts that entity
// by a full owned-row scan, or falls back to a full rebuild.

export const OCC_SPAN = 8;
export const OCC_FAT = 255;
/** Entity's cells are owned by another worker. Not a span. */
export const OCC_OTHER = 254;

/**
 * Dirty fraction at or above this uses a full row rebuild.
 * The kernel times 0%, 5%, and 100% movers and this stays where 5% wins and 100% does not.
 */
export const INCREMENTAL_DIRTY_FRACTION = 0.35;

export function removeEntityFromCell(grid, cell, entity) {
  const counts = grid.counts;
  const entities = grid.entities;
  const byteOffset = cell * grid.cellByteSize;
  const count = counts[byteOffset] | 0;
  if (count <= 0) return false;
  const base = cell * grid.cellIdStride + grid.headerIds;
  for (let k = 0; k < count; k++) {
    if ((entities[base + k] | 0) !== entity) continue;
    const last = count - 1;
    entities[base + k] = entities[base + last];
    counts[byteOffset] = last;
    return true;
  }
  return false;
}

export function insertEntityInCell(grid, cell, entity) {
  const counts = grid.counts;
  const byteOffset = cell * grid.cellByteSize;
  const count = counts[byteOffset] | 0;
  if (count >= grid.maxPerCell) return false;
  const base = cell * grid.cellIdStride + grid.headerIds;
  grid.entities[base + count] = entity;
  counts[byteOffset] = count + 1;
  return true;
}

/** Drop this worker's cells for one entity. Fat entities are not stored; return false. */
export function vacateEntity(grid, occCount, occCells, entity) {
  const n = occCount[entity] | 0;
  if (n === 0 || n === OCC_FAT || n === OCC_OTHER) {
    if (n === OCC_OTHER) occCount[entity] = 0;
    return n !== OCC_FAT;
  }
  const base = entity * OCC_SPAN;
  for (let s = 0; s < n; s++) {
    removeEntityFromCell(grid, occCells[base + s] | 0, entity);
  }
  occCount[entity] = 0;
  return true;
}

/**
 * Insert into owned rows. Returns false and marks OCC_FAT when the span
 * does not fit (any cells inserted in this call are removed again).
 */
export function occupyEntity(
  grid,
  occCount,
  occCells,
  entity,
  minCol,
  maxCol,
  minRow,
  maxRow,
  rowOwnership,
  workerId,
) {
  let span = 0;
  const base = entity * OCC_SPAN;
  const gridWidth = grid.gridWidth;
  for (let row = minRow; row <= maxRow; row++) {
    if (rowOwnership[row] !== workerId) continue;
    const rowBase = row * gridWidth;
    for (let col = minCol; col <= maxCol; col++) {
      if (span >= OCC_SPAN) {
        for (let s = 0; s < span; s++) {
          removeEntityFromCell(grid, occCells[base + s] | 0, entity);
        }
        occCount[entity] = OCC_FAT;
        return false;
      }
      const cell = rowBase + col;
      if (!insertEntityInCell(grid, cell, entity)) continue;
      occCells[base + span] = cell;
      span++;
    }
  }
  occCount[entity] = span;
  return true;
}

/** FNV-1a of sorted entity ids per cell. Order inside a cell does not matter. */
export function membershipChecksum(grid) {
  const cells = grid.gridWidth * grid.gridHeight;
  let scratch = membershipChecksum._scratch;
  let h = 2166136261 >>> 0;
  for (let c = 0; c < cells; c++) {
    const count = grid.counts[c * grid.cellByteSize] | 0;
    h ^= count;
    h = Math.imul(h, 16777619) >>> 0;
    if (count <= 0) continue;
    if (!scratch || scratch.length < count) {
      scratch = membershipChecksum._scratch = new Uint32Array(count);
    }
    const base = c * grid.cellIdStride + grid.headerIds;
    const n = count;
    for (let k = 0; k < n; k++) scratch[k] = grid.entities[base + k] >>> 0;
    scratch.subarray(0, n).sort();
    for (let k = 0; k < n; k++) {
      h ^= scratch[k];
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

export function clearGrid(grid) {
  const cells = grid.gridWidth * grid.gridHeight;
  for (let c = 0; c < cells; c++) grid.counts[c * grid.cellByteSize] = 0;
}

/**
 * Stamp cells within `radius` of each dirty cell.
 * `affectedIds` collects newly stamped cells so the caller can clear them.
 * Returns the new length of that list.
 */
export function stampAffected(cellAffected, affectedIds, affectedCount, gridWidth, gridHeight, dirtyCells, dirtyCount, radius) {
  const r = radius | 0;
  let n = affectedCount | 0;
  for (let d = 0; d < dirtyCount; d++) {
    const cell = dirtyCells[d] | 0;
    const col0 = cell % gridWidth;
    const row0 = (cell / gridWidth) | 0;
    const minC = col0 - r < 0 ? 0 : col0 - r;
    const maxC = col0 + r >= gridWidth ? gridWidth - 1 : col0 + r;
    const minR = row0 - r < 0 ? 0 : row0 - r;
    const maxR = row0 + r >= gridHeight ? gridHeight - 1 : row0 + r;
    for (let row = minR; row <= maxR; row++) {
      const rowBase = row * gridWidth;
      for (let col = minC; col <= maxC; col++) {
        const idx = rowBase + col;
        if (cellAffected[idx]) continue;
        cellAffected[idx] = 1;
        affectedIds[n++] = idx;
      }
    }
  }
  return n;
}
