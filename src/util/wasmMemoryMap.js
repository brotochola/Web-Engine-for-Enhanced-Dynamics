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
export function spatialPublishRegions(entityCount, maxNeighbors, spatialWorkers, gather = null) {
  const { regions, ...strides } = spatialPublishRegionList(entityCount, maxNeighbors, spatialWorkers, gather);
  return { ...layoutRegions(regions), ...strides };
}

/**
 * The render-queue memory (E-76 W9 `gpuPack.wasm`, created by renderQueueMemory.js): the queues
 * pre-render writes and Pixi reads, so the pack kernel reads the rows where pre-render wrote them.
 * - guard: nothing at address 0 (the kernel takes a type offset of 0 as "no type column");
 * - queueA, queueB: the render queue's two buffers (renderQueueLayout.js), odd and even frames;
 * - gpuA, gpuB: the GPU queue's two buffers (gpuQueueLayout.js), packed by pre-render, uploaded by Pixi;
 * - packIndices: the pack's index scratch, for index lists kept outside this memory (u32);
 * - packInverse: the scatter pack's inverse of the index list, one u32 per queue row (W9b);
 * - packTables: one column table per queue the pack reads (u32 byte offsets, gpuPackClient.js);
 * - packResults: the kernel's particle count (u32).
 * With `emit` (E-112, the emit kernel `preRenderEmit.wasm`), what pre-render's emit reads and writes:
 * - spriteRenderer, shadowCaster, decorations: those components' blocks (Component.initializeArrays at
 *   the region's byte, in every worker and on the main thread); 0 bytes when the scene has none;
 * - emitFrame, emitAccum: pre-render's animation frame (u16) and clock (f32) per entity;
 * - emitLastTexture: the texture each entity last drew (u16), pre-render writes it, Pixi reads it;
 * - emitCollectorType, emitCollectorIndex, emitCollectorY: the main collector's rows (u8, i32, f32);
 * - emitProxy, emitFrameCount, emitFrameStart, emitFrameWidth, emitFrameHeight: the texture metadata as
 *   flat tables, written when it arrives (i32 per sheet and state, i32 and u16 per animation and frame);
 * - emitEnds, emitWarns: [entity, value] u32 pairs the kernel hands back; emitForeign: the rows it
 *   leaves to the JS (u32); emitResults: its counts; emitTable: its column table (u32 byte offsets).
 * @param {number} queueBytes computeBufferSize(maxItems)
 * @param {number} gpuQueueBytes computeGpuQueueBufferSize(caps)
 * @param {number} maxItems the queue's rows
 * @param {number} tableBytes packTables' size
 * @param {null | { entities: number, spriteBytes: number, casterBytes: number, decorationBytes: number }} [emit]
 */
