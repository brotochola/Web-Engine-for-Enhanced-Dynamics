// Every region of the shared WebAssembly.Memory objects that kernels run on (E-76 T9).
//
// Kernels own no memory (T6): no statics, no stack, no data segments. Everything a kernel reads or
// writes is a region declared here, with the worker role that writes it and its size. Regions are
// laid out in order, each starting on a 64-byte line, so a region one worker writes never shares
// a cache line with a region another worker writes. Inside a region, entities owned by different
// workers still interleave (each spatial worker writes the rows of the entities it owns).

import { poolSlotBytes } from './poolSlotWidth.js';

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
export function spatialPublishRegions(entityCount, maxNeighbors, spatialWorkers, gather = null, idBytes = 2) {
  const { regions, ...strides } = spatialPublishRegionList(entityCount, maxNeighbors, spatialWorkers, gather, idBytes);
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
 *   leaves to the JS ([collector row, queue row] u32 pairs: rows after an Adobe root move down, W27);
 *   emitResults: its counts; emitTable: its column table (u32 byte offsets);
 * - emitPersistType, emitPersistEntity, emitPersistFrame, emitPersistAnim: the rows each queue buffer last
 *   held, for the persist check (W4c; u8, i32, u16, u16, the two buffers back to back).
 * With `emit.adobe` (W27, the Adobe Animate emit in the same kernel), what it reads besides:
 * - adobeAnim: the AdobeAnimComponent block (Component.initializeArrays at the region's byte, as above);
 * - emitStashX, emitStashY, emitStashRotC, emitStashRotS: the collector's pose stash (f32 per row), where the
 *   collect writes the poses when a frame has Adobe roots (the queue's own columns otherwise, E-98d);
 * - emitAdobeList: the frame's active Adobe entities, copied from their query for the clock advance (u32);
 * - emitAdobeAssets: the Adobe assets' tables, a directory of EMIT_ADOBE_MAX_ASSETS records
 *   (EMIT_ADOBE_ASSET_BYTES each, preRenderEmitClient.js writes them) and the clip, frame and piece arrays
 *   after it (`emit.adobe.tableBytes`, preRender.adobeTablesMB); an asset that does not fit is not drawn (one error).
 * With `stamp` (E-114, the shadow stamp `shadowStamp.wasm`, which reads the sun rows and writes the stamp
 * rows where the GPU queues hold them), its scratch: the candidates, their distances, order and the kept
 * list (one entry per sun caster each), the stamp grid's counts, starts and items, the nearest lights per
 * caster (maxShadowsPerEntity slots each), the light table (five doubles a light) and its column table.
 * With `sway` (W22, the decoration sway `decorationSway.wasm`, which the particle worker runs on the
 * decorations block above), the particle worker's sway arrays: the frame's active snapshot (u16), the
 * phase tables (f32 per decoration), this frame's sin and cos per bucket (f32), the bucket cache (u16
 * bucket, f32 frequency per decoration), the kernel's chunk list (u16), its trig list (u32 entries, f64
 * values, one per decoration at most) and its column table. E-129: past 65 535 decorations the snapshot and
 * the chunk list are u32 (poolSlotBytes); the bucket cache holds bucket ids and stays u16.
 * @param {number} queueBytes computeBufferSize(maxItems)
 * @param {number} gpuQueueBytes computeGpuQueueBufferSize(caps)
 * @param {number} maxItems the queue's rows
 * @param {number} tableBytes packTables' size
 * @param {null | { entities: number, spriteBytes: number, casterBytes: number, decorationBytes: number,
 *   adobe?: null | { animBytes: number, tableBytes: number } }} [emit]
 * @param {null | { maxSun: number, maxPerEntity: number, maxLights: number }} [stamp]
 * @param {null | { decorations: number, buckets: number }} [sway]
 * @param {number} [pixiRows] rows of Pixi's plain sprite batch when Pixi packs it with gpuPack.wasm (W9d), else 0
 * @param {null | { entities: number, transformBytes: number, colliderBytes: number }} [collect] the sprite collect's
 *   blocks (W4b, a scene without physics); a component with 0 bytes gets no block
 * @param {null | { preRender: boolean, pixi: boolean }} [painter] the painter sort's state (W10
 *   `painterRadix.wasm`) for each worker that sorts the main queue, one set each (painterStateRegions):
 *   `preRenderPainter*` owned by pre-render, `pixiPainter*` by Pixi, so the kernel reads the sort keys where
 *   pre-render wrote them and the two never share a state
 */
