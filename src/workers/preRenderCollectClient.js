// The WASM sprite collect (E-76 W4b): loads preRenderCollect.wasm onto the render-queue memory, where the scene
// keeps every column pre-render's sprite collect reads (Transform and its pose, SpriteRenderer, Collider; with
// physics, Phase 4, RigidBody and the published poses in Box2D's block) and the main collector it writes
// (renderQueueMemoryRegions' collect spec). collect_sprites and collect_sprites_turned walk the sprites as
// collectVisibleEntities' two loops did; a sprite with a layer mask, or whose sort line needs a frame not resolved
// yet, is handed back for collectRenderable in JS. The JS loops are tests/reference/preRenderCollectJs.mjs.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { COLLECT_TABLE_SLOTS } from '../util/wasmMemoryMap.js';
import { engineWasmUrl } from '../wasm/engine.js';
import { putColumn } from '../util/wasmColumnTable.js';


/** wasm/preRenderCollect.c's column table, slot for slot. */
export const COLLECT_SLOTS = [
  'list', 'listU32', 'tActive', 'tX', 'tY', 'tRotC', 'tRotS',
  'sActive', 'sVisible', 'sHalfW', 'sHalfH', 'sSheet', 'sMask', 'cVisualRange',
  'oY', 'oType', 'oIndex', 'oX', 'oPy', 'oRotC', 'oRotS', 'results',
  'bActive', 'pX', 'pY', 'pRotC', 'pRotS', 'qX', 'qY', 'qRotC', 'qRotS', 'bInterpolate',
  'sAnchorX', 'sAnchorY', 'sScaleX', 'sScaleY', 'sInherit', 'sFaceC', 'sFaceS',
  'eLastTexture', 'eFrameW', 'eFrameH', 'eFrames',
];
/** The kernel's mode bits: the bodies' published poses, the foot-line sort key. */
export const COLLECT_MODE_BODIES = 1;
export const COLLECT_MODE_SORT_Y = 2;
if (COLLECT_SLOTS.length > COLLECT_TABLE_SLOTS) throw new Error('preRenderCollect: the column table outgrew its region');
const SLOT = Object.fromEntries(COLLECT_SLOTS.map((name, k) => [name, k]));

export async function bindPreRenderCollect(memory, collect) {
  const k = await loadWasmKernel('preRenderCollect', engineWasmUrl, memory, ['collect_sprites', 'collect_sprites_turned']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, collect.tableByte, COLLECT_SLOTS.length);
  table[SLOT.listU32] = 1;
  table[SLOT.results] = collect.resultsByte;
  return {
    buffer,
    collectSprites: k.collect_sprites,
    collectSpritesTurned: k.collect_sprites_turned,
    table,
    tableByte: collect.tableByte,
    results: new Int32Array(buffer, collect.resultsByte, 4),
    list: new Uint32Array(buffer, collect.listByte, collect.entities),
    listByte: collect.listByte,
    // E-217: the sprite query's view the list holds a copy of (null: another list, or none yet), and its length.
    listIds: null,
    listCount: 0,
    // This frame's COLLECT_MODE_* bits, from writeCollectColumns.
    mode: 0,
  };
}

/**
 * The column table for this frame (the collector's pose columns are the queue buffer being written), and b.mode:
 * the bodies' poses when the worker latched one (the generation this frame reads, and the one before it), the
 * foot-line sort key when the worker Y-sorts (with the emit kernel's copy of the frame sizes: none before its texture
 * tables, and a sprite whose frame is then out of them is sized 0). False when a column the collect reads is not in
 * the memory: the frame collects no sprite.
 */
