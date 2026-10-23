// Every region of the shared WebAssembly.Memory objects that kernels run on (E-76 T9).
//
// Kernels own no memory (T6): no statics, no stack, no data segments. Everything a kernel reads or
// writes is a region declared here, with the worker role that writes it and its size. Regions are
// laid out in order, each starting on a 64-byte line, so a region one worker writes never shares
// a cache line with a region another worker writes. Inside a region, entities owned by different
// workers still interleave (each spatial worker writes the rows of the entities it owns).

export const WASM_PAGE_BYTES = 65536;
export const CACHE_LINE_BYTES = 64;

// Nothing lives at address 0: a kernel that writes through a zero offset lands in the guard, and a
// region offset of 0 never means "no region" by accident.
export const NULL_GUARD_BYTES = CACHE_LINE_BYTES;

export function alignToLine(bytes) {
  return Math.ceil(bytes / CACHE_LINE_BYTES) * CACHE_LINE_BYTES;
}

/**
 * Lay out `regions` in order from address 0, each on a cache line.
 * @param {Array<{ name: string, owner: string, bytes: number }>} regions
 * @returns {{ regions: Record<string, { byte: number, bytes: number, owner: string }>, bytes: number, pages: number }}
 */
export function layoutRegions(regions) {
  const out = {};
  let end = 0;
  for (const r of regions) {
    if (Object.hasOwn(out, r.name)) throw new Error(`wasm memory map: region ${r.name} declared twice`);
    if (!Number.isInteger(r.bytes) || r.bytes < 0) throw new Error(`wasm memory map: region ${r.name} has ${r.bytes} bytes`);
    const byte = alignToLine(end);
    out[r.name] = { byte, bytes: r.bytes, owner: r.owner };
    end = byte + r.bytes;
  }
  const bytes = alignToLine(end);
  return { regions: out, bytes, pages: Math.max(1, Math.ceil(bytes / WASM_PAGE_BYTES)) };
}

/**
 * The spatial publish memory (`spatialPublish.wasm`, created by spatialPublishMemory.js).
 * - pos: `[x, y, halfExtent, pad]` f32 per entity, written by the spatial worker that owns it.
 * - range: visual range f32 per entity, written by the same worker before its batch.
 * - rows: neighbour rows, `1 + maxNeighbors` ids per entity, written by `publish_batch` in each
 *   spatial worker for the entities it owns, read by logic.
 * - cand: candidate rows, same shape, written by the spatial gather.
 * - lists: one batch list per spatial worker, each its own `listStride`-byte slice on a line.
 * Ids are 16-bit: the module has no 32-bit form (W8).
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 */
export function spatialPublishRegions(entityCount, maxNeighbors, spatialWorkers) {
  const count = entityCount | 0;
  const workers = Math.max(1, spatialWorkers | 0);
  const rowBytes = count * (1 + (maxNeighbors | 0)) * 2;
  const listStride = alignToLine(count * 2);
  const layout = layoutRegions([
    { name: 'guard', owner: 'none', bytes: NULL_GUARD_BYTES },
    { name: 'pos', owner: 'spatial', bytes: count * 16 },
    { name: 'range', owner: 'spatial', bytes: count * 4 },
    { name: 'rows', owner: 'spatial (publish_batch)', bytes: rowBytes },
    { name: 'cand', owner: 'spatial', bytes: rowBytes },
    { name: 'lists', owner: 'spatial, one slice per worker', bytes: workers * listStride },
  ]);
  return { ...layout, listStride };
}
