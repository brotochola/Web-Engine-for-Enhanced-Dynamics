// The WASM sprite collect (E-76 W4b): loads preRenderCollect.wasm onto the render-queue memory, where the scene
// keeps every column pre-render's sprite collect reads (Transform and its pose, SpriteRenderer, Collider; with
// physics, Phase 4, RigidBody and the published poses in Box2D's block) and the main collector it writes
// (renderQueueMemoryRegions' collect spec). collect_sprites and collect_sprites_turned walk the sprites as
// collectVisibleEntities' two loops did; a sprite with a layer mask, or whose sort line needs a frame not resolved
// yet, is handed back for collectRenderable in JS. The JS loops are tests/reference/preRenderCollectJs.mjs.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { COLLECT_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./preRenderCollect.wasm', import.meta.url);

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
  const k = await loadWasmKernel('preRenderCollect', wasmUrl, memory, ['collect_sprites', 'collect_sprites_turned']);
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
  let ok = true;
  // A column the scene has must be in the memory; one it lacks is 0, which the kernel reads as absent.
  const put = (slot, a, required) => {
    if (!a) {
      t[SLOT[slot]] = 0;
      if (required) ok = false;
    } else if (a.buffer === buffer) {
      t[SLOT[slot]] = a.byteOffset;
    } else {
      ok = false;
    }
  };
  put('tActive', Transform.active, true);
  put('tX', Transform.x, true);
  put('tY', Transform.y, true);
  put('tRotC', Transform.rotC, false);
  put('tRotS', Transform.rotS, false);
  put('sActive', SpriteRenderer.active, true);
  put('sVisible', SpriteRenderer.renderVisible, true);
  put('sHalfW', SpriteRenderer.boundsHalfW, false);
  put('sHalfH', SpriteRenderer.boundsHalfH, false);
  put('sSheet', SpriteRenderer.spritesheetId, false);
  put('sMask', SpriteRenderer.layerMask, false);
  put('cVisualRange', Collider.visualRange, false);
  put('oY', worker._renderableY, true);
  put('oType', worker._renderableType, true);
  put('oIndex', worker._renderableIndex, true);
  put('oX', worker._collectPx, true);
  put('oPy', worker._collectPy, true);
  put('oRotC', worker._collectRotC, true);
  put('oRotS', worker._collectRotS, true);
  let mode = 0;
  const bodies = worker._poseX && worker._rbActive ? worker._rbActive : null;
  const live = bodies !== null;
  put('bActive', bodies, false);
  put('pX', live ? worker._poseX : null, live);
  put('pY', live ? worker._poseY : null, live);
  put('pRotC', live ? worker._poseRotC : null, live);
  put('pRotS', live ? worker._poseRotS : null, live);
  // The generation before it: none until the second publish (0, and the kernel does not interpolate).
  const prev = live && Boolean(worker._prevPoseX);
  put('qX', prev ? worker._prevPoseX : null, false);
  put('qY', prev ? worker._prevPoseY : null, prev);
  put('qRotC', prev ? worker._prevPoseRotC : null, prev);
  put('qRotS', prev ? worker._prevPoseRotS : null, prev);
  t[SLOT.bInterpolate] = worker.interpolatePhysicsPose ? 1 : 0;
  if (live) mode |= COLLECT_MODE_BODIES;
  const sortY = Boolean(worker._entitySortY);
  const emit = sortY ? worker._emitWasm : null;
  if (sortY && !emit) ok = false;
  put('sAnchorX', sortY ? SpriteRenderer.anchorX : null, sortY);
  put('sAnchorY', sortY ? SpriteRenderer.anchorY : null, sortY);
  put('sScaleX', sortY ? SpriteRenderer.scaleX : null, sortY);
  put('sScaleY', sortY ? SpriteRenderer.scaleY : null, sortY);
  const inherit = sortY ? SpriteRenderer.inheritTransformRotation : null;
  put('sInherit', inherit, false);
  put('sFaceC', inherit ? SpriteRenderer.spriteRotC : null, Boolean(inherit));
  put('sFaceS', inherit ? SpriteRenderer.spriteRotS : null, Boolean(inherit));
  put('eLastTexture', sortY ? worker.entityLastTextureId : null, sortY);
  t[SLOT.eFrameW] = emit ? emit.layout.frameWidthByte : 0;
  t[SLOT.eFrameH] = emit ? emit.layout.frameHeightByte : 0;
  t[SLOT.eFrames] = emit ? emit.frames : 0;
  if (sortY) mode |= COLLECT_MODE_SORT_Y;
  b.mode = mode;
  return ok;
}

/** Point the table at the sprite query's list, copied into the memory, or at none (a scan of every index). */
export function writeCollectList(b, ids, n = ids ? ids.length : 0) {
  if (ids && n > 0) {
    b.list.set(n === ids.length ? ids : ids.subarray(0, n));
    b.table[SLOT.list] = b.listByte;
    return ids.length;
  }
  b.table[SLOT.list] = 0;
  return 0;
}