export function renderQueueMemoryRegions(queueBytes, gpuQueueBytes, maxItems, tableBytes, emit = null, stamp = null, sway = null, pixiRows = 0, collect = null, painter = null, pixiFloats = 15, pixiExtra = null) {
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
    // The pack's results, then (16 bytes in) the slow path's parameters: 16 doubles (gpuPackClient.js).
    { name: 'packResults', owner: 'pre-render', bytes: 144 },
  ];
  if (emit) {
    const e = emit.entities | 0;
    regions.push(
      { name: 'spriteRenderer', owner: 'every worker (SpriteRenderer)', bytes: emit.spriteBytes | 0 },
      { name: 'shadowCaster', owner: 'every worker (ShadowCaster)', bytes: emit.casterBytes | 0 },
      { name: 'decorations', owner: 'every worker (DecorationComponent)', bytes: emit.decorationBytes | 0 },
      { name: 'lightEmitter', owner: 'every worker (LightEmitter)', bytes: emit.lightBytes | 0 },
      // BulletComponent when the bullet tick's regions (W19, with the collect's) do not hold it.
      { name: 'emitBullets', owner: 'every worker (BulletComponent)', bytes: emit.bulletBytes | 0 },
      // The particle memory's regions (particleMemory.js, laid out there): ParticleComponent, its lists and the
      // particle kernels' scratch, so the emit kernel reads the particles where the particle worker writes them.
      { name: 'particleMemory', owner: 'particle (particleMemory.js); every worker reads', bytes: emit.particleBytes | 0 },
      // The LiquidFun render buffer (liquidFunRender.js; physics writes it) and pre-render's previous positions of
      // its particles (_prevLfX, _prevLfY), so the emit kernel writes the LiquidFun rows.
      { name: 'liquidFunRender', owner: 'physics writes; pre-render reads (liquidFunRender.js)', bytes: emit.liquidFun ? emit.liquidFun.renderBytes | 0 : 0 },
      { name: 'emitLfPrev', owner: 'pre-render', bytes: emit.liquidFun ? (emit.liquidFun.maxCount | 0) * 8 : 0 },
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
      { name: 'emitForeign', owner: 'pre-render', bytes: n * 8 },
      { name: 'emitResults', owner: 'pre-render', bytes: 32 },
      { name: 'emitTable', owner: 'pre-render', bytes: EMIT_TABLE_SLOTS * 4 },
      // The emit's doubles (preRenderEmit.c E_PARAMS): the zenithal particles' height terms.
      { name: 'emitParams', owner: 'pre-render', bytes: EMIT_PARAM_DOUBLES * 8 },
      // E-138: the presort's keys (f32) and order (u32), which pre-render's painter kernel sorts.
      { name: 'emitPresortKeys', owner: 'pre-render', bytes: n * 4 },
      { name: 'emitPresortOrder', owner: 'pre-render', bytes: n * 4 },
      { name: 'emitPersistType', owner: 'pre-render', bytes: 2 * n },
      { name: 'emitPersistEntity', owner: 'pre-render', bytes: 2 * n * 4 },
      { name: 'emitPersistFrame', owner: 'pre-render', bytes: 2 * n * 2 },
      { name: 'emitPersistAnim', owner: 'pre-render', bytes: 2 * n * 2 },
    );
    // Each custom sprite layer's two queue buffers (pre-render writes, Pixi reads) and its collector: y and index
    // (u32 each), the pose stash x, y, rotC, rotS (f32 each), then type (u8) per row: CUSTOM_COLLECTOR_ROW_BYTES.
    const layers = emit.customLayers || [];
    for (let k = 0; k < layers.length; k++) {
      const c = layers[k];
      regions.push(
        { name: `customQueueA${k}`, owner: 'pre-render writes; Pixi reads', bytes: c.queueBytes | 0 },
        { name: `customQueueB${k}`, owner: 'pre-render writes; Pixi reads', bytes: c.queueBytes | 0 },
        { name: `customCollector${k}`, owner: 'pre-render', bytes: (c.maxItems | 0) * CUSTOM_COLLECTOR_ROW_BYTES },
        // The rows Pixi packs the layer into (15 floats each) before it copies them out for the upload.
        { name: `customRows${k}`, owner: 'Pixi packs', bytes: (c.maxItems | 0) * 15 * 4 },
      );
      // A y-sorted layer's painter state, where painterRadix.wasm sorts the keys pre-render writes in its queues.
      if (c.ySort) regions.push(...painterStateRegions(`customPainter${k}`, c.maxItems | 0, 'Pixi (the layer\'s painter sort)'));
    }
    if (emit.adobe) {
      regions.push(
        { name: 'adobeAnim', owner: 'every worker (AdobeAnimComponent)', bytes: emit.adobe.animBytes | 0 },
        { name: 'emitStashX', owner: 'pre-render', bytes: n * 4 },
        { name: 'emitStashY', owner: 'pre-render', bytes: n * 4 },
        { name: 'emitStashRotC', owner: 'pre-render', bytes: n * 4 },
        { name: 'emitStashRotS', owner: 'pre-render', bytes: n * 4 },
        { name: 'emitAdobeList', owner: 'pre-render', bytes: e * 4 },
        { name: 'emitAdobeAssets', owner: 'pre-render', bytes: EMIT_ADOBE_MAX_ASSETS * EMIT_ADOBE_ASSET_BYTES + (emit.adobe.tableBytes | 0) },
      );
    }
  }
  if (stamp) {
    const sun = stamp.maxSun | 0;
    const near = sun * (stamp.maxPerEntity | 0);
    regions.push(
      { name: 'stampTmpIdx', owner: 'pre-render', bytes: sun * 4 },
      { name: 'stampDist', owner: 'pre-render', bytes: sun * 4 },
      { name: 'stampOrder', owner: 'pre-render', bytes: sun * 4 },
      { name: 'stampKeep', owner: 'pre-render', bytes: sun * 4 },
      { name: 'stampGridCounts', owner: 'pre-render', bytes: STAMP_GRID_CELLS * 4 },
      { name: 'stampGridStarts', owner: 'pre-render', bytes: (STAMP_GRID_CELLS + 1) * 4 },
      { name: 'stampGridItems', owner: 'pre-render', bytes: sun * 4 },
      { name: 'stampNearDist', owner: 'pre-render', bytes: near * 4 },
      { name: 'stampNearSlot', owner: 'pre-render', bytes: near * 4 },
      { name: 'stampNearCount', owner: 'pre-render', bytes: sun },
      { name: 'stampLights', owner: 'pre-render', bytes: (stamp.maxLights | 0) * STAMP_LIGHT_DOUBLES * 8 },
      { name: 'stampTable', owner: 'pre-render', bytes: STAMP_TABLE_SLOTS * 4 },
      // The light cookies' queue, the render queue's layout at maxCookie rows (renderQueueLayout.js).
      { name: 'cookieQueue', owner: 'pre-render', bytes: stamp.cookieBytes | 0 },
    );
  }
  if (sway) {
    const d = sway.decorations | 0;
    const k = sway.buckets | 0;
    const s = poolSlotBytes(d);
    regions.push(
      { name: 'swaySnapshot', owner: 'particle', bytes: d * s },
      { name: 'swayPhaseSin', owner: 'particle', bytes: d * 4 },
      { name: 'swayPhaseCos', owner: 'particle', bytes: d * 4 },
      { name: 'swayBucketSin', owner: 'particle', bytes: k * 4 },
      { name: 'swayBucketCos', owner: 'particle', bytes: k * 4 },
      { name: 'swayBucketOf', owner: 'particle', bytes: d * 2 },
      { name: 'swayBucketFreq', owner: 'particle', bytes: d * 4 },
      { name: 'swayList', owner: 'particle', bytes: SWAY_LIST_CAP * s },
      { name: 'swayTrig', owner: 'particle', bytes: d * 4 },
      { name: 'swayTrigValue', owner: 'particle', bytes: d * 8 },
      { name: 'swayTable', owner: 'particle', bytes: SWAY_TABLE_SLOTS * 4 },
    );
  }
  if ((pixiRows | 0) > 0 || pixiExtra) {
    // W9d: Pixi's instance rows (15 floats each; W9e: 17 with pose interpolation, the pose stream then the statics)
    // and its own pack scratch, apart from pre-render's: the two pack at the same time. Close-out group B: the
    // scratch whenever Pixi packs anything (its custom layers, in either pack mode), with a column table for each
    // custom layer's two buffers (pixiExtra.tableBytes), and the glow batch's rows in pixi pack mode.
    regions.push(
      { name: 'pixiInstances', owner: 'Pixi packs and uploads', bytes: (pixiRows | 0) * (pixiFloats | 0) * 4 },
      { name: 'pixiGlowRows', owner: 'Pixi packs', bytes: (pixiExtra ? pixiExtra.glowRows | 0 : 0) * 15 * 4 },
      { name: 'pixiPackIndices', owner: 'Pixi', bytes: n * 4 },
      { name: 'pixiPackTables', owner: 'Pixi', bytes: pixiExtra ? pixiExtra.tableBytes | 0 : tableBytes },
      { name: 'pixiPackResults', owner: 'Pixi', bytes: 144 },
    );
  }
  if (collect) {
    // W4b: Transform's state block, Collider, and the collect kernel's list, table and results, so the kernel
    // reads every column the sprite collect reads. In a scene without physics Transform's pose too (the Weed
    // pose buffer: x, y, rotation, rotC, rotS). With physics (Phase 4: the regions are a block of Box2D's
    // memory, where Transform's pose already is), RigidBody's block and the two published pose buffers instead
    // (x, y, rotC, rotS each, the physics host's publishPose).
    const e = collect.entities | 0;
    const bodies = (collect.rigidBodyBytes | 0) > 0;
    regions.push(
      { name: 'transform', owner: 'every worker (Transform)', bytes: collect.transformBytes | 0 },
      { name: 'transformPose', owner: 'logic writes; every worker reads (Transform pose)', bytes: bodies ? 0 : e * 5 * 4 },
      { name: 'rigidBody', owner: 'every worker (RigidBody)', bytes: collect.rigidBodyBytes | 0 },
      { name: 'bodyPoseA', owner: 'physics publishes; every worker reads', bytes: bodies ? e * 16 : 0 },
      { name: 'bodyPoseB', owner: 'physics publishes; every worker reads', bytes: bodies ? e * 16 : 0 },
      { name: 'collider', owner: 'every worker (Collider)', bytes: collect.colliderBytes | 0 },
      { name: 'collectList', owner: 'pre-render', bytes: e * 4 },
      { name: 'collectTable', owner: 'pre-render', bytes: COLLECT_TABLE_SLOTS * 4 },
      { name: 'collectResults', owner: 'pre-render', bytes: 16 },
    );
    // W19: with physics, the bullet pool's block and the bullet tick's regions too (bulletTickClient.js): the
    // active list (u16) and the impact records it writes, the slots it returns, its ray stamps, table, results.
    const b = collect.bullets;
    if (b) {
      regions.push(
        { name: 'bulletComponent', owner: 'every worker (BulletComponent)', bytes: b.componentBytes | 0 },
        // The active list at the pool's slot width (u32 past 65 535 bullets).
        { name: 'bulletActive', owner: 'particle', bytes: ((b.bullets | 0) + 1) * ((b.bullets | 0) > 65535 ? 4 : 2) },
        { name: 'bulletImpacts', owner: 'particle', bytes: (b.impacts | 0) * 6 * 4 },
        { name: 'bulletReturned', owner: 'particle', bytes: (b.bullets | 0) * 4 },
        { name: 'bulletStamp', owner: 'particle', bytes: (b.entities | 0) * 4 },
        { name: 'bulletTable', owner: 'particle', bytes: BULLET_TABLE_SLOTS * 4 },
        { name: 'bulletResults', owner: 'particle', bytes: 16 },
      );
    }
    // W2b: with physics and raycasted lighting, LightOccluder's block, pre-render's visibility regions (W2a's
    // memory, placed here: visibilityMemory.js) and the gather kernel's table, results and event records
    // (visibilityGatherClient.js), so the gather reads every column it needs in this memory.
    const v = collect.visibility;
    if (v) {
      regions.push(
        { name: 'lightOccluder', owner: 'every worker (LightOccluder)', bytes: v.occluderBytes | 0 },
        { name: 'visibility', owner: 'pre-render (visibilityMemory.js)', bytes: v.bytes | 0 },
        { name: 'gatherTable', owner: 'pre-render', bytes: GATHER_TABLE_SLOTS * 4 },
        { name: 'gatherResults', owner: 'pre-render', bytes: 16 },
        { name: 'gatherEvents', owner: 'pre-render', bytes: (v.events | 0) * GATHER_EVENT_BYTES },
      );
    }
  }
  if (painter) {
    // W10: a painter state per worker that sorts; Pixi's and pre-render's are apart, they may sort at once.
    if (painter.preRender) regions.push(...painterStateRegions('preRenderPainter', n, 'pre-render'));
    if (painter.pixi) regions.push(...painterStateRegions('pixiPainter', n, 'Pixi'));
  }
  return layoutRegions(regions);
}

