// The render-queue memory (E-76 W9): the render queue's and the GPU queue's two buffers each, as
// regions of one shared WebAssembly.Memory, with the pack kernel's scratch after them. Pre-render
// writes the queue and packs it there (gpuPack.wasm reads the rows where they were written); Pixi
// views both queues at the regions' byte offsets, as it views plain SharedArrayBuffers at 0.
// E-112 (W4a): with an emit spec it also holds the SpriteRenderer, ShadowCaster and DecorationComponent
// blocks and pre-render's emit state, so the emit kernel reads every column where the scene keeps it.
// E-114 (W23): with a stamp spec, the shadow stamp's scratch and light table.
// W22: with a sway spec, the particle worker's decoration sway arrays.
// W10: with a painter spec, the painter sort's state of the worker that sorts (pre-render's, Pixi's, or both).
// W27: with emit.adobe, the AdobeAnimComponent block, the collector's pose stash and the Adobe assets' tables.

import { painterStateLayout, renderQueueMemoryRegions, SWAY_LIST_CAP } from './wasmMemoryMap.js';
import { GPU_PACK_COLUMNS } from '../render/gpuPackClient.js';

// The module's import accepts up to 32768 pages (2 GB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 32768;

/** Column tables the pack keeps: the two queue buffers, with room to spare. */
export const GPU_PACK_TABLE_SLOTS = 4;

/**
 * @param {number} maxItems the render queue's rows
 * @param {number} queueBytes computeBufferSize(maxItems)
 * @param {number} gpuQueueBytes computeGpuQueueBufferSize(caps)
 * @param {null | { entities: number, spriteBytes: number, casterBytes: number, decorationBytes: number,
 *   lightBytes?: number, particleBytes?: number, liquidFun?: null | { maxCount: number, renderBytes: number },
 *   customLayers?: Array<{ layerId: number, maxItems: number, queueBytes: number }>, bulletBytes?: number,
 *   adobe?: null | { animBytes: number, tableBytes: number } }} [emit]
 *   the emit's regions too (renderQueueMemoryRegions); a component with 0 bytes gets no block (byte -1)
 * @param {null | { maxSun: number, maxPerEntity: number, maxLights: number, cookies?: number, cookieBytes?: number }} [stamp]
 *   the stamp's regions too, with the light cookies' queue
 * @param {null | { decorations: number, buckets: number }} [sway] the sway's regions too (with emit's decorations)
 * @param {boolean | number} [pixiPack] Pixi's sprite rows and pack scratch too (W9d), one row per queue row: true or 15
 *   floats a row, 17 for a pose batch's two streams (W9e, renderer.interpolation), false or 0 for none
 * @param {null | { entities: number, transformBytes: number, colliderBytes: number, rigidBodyBytes?: number }} [collect]
 *   the sprite collect's blocks too (W4b): Transform, its pose, Collider and the kernel's scratch; with
 *   rigidBodyBytes (physics, in Box2D's block) RigidBody and the published pose buffers instead of the pose
 * @param {null | { preRender: boolean, pixi: boolean }} [painter] the painter sort's state too (W10), one set per
 *   worker that sorts the main queue, each with its slot lists (layout.preRenderPainter, layout.pixiPainter)
 * @param {null | { memory: WebAssembly.Memory, baseByte: number }} [place] lay the regions in that memory from
 *   baseByte (Phase 4: a block of Box2D's memory) instead of making a memory of their own
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, any> }}
 */