export function renderQueueMemoryRegions(queueBytes, gpuQueueBytes, maxItems, tableBytes, emit = null) {
  const n = maxItems | 0;
  const regions = [
    { name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES },
    { name: 'queueA', owner: 'pre-render writes; Pixi reads', bytes: queueBytes },
    { name: 'queueB', owner: 'pre-render writes; Pixi reads', bytes: queueBytes },
    { name: 'gpuA', owner: 'pre-render packs; Pixi uploads', bytes: gpuQueueBytes },
    { name: 'gpuB', owner: 'pre-render packs; Pixi uploads', bytes: gpuQueueBytes },
    { name: 'packIndices', owner: 'pre-render', bytes: n * 4 },
    { name: 'packInverse', owner: 'pre-render', bytes: n * 4 },
    { name: 'packTables', owner: 'pre-render', bytes: tableBytes },
    { name: 'packResults', owner: 'pre-render', bytes: 16 },
  ];
  if (emit) {
    const e = emit.entities | 0;
    regions.push(
      { name: 'spriteRenderer', owner: 'every worker (SpriteRenderer)', bytes: emit.spriteBytes | 0 },
      { name: 'shadowCaster', owner: 'every worker (ShadowCaster)', bytes: emit.casterBytes | 0 },
      { name: 'decorations', owner: 'every worker (DecorationComponent)', bytes: emit.decorationBytes | 0 },
      { name: 'emitFrame', owner: 'pre-render', bytes: e * 2 },
      { name: 'emitAccum', owner: 'pre-render', bytes: e * 4 },
      { name: 'emitLastTexture', owner: 'pre-render writes; Pixi reads', bytes: e * 2 },
      { name: 'emitCollectorType', owner: 'pre-render', bytes: n },
      { name: 'emitCollectorIndex', owner: 'pre-render', bytes: n * 4 },
      { name: 'emitCollectorY', owner: 'pre-render', bytes: n * 4 },
      { name: 'emitProxy', owner: 'pre-render', bytes: EMIT_PROXY_SHEETS * EMIT_PROXY_STATES * 4 },
      { name: 'emitFrameCount', owner: 'pre-render', bytes: EMIT_MAX_ANIMATIONS * 4 },
      { name: 'emitFrameStart', owner: 'pre-render', bytes: EMIT_MAX_ANIMATIONS * 4 },
      { name: 'emitFrameWidth', owner: 'pre-render', bytes: EMIT_MAX_FRAMES * 2 },
      { name: 'emitFrameHeight', owner: 'pre-render', bytes: EMIT_MAX_FRAMES * 2 },
      { name: 'emitEnds', owner: 'pre-render', bytes: n * 8 },
      { name: 'emitWarns', owner: 'pre-render', bytes: n * 8 },
      { name: 'emitForeign', owner: 'pre-render', bytes: n * 4 },
      { name: 'emitResults', owner: 'pre-render', bytes: 16 },
      { name: 'emitTable', owner: 'pre-render', bytes: EMIT_TABLE_SLOTS * 4 },
    );
  }
  return layoutRegions(regions);
}

/** The emit's texture tables (E-112): spritesheetId and animationState are u8, texture ids u16. */
export const EMIT_PROXY_SHEETS = 256;
export const EMIT_PROXY_STATES = 256;
export const EMIT_MAX_ANIMATIONS = 65536;
export const EMIT_MAX_FRAMES = 65536;
/** Room for the emit kernel's column table (preRenderEmitClient.js EMIT_SLOTS). */
export const EMIT_TABLE_SLOTS = 96;

/**
 * The particle memory (E-79 `particleIntegrate.wasm`, E-80 `particleLists.wasm`, created by
 * particleMemory.js). The ParticleComponent lays its columns out from byte 0 of its buffer in every
 * worker (Component.initializeArrays), so this memory starts with the component and has no guard:
 * the kernels take every column's offset from JS. After it:
 * - activeList, visibleList: the published lists, u16 [count, index …] with room for one index past
 *   the count; pre-render reads the visible one, Pixi the active one, and the integrate reads the
 *   active one's indices;
 * - stamp: stayOnTheFloor particles to stamp (u16);
 * - flat, heighted: the integrate's scratch lists (u16, 65 536 each);
 * - dead: the indices JS returns to the pool after the call, in order (u16);
 * - trig, trigAngle: particles whose angle needs Math.cos / Math.sin, and those angles (u16, f64);
 * - luts: the EXPO ease tables, copied from particleTween.js (f32);
 * - columns: one u32 byte offset per column the kernel reads; results: four i32.
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 * @param {number} lutFloats every EXPO table's entries together
 */
