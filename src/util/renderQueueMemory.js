// The render-queue memory (E-76 W9): the render queue's and the GPU queue's two buffers each, as
// regions of one shared WebAssembly.Memory, with the pack kernel's scratch after them. Pre-render
// writes the queue and packs it there (gpuPack.wasm reads the rows where they were written); Pixi
// views both queues at the regions' byte offsets, as it views plain SharedArrayBuffers at 0.
// E-112 (W4a): with an emit spec it also holds the SpriteRenderer, ShadowCaster and DecorationComponent
// blocks and pre-render's emit state, so the emit kernel reads every column where the scene keeps it.
// E-114 (W23): with a stamp spec, the shadow stamp's scratch and light table.
// W22: with a sway spec, the particle worker's decoration sway arrays.

import { renderQueueMemoryRegions, SWAY_LIST_CAP } from './wasmMemoryMap.js';
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
 * @param {null | { maxSun: number, maxPerEntity: number, maxLights: number }} [stamp] the stamp's regions too
 * @param {null | { decorations: number, buckets: number }} [sway] the sway's regions too (with emit's decorations)
 * @param {boolean} [pixiPack] Pixi's plain sprite rows and pack scratch too (W9d), one row per queue row
 * @param {null | { entities: number, transformBytes: number, colliderBytes: number }} [collect] the sprite collect's
 *   blocks too (W4b): Transform, its pose, Collider and the kernel's scratch
 * @param {null | { memory: WebAssembly.Memory, baseByte: number }} [place] lay the regions in that memory from
 *   baseByte (Phase 4: a block of Box2D's memory) instead of making a memory of their own
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, any> }}
 */
export function createRenderQueueMemory(maxItems, queueBytes, gpuQueueBytes, emit = null, stamp = null, sway = null, pixiPack = false, collect = null, place = null) {
  const n = maxItems | 0;
  if (n <= 0) return null;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const pixiRows = pixiPack ? n : 0;
  const map = renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit, stamp, sway, pixiRows, collect);
  const base = place ? place.baseByte | 0 : 0;
  if (place) {
    if ((base & 63) !== 0 || base + map.bytes > place.memory.buffer.byteLength) return null;
  } else if (map.pages > WASM_MAX_PAGES) {
    return null;
  }
  // Every region's byte from the memory's start: the block's offset added when the regions sit in a block.
  const r = {};
  for (const [name, region] of Object.entries(map.regions)) r[name] = base ? { ...region, byte: region.byte + base } : region;
  try {
    const memory = place ? place.memory : new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
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
        emit: emit ? emitLayout(r, emit.entities | 0, n) : null,
        stamp: stamp ? stampLayout(r, stamp) : null,
        sway: sway ? swayLayout(r, sway) : null,
        collect: collect ? collectLayout(r, collect) : null,
        // W9d: Pixi's instance rows and pack scratch (0 rows: Pixi does not pack plain rows here).
        pixiInstanceRows: pixiRows,
        pixiInstanceByte: pixiRows > 0 ? r.pixiInstances.byte : -1,
        pixiIndexByte: pixiRows > 0 ? r.pixiPackIndices.byte : -1,
        pixiTableByte: pixiRows > 0 ? r.pixiPackTables.byte : -1,
        pixiParticlesByte: pixiRows > 0 ? r.pixiPackResults.byte : -1,
      },
    };
  } catch {
    return null;
  }
}

/** Byte offsets of the emit's regions; -1 for a component block the scene does not have. */
function emitLayout(r, entities, rows) {
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
    // Buffer b's rows start at byte + b * persistRows * the element size.
    persistRows: rows,
    persistTypeByte: r.emitPersistType.byte,
    persistEntityByte: r.emitPersistEntity.byte,
    persistFrameByte: r.emitPersistFrame.byte,
    persistAnimByte: r.emitPersistAnim.byte,
  };
}

/** Byte offsets and capacities of the stamp's regions. */
/** Byte offsets of the collect's regions; -1 for a component block the scene does not have. */
function collectLayout(r, collect) {
  const block = (region) => (region.bytes > 0 ? region.byte : -1);
  return {
    entities: collect.entities | 0,
    transformByte: block(r.transform),
    poseByte: r.transformPose.byte,
    colliderByte: block(r.collider),
    listByte: r.collectList.byte,
    tableByte: r.collectTable.byte,
    resultsByte: r.collectResults.byte,
  };
}

/** The bytes createRenderQueueMemory's regions take, for a block reserved before the memory is made (Phase 4). */
export function renderQueueMemoryBytes(maxItems, queueBytes, gpuQueueBytes, emit = null, stamp = null, sway = null, pixiPack = false, collect = null) {
  const n = maxItems | 0;
  if (n <= 0) return 0;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  return renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit, stamp, sway, pixiPack ? n : 0, collect).bytes;
}

function stampLayout(r, stamp) {
  return {
    maxSun: stamp.maxSun | 0,
    maxPerEntity: stamp.maxPerEntity | 0,
    maxLights: stamp.maxLights | 0,
    tmpIdxByte: r.stampTmpIdx.byte,
    distByte: r.stampDist.byte,
    orderByte: r.stampOrder.byte,
    keepByte: r.stampKeep.byte,
    gridCountsByte: r.stampGridCounts.byte,
    gridStartsByte: r.stampGridStarts.byte,
    gridItemsByte: r.stampGridItems.byte,
    nearDistByte: r.stampNearDist.byte,
    nearSlotByte: r.stampNearSlot.byte,
    nearCountByte: r.stampNearCount.byte,
    lightsByte: r.stampLights.byte,
    tableByte: r.stampTable.byte,
  };
}

/** Byte offsets and capacities of the sway's regions. */
function swayLayout(r, sway) {
  return {
    decorations: sway.decorations | 0,
    buckets: sway.buckets | 0,
    listCap: SWAY_LIST_CAP,
    snapshotByte: r.swaySnapshot.byte,
    phaseSinByte: r.swayPhaseSin.byte,
    phaseCosByte: r.swayPhaseCos.byte,
    bucketSinByte: r.swayBucketSin.byte,
    bucketCosByte: r.swayBucketCos.byte,
    bucketOfByte: r.swayBucketOf.byte,
    bucketFreqByte: r.swayBucketFreq.byte,
    listByte: r.swayList.byte,
    trigByte: r.swayTrig.byte,
    trigValueByte: r.swayTrigValue.byte,
    tableByte: r.swayTable.byte,
  };
}