export function writeCollectColumns(b, worker, Transform, SpriteRenderer, Collider) {
  const t = b.table;
  const buffer = b.buffer;
  // A column the scene has must be in the memory; one it lacks is 0, which the kernel reads as absent.
  let ok = 1;
  ok &= putColumn(t, SLOT.tActive, Transform.active, true, buffer);
  ok &= putColumn(t, SLOT.tX, Transform.x, true, buffer);
  ok &= putColumn(t, SLOT.tY, Transform.y, true, buffer);
  ok &= putColumn(t, SLOT.tRotC, Transform.rotC, false, buffer);
  ok &= putColumn(t, SLOT.tRotS, Transform.rotS, false, buffer);
  ok &= putColumn(t, SLOT.sActive, SpriteRenderer.active, true, buffer);
  ok &= putColumn(t, SLOT.sVisible, SpriteRenderer.renderVisible, true, buffer);
  ok &= putColumn(t, SLOT.sHalfW, SpriteRenderer.boundsHalfW, false, buffer);
  ok &= putColumn(t, SLOT.sHalfH, SpriteRenderer.boundsHalfH, false, buffer);
  ok &= putColumn(t, SLOT.sSheet, SpriteRenderer.spritesheetId, false, buffer);
  ok &= putColumn(t, SLOT.sMask, SpriteRenderer.layerMask, false, buffer);
  ok &= putColumn(t, SLOT.cVisualRange, Collider.visualRange, false, buffer);
  ok &= putColumn(t, SLOT.oY, worker._renderableY, true, buffer);
  ok &= putColumn(t, SLOT.oType, worker._renderableType, true, buffer);
  ok &= putColumn(t, SLOT.oIndex, worker._renderableIndex, true, buffer);
  ok &= putColumn(t, SLOT.oX, worker._collectPx, true, buffer);
  ok &= putColumn(t, SLOT.oPy, worker._collectPy, true, buffer);
  ok &= putColumn(t, SLOT.oRotC, worker._collectRotC, true, buffer);
  ok &= putColumn(t, SLOT.oRotS, worker._collectRotS, true, buffer);
  let mode = 0;
  const bodies = worker._poseX && worker._rbActive ? worker._rbActive : null;
  const live = bodies !== null;
  ok &= putColumn(t, SLOT.bActive, bodies, false, buffer);
  ok &= putColumn(t, SLOT.pX, live ? worker._poseX : null, live, buffer);
  ok &= putColumn(t, SLOT.pY, live ? worker._poseY : null, live, buffer);
  ok &= putColumn(t, SLOT.pRotC, live ? worker._poseRotC : null, live, buffer);
  ok &= putColumn(t, SLOT.pRotS, live ? worker._poseRotS : null, live, buffer);
  // The generation before it: none until the second publish (0, and the kernel does not interpolate).
  const prev = live && Boolean(worker._prevPoseX);
  ok &= putColumn(t, SLOT.qX, prev ? worker._prevPoseX : null, false, buffer);
  ok &= putColumn(t, SLOT.qY, prev ? worker._prevPoseY : null, prev, buffer);
  ok &= putColumn(t, SLOT.qRotC, prev ? worker._prevPoseRotC : null, prev, buffer);
  ok &= putColumn(t, SLOT.qRotS, prev ? worker._prevPoseRotS : null, prev, buffer);
  t[SLOT.bInterpolate] = worker.interpolatePhysicsPose ? 1 : 0;
  if (live) mode |= COLLECT_MODE_BODIES;
  const sortY = Boolean(worker._entitySortY);
  const emit = sortY ? worker._emitWasm : null;
  if (sortY && !emit) ok = 0;
  // N-140: the anchors serve the cull's reach as well as the sort line.
  ok &= putColumn(t, SLOT.sAnchorX, SpriteRenderer.anchorX, sortY, buffer);
  ok &= putColumn(t, SLOT.sAnchorY, SpriteRenderer.anchorY, sortY, buffer);
  ok &= putColumn(t, SLOT.sScaleX, sortY ? SpriteRenderer.scaleX : null, sortY, buffer);
  ok &= putColumn(t, SLOT.sScaleY, sortY ? SpriteRenderer.scaleY : null, sortY, buffer);
  const inherit = sortY ? SpriteRenderer.inheritTransformRotation : null;
  ok &= putColumn(t, SLOT.sInherit, inherit, false, buffer);
  ok &= putColumn(t, SLOT.sFaceC, inherit ? SpriteRenderer.spriteRotC : null, Boolean(inherit), buffer);
  ok &= putColumn(t, SLOT.sFaceS, inherit ? SpriteRenderer.spriteRotS : null, Boolean(inherit), buffer);
  ok &= putColumn(t, SLOT.eLastTexture, sortY ? worker.entityLastTextureId : null, sortY, buffer);
  t[SLOT.eFrameW] = emit ? emit.layout.frameWidthByte : 0;
  t[SLOT.eFrameH] = emit ? emit.layout.frameHeightByte : 0;
  t[SLOT.eFrames] = emit ? emit.frames : 0;
  if (sortY) mode |= COLLECT_MODE_SORT_Y;
  b.mode = mode;
  return ok === 1;
}

/**
 * Point the table at the sprite query's list, copied into the memory, or at none (a scan of every index). `published`:
 * ids is a query's published view (Query.queryActiveEntities), which comes back the same object only while no publish
 * came (E-217), so the copy the memory holds of it is kept: 200 000 ids a frame in BunnyMark, whose population does
 * not change. Any other list is copied each time.
 */
export function writeCollectList(b, ids, n = ids ? ids.length : 0, published = false) {
  if (ids && n > 0) {
    if (!published || ids !== b.listIds || n !== b.listCount) {
      b.list.set(n === ids.length ? ids : ids.subarray(0, n));
      b.listIds = published ? ids : null;
      b.listCount = n;
    }
    b.table[SLOT.list] = b.listByte;
    return ids.length;
  }
  b.table[SLOT.list] = 0;
  return 0;
}