export function createRenderQueueMemory(maxItems, queueBytes, gpuQueueBytes, emit = null, stamp = null, sway = null, pixiPack = false, collect = null, painter = null, place = null) {
  const n = maxItems | 0;
  if (n <= 0) return null;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const pixiFloats = pixiPack === true ? 15 : pixiPack | 0;
  const pixiRows = pixiFloats > 0 ? n : 0;
  const pixiExtra = pixiExtraSpec(emit);
  const map = renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit, stamp, sway, pixiRows, collect, painter, pixiFloats || 15, pixiExtra);
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
        // Phase 4: the regions are a block of Box2D's memory, so Transform's pose in Box2D's heap is in it too.
        inBox2dBlock: Boolean(place),
        emit: emit ? emitLayout(r, emit.entities | 0, n, emit.customLayers) : null,
        stamp: stamp ? stampLayout(r, stamp) : null,
        sway: sway ? swayLayout(r, sway) : null,
        collect: collect ? collectLayout(r, collect) : null,
        // W9d: Pixi's instance rows (0 rows: Pixi does not pack the entities' plain rows here) and its pack scratch
        // (close-out group B: whenever the emit's regions are there, for Pixi's custom layers and glow batch), with
        // a column table per queue buffer it packs; the glow batch's rows in pixi pack mode.
        pixiInstanceRows: pixiRows,
        pixiInstanceFloats: pixiRows > 0 ? pixiFloats : 0,
        pixiInstanceByte: pixiRows > 0 ? r.pixiInstances.byte : -1,
        pixiIndexByte: r.pixiPackIndices ? r.pixiPackIndices.byte : -1,
        pixiTableByte: r.pixiPackTables ? r.pixiPackTables.byte : -1,
        pixiTableSlots: pixiExtra ? pixiExtra.tableSlots : GPU_PACK_TABLE_SLOTS,
        pixiParticlesByte: r.pixiPackResults ? r.pixiPackResults.byte : -1,
        pixiGlowRows: r.pixiGlowRows && r.pixiGlowRows.bytes > 0 ? pixiExtra.glowRows : 0,
        pixiGlowByte: r.pixiGlowRows && r.pixiGlowRows.bytes > 0 ? r.pixiGlowRows.byte : -1,
        // W10: each sorting worker's painter state (null: that worker sorts in JS on arrays of its own).
        preRenderPainter: painter?.preRender ? painterStateLayout(r, 'preRenderPainter', n) : null,
        pixiPainter: painter?.pixi ? painterStateLayout(r, 'pixiPainter', n) : null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Pixi's pack scratch beyond its entity rows (close-out group B), with the emit's regions: a column table for each
 * queue buffer it packs (the entities' two, each custom layer's two, two to spare) and the glow batch's rows.
 */
function pixiExtraSpec(emit) {
  if (!emit) return null;
  const tableSlots = GPU_PACK_TABLE_SLOTS + 2 * ((emit.customLayers && emit.customLayers.length) | 0);
  return { glowRows: emit.pixiGlowRows | 0, tableSlots, tableBytes: tableSlots * GPU_PACK_COLUMNS.length * 4 };
}

/** Byte offsets of the emit's regions; -1 for a component block the scene does not have. */
function emitLayout(r, entities, rows, customLayers) {
  const block = (region) => (region.bytes > 0 ? region.byte : -1);
  return {
    // Each custom sprite layer's queue buffers and collector (CUSTOM_COLLECTOR_ROW_BYTES a row).
    customLayers: (customLayers || []).map((c, k) => ({
      layerId: c.layerId,
      maxItems: c.maxItems | 0,
      queueAByte: r[`customQueueA${k}`].byte,
      queueBByte: r[`customQueueB${k}`].byte,
      collectorByte: r[`customCollector${k}`].byte,
      rowsByte: r[`customRows${k}`].byte,
    })),
    entities,
    spriteRendererByte: block(r.spriteRenderer),
    shadowCasterByte: block(r.shadowCaster),
    decorationByte: block(r.decorations),
    lightEmitterByte: block(r.lightEmitter),
    // BulletComponent here when the bullet tick's block does not hold it, -1 otherwise.
    bulletComponentByte: block(r.emitBullets),
    // The particle memory's place (createParticleMemory), -1 without particles.
    particleMemoryByte: block(r.particleMemory),
    particleMemoryBytes: r.particleMemory.bytes,
    // The LiquidFun render buffer and pre-render's previous positions (x then y), -1 without LiquidFun.
    liquidFunRenderByte: block(r.liquidFunRender),
    lfPrevByte: block(r.emitLfPrev),
    lfMaxCount: r.emitLfPrev.bytes / 8,
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
    paramsByte: r.emitParams.byte,
    // E-138: the presort's keys and order (one per queue row).
    presortKeysByte: r.emitPresortKeys.byte,
    presortOrderByte: r.emitPresortOrder.byte,
    // Buffer b's rows start at byte + b * persistRows * the element size.
    persistRows: rows,
    persistTypeByte: r.emitPersistType.byte,
    persistEntityByte: r.emitPersistEntity.byte,
    persistFrameByte: r.emitPersistFrame.byte,
    persistAnimByte: r.emitPersistAnim.byte,
    // W27: the Adobe emit's regions, -1 without them (no AdobeAnimComponent).
    adobeAnimByte: r.adobeAnim ? block(r.adobeAnim) : -1,
    stashXByte: r.emitStashX ? r.emitStashX.byte : -1,
    stashYByte: r.emitStashY ? r.emitStashY.byte : -1,
    stashRotCByte: r.emitStashRotC ? r.emitStashRotC.byte : -1,
    stashRotSByte: r.emitStashRotS ? r.emitStashRotS.byte : -1,
    adobeListByte: r.emitAdobeList ? r.emitAdobeList.byte : -1,
    adobeAssetsByte: r.emitAdobeAssets ? r.emitAdobeAssets.byte : -1,
    adobeAssetsBytes: r.emitAdobeAssets ? r.emitAdobeAssets.bytes : 0,
  };
}