export function particleMemoryRegions(maxParticles, componentBytes, lutFloats) {
  const n = maxParticles | 0;
  return layoutRegions([
    { name: 'component', owner: 'every worker (the ParticleComponent views)', bytes: componentBytes },
    { name: 'activeList', owner: 'particle; Pixi reads', bytes: (n + 2) * 2 },
    { name: 'visibleList', owner: 'particle; pre-render reads', bytes: (n + 2) * 2 },
    { name: 'stamp', owner: 'particle', bytes: n * 2 },
    { name: 'flat', owner: 'particle', bytes: 65536 * 2 },
    { name: 'heighted', owner: 'particle', bytes: 65536 * 2 },
    { name: 'dead', owner: 'particle', bytes: n * 2 },
    { name: 'trig', owner: 'particle', bytes: n * 2 },
    { name: 'trigAngle', owner: 'particle', bytes: n * 8 },
    { name: 'luts', owner: 'particle, read only', bytes: lutFloats * 4 },
    { name: 'columns', owner: 'particle, read only', bytes: CACHE_LINE_BYTES * 4 },
    { name: 'results', owner: 'particle', bytes: 16 },
  ]);
}

/**
 * Bytes the circle-pattern table may take: i32 [dr, dc] pairs for every radius up to
 * `maxCellRadius`, then i32 [first pair, pair count] per radius. A pattern of radius r fits in
 * the (2r + 3)² cells around its centre, so this bounds what the spatial workers write.
 */
export function spatialPatternTableBytes(maxCellRadius) {
  let cells = 0;
  for (let r = 0; r <= maxCellRadius; r++) cells += (2 * r + 3) * (2 * r + 3);
  return alignToLine(cells * 8) + alignToLine((maxCellRadius + 1) * 8);
}

/**
 * The same regions as a list, for a layout that appends more (the coexistence test).
 * With `gather` ({ gridBytes, patternBytes }), the regions of the WASM candidate gather (E-78)
 * follow the publish's:
 * - grid: the spatial grid cells (u8 count at each cell's first byte, entity ids after), each
 *   spatial worker writing its own rows, every worker reading;
 * - markers: one i32-per-entity dedup slice per spatial worker (its processedMarker);
 * - truncated: one u8-per-entity slice per spatial worker (its truncation flags);
 * - rebuilds: one u16 list slice per spatial worker (the entities whose lists rebuild this frame);
 * - patterns: the circle-pattern table, the same in every worker (spatialPatternTableBytes).
 */
export function spatialPublishRegionList(entityCount, maxNeighbors, spatialWorkers, gather = null) {
  const count = entityCount | 0;
  const workers = Math.max(1, spatialWorkers | 0);
  const rowBytes = count * (1 + (maxNeighbors | 0)) * 2;
  const listStride = alignToLine(count * 2);
  const regions = [
    { name: 'guard', owner: 'none', bytes: NULL_GUARD_BYTES },
    { name: 'pos', owner: 'spatial', bytes: count * 16 },
    { name: 'range', owner: 'spatial', bytes: count * 4 },
    { name: 'rows', owner: 'spatial (publish_batch)', bytes: rowBytes },
    { name: 'cand', owner: 'spatial', bytes: rowBytes },
    { name: 'lists', owner: 'spatial, one slice per worker', bytes: workers * listStride },
  ];
  if (!gather) return { regions, listStride };
  const markerStride = alignToLine(count * 4);
  const truncatedStride = alignToLine(count);
  const rebuildStride = alignToLine(count * 2);
  // order_batch_by_cell: a u32 histogram[256], then three u16 lists of the entity count.
  const orderStride = alignToLine(1024 + count * 6);
  regions.push(
    { name: 'grid', owner: 'spatial, each worker its own rows', bytes: gather.gridBytes },
    { name: 'markers', owner: 'spatial, one slice per worker', bytes: workers * markerStride },
    { name: 'truncated', owner: 'spatial, one slice per worker', bytes: workers * truncatedStride },
    { name: 'rebuilds', owner: 'spatial, one slice per worker', bytes: workers * rebuildStride },
    { name: 'patterns', owner: 'spatial, identical in every worker', bytes: gather.patternBytes },
    { name: 'orders', owner: 'spatial, one slice per worker', bytes: workers * orderStride },
  );
  return { regions, listStride, markerStride, truncatedStride, rebuildStride, orderStride };
}