/**
 * A painter state's arrays (W10 `painterRadix.wasm`), in the order of the kernel's table (painterRadix.c P_*):
 * the JS painter state's order, scratch, moved, merge (u32 per row), prevKey (u32 per slot), slotMoved (u8 per
 * slot), runHeads (u32 per row) and runLen (u32 per slot) (createPainterState, tests/reference/painterJs.mjs), then
 * the kernel's histograms (PAINTER_HIST_WORDS u32, the JS radix's radixHist4) and its two ordinal buffers (u32 per
 * row).
 */
export const PAINTER_SLOTS = ['order', 'scratch', 'moved', 'merge', 'prevKey', 'slotMoved', 'runHeads', 'runLen', 'hist', 'ordsA', 'ordsB'];
/** painterRadix.c HIST_WORDS: three 11-bit histograms. */
export const PAINTER_HIST_WORDS = 6144;

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);

/**
 * One painter state's regions, named `${prefix}Order` … `${prefix}OrdsB` (PAINTER_SLOTS), then its table (a u32
 * byte offset per slot, written by the worker that binds the kernel) and the two slot lists the sort reads by
 * offset: the main queue's rows without the glow rows (`${prefix}IdxEntity`) and the glow rows
 * (`${prefix}IdxGlow`), u32 per row. Rows and slots are both the queue's rows.
 * @param {string} prefix
 * @param {number} rows the queue's rows (one state row per queue row)
 * @param {string} owner
 */