/** Byte offsets and capacities of the stamp's regions. */
/** Byte offsets of the collect's regions; -1 for a component block the scene does not have. */
function collectLayout(r, collect) {
  const block = (region) => (region.bytes > 0 ? region.byte : -1);
  return {
    entities: collect.entities | 0,
    transformByte: block(r.transform),
    poseByte: block(r.transformPose),
    rigidBodyByte: block(r.rigidBody),
    bodyPoseAByte: block(r.bodyPoseA),
    bodyPoseBByte: block(r.bodyPoseB),
    colliderByte: block(r.collider),
    listByte: r.collectList.byte,
    tableByte: r.collectTable.byte,
    resultsByte: r.collectResults.byte,
    // W19: the bullet tick's regions (bindBulletTick's layout), or null.
    bullets: collect.bullets
      ? {
          bullets: collect.bullets.bullets | 0,
          entities: collect.bullets.entities | 0,
          impacts: collect.bullets.impacts | 0,
          componentByte: r.bulletComponent.byte,
          activeByte: r.bulletActive.byte,
          impactsByte: r.bulletImpacts.byte,
          returnedByte: r.bulletReturned.byte,
          stampByte: r.bulletStamp.byte,
          tableByte: r.bulletTable.byte,
          resultsByte: r.bulletResults.byte,
        }
      : null,
    // W2b: the visibility gather's regions (bindVisibilityGather's layout; createVisibilityMemory's place and
    // options), or null.
    visibility: collect.visibility
      ? {
          opts: { ...collect.visibility.opts },
          occluderByte: r.lightOccluder.byte,
          byte: r.visibility.byte,
          bytes: r.visibility.bytes,
          tableByte: r.gatherTable.byte,
          resultsByte: r.gatherResults.byte,
          eventsByte: r.gatherEvents.byte,
          events: collect.visibility.events | 0,
        }
      : null,
  };
}

/** The bytes createRenderQueueMemory's regions take, for a block reserved before the memory is made (Phase 4). */
export function renderQueueMemoryBytes(maxItems, queueBytes, gpuQueueBytes, emit = null, stamp = null, sway = null, pixiPack = false, collect = null, painter = null) {
  const n = maxItems | 0;
  if (n <= 0) return 0;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const pixiFloats = pixiPack === true ? 15 : pixiPack | 0;
  return renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit, stamp, sway, pixiFloats > 0 ? n : 0, collect, painter, pixiFloats || 15, pixiExtraSpec(emit)).bytes;
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
    // The cookies' queue (createRenderQueueViews at cookieQueueByte, cookies rows), -1 without one.
    cookies: stamp.cookies | 0,
    cookieQueueByte: r.cookieQueue.bytes > 0 ? r.cookieQueue.byte : -1,
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