export function painterStateRegions(prefix, rows, owner) {
  const n = Math.max(1, rows | 0);
  const bytes = (slot) => (slot === 'slotMoved' ? n : slot === 'hist' ? PAINTER_HIST_WORDS * 4 : n * 4);
  return [
    ...PAINTER_SLOTS.map((slot) => ({ name: `${prefix}${capitalized(slot)}`, owner, bytes: bytes(slot) })),
    { name: `${prefix}Table`, owner, bytes: PAINTER_SLOTS.length * 4 },
    { name: `${prefix}IdxEntity`, owner, bytes: n * 4 },
    { name: `${prefix}IdxGlow`, owner, bytes: n * 4 },
  ];
}

/**
 * The byte offsets of painterStateRegions(prefix, rows) in a layout: `${slot}Byte` for each of PAINTER_SLOTS,
 * tableByte, idxEntityByte and idxGlowByte, and the rows (plain numbers: the layout posts to workers as it is).
 * @param {Record<string, { byte: number }>} regions layoutRegions(...).regions
 * @param {string} prefix
 * @param {number} rows
 */
export function painterStateLayout(regions, prefix, rows) {
  const out = {
    rows: Math.max(1, rows | 0),
    tableByte: regions[`${prefix}Table`].byte,
    idxEntityByte: regions[`${prefix}IdxEntity`].byte,
    idxGlowByte: regions[`${prefix}IdxGlow`].byte,
  };
  for (const slot of PAINTER_SLOTS) out[`${slot}Byte`] = regions[`${prefix}${capitalized(slot)}`].byte;
  return out;
}

/** Room for the collect kernel's column table (preRenderCollectClient.js COLLECT_SLOTS). */
export const COLLECT_TABLE_SLOTS = 64;

/** Room for the bullet tick's column table (bulletTickClient.js BULLET_TICK_SLOTS). */
export const BULLET_TABLE_SLOTS = 48;

/** Room for the visibility gather's column table (visibilityGatherClient.js GATHER_SLOTS). */
export const GATHER_TABLE_SLOTS = 64;
/** One gather event record: kind, entity, occluder slot, pad (i32 each), the display pose (four doubles). */
export const GATHER_EVENT_BYTES = 48;

/** The decorations the sway kernel lets through its early continues at a time (its chunk list). */
export const SWAY_LIST_CAP = 1024;
/** Room for the sway kernel's column table (decorationSwayClient.js SWAY_SLOTS). */
export const SWAY_TABLE_SLOTS = 32;

/** The stamp grid's cells: gpuShadowCasters.js's STAMP_GRID_MAX_CELLS, the length of its counts array. */
export const STAMP_GRID_CELLS = 128 * 128;
/** A light in the stamp's light table: x, y, intensity, rangeSq, maxShadows (doubles). */
export const STAMP_LIGHT_DOUBLES = 5;
/** Room for the stamp kernel's column table (shadowStampClient.js STAMP_SLOTS). */
export const STAMP_TABLE_SLOTS = 32;

/** The emit's texture tables (E-112): spritesheetId and animationState are u8, texture ids u16. */
export const EMIT_PROXY_SHEETS = 256;
export const EMIT_PROXY_STATES = 256;
export const EMIT_MAX_ANIMATIONS = 65536;
export const EMIT_MAX_FRAMES = 65536;
/** Room for the emit kernel's column table (preRenderEmitClient.js EMIT_SLOTS). */
export const EMIT_TABLE_SLOTS = 192;
/** The emit's doubles block (preRenderEmit.c E_PARAMS). */
export const EMIT_PARAM_DOUBLES = 8;
/** A custom layer collector's bytes per row: y, index, stash x, y, rotC, rotS (4 bytes each), type (1). */
export const CUSTOM_COLLECTOR_ROW_BYTES = 25;
/** W27: the Adobe assets the emit kernel's directory holds (asset ids 0 … 255), and the bytes of a record. */
export const EMIT_ADOBE_MAX_ASSETS = 256;
export const EMIT_ADOBE_ASSET_BYTES = 160;

/**
 * The navigation memory (W14 `navFlowfield.wasm`, created by navigationMemory.js). NavGrid reads its
 * header at byte 0 of the buffer it is given, so this memory starts with the nav buffer and has no guard
 * (no table slot is 0: the walkability is at byte 32). After it, the particle worker's flowfield scratch:
 * - state: a byte per cell (wall, settled, grid edges), dist (u16) and dir (u8) per cell;
 * - next, prev: the distance buckets' lists (i32 per cell); head: the buckets' heads (i32, 65 536 at most:
 *   NavScratch.maxDistance is capped at 65 535);
 * - sums: the smoothing's row sums (u32 per cell); quotient: its rounded quotients (NAV_QUOTIENT_BYTES);
 * - vectors: the smoothed Int8 pairs the slot is filled from; table: the kernel's column table.
 * @param {number} navBytes NavGrid.calculateSABSize(...)
 * @param {number} cells gridWidth * gridHeight
 */
export function navigationMemoryRegions(navBytes, cells) {
  const n = cells | 0;
  return layoutRegions([
    { name: 'nav', owner: 'every worker (NavGrid); the particle worker writes the slots', bytes: navBytes | 0 },
    { name: 'state', owner: 'particle', bytes: n },
    { name: 'dist', owner: 'particle', bytes: n * 2 },
    { name: 'dir', owner: 'particle', bytes: n },
    { name: 'next', owner: 'particle', bytes: n * 4 },
    { name: 'prev', owner: 'particle', bytes: n * 4 },
    { name: 'head', owner: 'particle', bytes: NAV_MAX_BUCKETS * 4 },
    { name: 'sums', owner: 'particle', bytes: n * 4 },
    { name: 'quotient', owner: 'particle', bytes: NAV_QUOTIENT_BYTES },
    { name: 'vectors', owner: 'particle', bytes: n * 2 },
    { name: 'table', owner: 'particle', bytes: NAV_TABLE_SLOTS * 4 },
  ]);
}

/** The flowfield's distance buckets: NavScratch.maxDistance + 1 at most. */
export const NAV_MAX_BUCKETS = 65536;
/** navFlowfield.c's QUOTIENT_BYTES: the 19 x 10 (sum, count) pairs of the smoothing. */
export const NAV_QUOTIENT_BYTES = 190;
/** Room for the flowfield kernel's column table (navFlowfieldClient.js FLOWFIELD_SLOTS). */
export const NAV_TABLE_SLOTS = 16;

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
 * E-129: past 65 535 particles every list and scratch list above is u32, and flat and heighted are the
 * pool's size (poolSlotBytes); up to 65 535 the regions are the 16-bit ones above.
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 * @param {number} lutFloats every EXPO table's entries together
 */
export function particleMemoryRegions(maxParticles, componentBytes, lutFloats) {
  const n = maxParticles | 0;
  const s = poolSlotBytes(n);
  const scratch = s === 2 ? 65536 : n;
  return layoutRegions([
    { name: 'component', owner: 'every worker (the ParticleComponent views)', bytes: componentBytes },
    { name: 'activeList', owner: 'particle; Pixi reads', bytes: (n + 2) * s },
    { name: 'visibleList', owner: 'particle; pre-render reads', bytes: (n + 2) * s },
    { name: 'stamp', owner: 'particle', bytes: n * s },
    { name: 'flat', owner: 'particle', bytes: scratch * s },
    { name: 'heighted', owner: 'particle', bytes: scratch * s },
    { name: 'dead', owner: 'particle', bytes: n * s },
    { name: 'trig', owner: 'particle', bytes: n * s },
    { name: 'trigAngle', owner: 'particle', bytes: n * 8 },
    { name: 'luts', owner: 'particle, read only', bytes: lutFloats * 4 },
    { name: 'columns', owner: 'particle, read only', bytes: CACHE_LINE_BYTES * 4 },
    { name: 'results', owner: 'particle', bytes: 16 },
  ]);
}

/**
 * The mesh batches' row bytes: colliderFillBatch.js COLLIDER_FILL_STRIDE and MESH_UV_FILL_STRIDE. That module
 * loads Pixi, which the main thread does not; meshCornersLayout.test.js ties the two.
 */
export const MESH_FILL_ROW_BYTES = 72;
export const MESH_UV_ROW_BYTES = 96;
/** Room for the corner kernel's column table (meshCornersClient.js MESH_CORNER_SLOTS). */
export const MESH_CORNER_TABLE_SLOTS = 32;

/**
 * The mesh memory (E-76 W11 `meshCorners.wasm`, created by meshMemory.js on the main thread). MeshGeometry
 * lays its views out from byte 0 of its buffer in every worker, so this memory starts with the block and has
 * no guard: logic workers write the meshes there, Pixi reads them. After it, Pixi's:
 * - meshCornerTable: the kernel's column table (u32 byte offsets);
 * - per MESH layer k, in the order of the layer metadata: meshFillRows<k> and meshUvRows<k>, the layer's fill
 *   and UV batches (the rows Pixi uploads); meshFillEntity<k> and meshUvEntity<k>, their instance-to-entity
 *   lists (u32 per row); meshLastVertGen<k>, meshFrameVertGen<k>, meshLastUvGen<k> and meshFrameUvGen<k>,
 *   the vertex and UV generations the layer drew and this frame's copies (u32 per entity, E-118).
 * @param {number} geometryBytes MeshGeometry.getBufferSize(maxVerts, maxIndices, entities)
 * @param {number} entities
 * @param {Array<{ fillRows: number, uvRows: number }>} layers each MESH layer's batch capacities
 */
export function meshMemoryRegions(geometryBytes, entities, layers) {
  const e = entities | 0;
  const regions = [
    { name: 'meshGeometry', owner: 'every worker (MeshGeometry): logic writes, Pixi reads', bytes: geometryBytes | 0 },
    { name: 'meshCornerTable', owner: 'Pixi', bytes: MESH_CORNER_TABLE_SLOTS * 4 },
  ];
  for (let k = 0; k < layers.length; k++) {
    const fill = layers[k].fillRows | 0;
    const uv = layers[k].uvRows | 0;
    regions.push(
      { name: `meshFillRows${k}`, owner: 'Pixi', bytes: fill * MESH_FILL_ROW_BYTES },
      { name: `meshUvRows${k}`, owner: 'Pixi', bytes: uv * MESH_UV_ROW_BYTES },
      { name: `meshFillEntity${k}`, owner: 'Pixi', bytes: fill * 4 },
      { name: `meshUvEntity${k}`, owner: 'Pixi', bytes: uv * 4 },
      { name: `meshLastVertGen${k}`, owner: 'Pixi', bytes: e * 4 },
      { name: `meshFrameVertGen${k}`, owner: 'Pixi', bytes: e * 4 },
      { name: `meshLastUvGen${k}`, owner: 'Pixi', bytes: e * 4 },
      { name: `meshFrameUvGen${k}`, owner: 'Pixi', bytes: e * 4 },
    );
  }
  return layoutRegions(regions);
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
export function spatialPublishRegionList(entityCount, maxNeighbors, spatialWorkers, gather = null, idBytes = 2) {
  const count = entityCount | 0;
  const workers = Math.max(1, spatialWorkers | 0);
  // W8b: ids are 2 or 4 bytes (the scene's entity id width) in the rows, the lists and the rebuild lists.
  const id = idBytes === 4 ? 4 : 2;
  const rowBytes = count * (1 + (maxNeighbors | 0)) * id;
  const listStride = alignToLine(count * id);
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
  const rebuildStride = alignToLine(count * id);
  // order_batch_by_cell: a u32 histogram[256], then two u16 key lists and a list of ids, each of the entity count.
  const orderStride = alignToLine(1024 + count * (4 + id));
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

/** A stamp record of decalStamp.wasm: f64 x, y, scaleX, scaleY, alpha; u32 tint, blendMode, texture byte, width, height, pad. */
export const DECAL_STAMP_BYTES = 64;
/** The stamps one flush holds; a frame with more flushes when the records are full. */
export const DECAL_MAX_STAMPS = 4096;
/** Room for the stamp kernel's column table (decalStampClient.js DECAL_SLOTS). */
export const DECAL_TABLE_SLOTS = 16;

/**
 * The decal memory (E-76 W26, decalMemory.js): the RGBA tiles at byte 0, where every worker views them (as it
 * viewed the tiles' own SharedArrayBuffer), then the stamp kernel's scratch. `touched` is a byte per tile the
 * kernel sets when it stamps one; the particle worker publishes those as the tiles' dirty flags after the call.
 * @param {number} tileBytes the tiles' bytes
 * @param {number} totalTiles
 * @param {number} textureBytes every decal texture's RGBA, each from a 64-byte line
 * @param {number} tilePixels a tile's side in pixels (the widest clip the column map holds)
 */
export function decalMemoryRegions(tileBytes, totalTiles, textureBytes, tilePixels) {
  return layoutRegions([
    { name: 'tiles', owner: 'particle writes; Pixi, main and logic read', bytes: tileBytes },
    { name: 'touched', owner: 'particle', bytes: totalTiles },
    { name: 'textures', owner: 'particle, read only', bytes: textureBytes },
    { name: 'stamps', owner: 'particle', bytes: DECAL_MAX_STAMPS * DECAL_STAMP_BYTES },
    // decalStamp.c's column map: two arrays of column_stride(tilePixels) u32.
    { name: 'columns', owner: 'particle', bytes: ((tilePixels + 6) & ~3) * 4 * 2 },
    { name: 'table', owner: 'particle', bytes: DECAL_TABLE_SLOTS * 4 },
    // W21c: the premultiply kernel's output, one tile, which Pixi copies into the tile's own array.
    { name: 'premultiplied', owner: 'Pixi', bytes: tilePixels * tilePixels * 4 },
  ]);
}
