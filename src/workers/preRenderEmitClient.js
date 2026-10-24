// The WASM emit (E-76 W4a, E-112): loads preRenderEmit.wasm onto the render-queue memory, where the scene
// keeps every column pre-render's emit reads (the SpriteRenderer, ShadowCaster and DecorationComponent
// blocks, both queue buffers, the collector, the animation state; see renderQueueMemoryRegions). emit_rows
// writes the full emit's sprite and decoration rows with the JS's bits; the rows of other types, the
// play-once ends and the missing textures come back as lists, and pre-render acts on them in JS.
// W4c: persist_check, persist_poses and persist_remember are the entity queue's persist path, on the same
// table with the rows each queue buffer last held (writePersistColumns).

import { loadWasmKernel } from '../util/wasmKernel.js';
import { EMIT_PROXY_SHEETS, EMIT_PROXY_STATES, EMIT_MAX_ANIMATIONS, EMIT_MAX_FRAMES, EMIT_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./preRenderEmit.wasm', import.meta.url);

/** wasm/preRenderEmit.c's column table, slot for slot. */
export const EMIT_SLOTS = [
  'cType', 'cIndex', 'cY', 'stashX', 'stashY', 'stashRc', 'stashRs',
  'sScaleX', 'sScaleY', 'sAlpha', 'sTint', 'sAnchorX', 'sAnchorY', 'sInherit', 'sRotC', 'sRotS',
  'sRepeatX', 'sRepeatY', 'sTileMode', 'sTileOffU', 'sTileOffV', 'sHalfW', 'sHalfH',
  'sSheet', 'sAnim', 'sAnimated', 'sSpeed', 'sLoop', 'sZ',
  'scActive', 'scH', 'scOffX', 'scOffY',
  'dScaleX', 'dScaleY', 'dAlpha', 'dTint', 'dTexture', 'dAnchorX', 'dAnchorY',
  'aFrame', 'aAccum', 'aLastTex',
  'tProxy', 'tSheets', 'tFrameCount', 'tFrameStart', 'tAnims', 'tFrameW', 'tFrameH', 'tFrames',
  'qX', 'qY', 'qScaleX', 'qScaleY', 'qRotC', 'qRotS', 'qAlpha', 'qTint', 'qTexture', 'qAnchorX', 'qAnchorY',
  'qType', 'qSortKey', 'qRepeatX', 'qRepeatY', 'qTileMode', 'qTileOffU', 'qTileOffV', 'qTileMulX',
  'qTileMulY', 'qShadowH', 'qShadowOffX', 'qShadowOffY',
  'rEnds', 'rWarns', 'rForeign', 'rCounts',
  'sDirty', 'pType', 'pEntity', 'pFrame', 'pAnim', 'aEntities',
];
if (EMIT_SLOTS.length > EMIT_TABLE_SLOTS) throw new Error('preRenderEmit: the column table outgrew its region');
const SLOT = Object.fromEntries(EMIT_SLOTS.map((name, k) => [name, k]));

/** emit_rows's flags: emitSpriteQueue's loop invariants. */
export const EMIT_SORT_KEY = 1;
export const EMIT_Y_SORT = 2;
export const EMIT_TILES_DIRTY = 4;
export const EMIT_BOUNDS = 8;
/** What JS reads back from emit_rows when it declined the frame (u32 0xffffffff as an i32). */
export const EMIT_DECLINED = -1;
/** What persist_check returns when the rows are not the ones the buffer last held (W4c). */
export const EMIT_PERSIST_MISS = -1;
/** Warning kinds in the warns list. */
export const EMIT_WARN_NO_ANIM = 0;
export const EMIT_WARN_NO_START = 1;
export const EMIT_WARN_DECO_START = 2;

/** The component columns the kernel reads, by slot: [slot, component field]. */
export const EMIT_SPRITE_COLUMNS = [
  ['sScaleX', 'scaleX'], ['sScaleY', 'scaleY'], ['sAlpha', 'alpha'], ['sTint', 'tint'], ['sAnchorX', 'anchorX'],
  ['sAnchorY', 'anchorY'], ['sInherit', 'inheritTransformRotation'], ['sRotC', 'spriteRotC'], ['sRotS', 'spriteRotS'],
  ['sRepeatX', 'repeatX'], ['sRepeatY', 'repeatY'], ['sTileMode', 'tileMode'], ['sTileOffU', 'tileOffsetU'],
  ['sTileOffV', 'tileOffsetV'], ['sHalfW', 'boundsHalfW'], ['sHalfH', 'boundsHalfH'], ['sSheet', 'spritesheetId'],
  ['sAnim', 'animationState'], ['sAnimated', 'isAnimated'], ['sSpeed', 'animationSpeed'], ['sLoop', 'loop'],
];
export const EMIT_CASTER_COLUMNS = [['scActive', 'active'], ['scH', 'heightMultiplier'], ['scOffX', 'anchorOffsetX'], ['scOffY', 'anchorOffsetY']];
export const EMIT_DECORATION_COLUMNS = [
  ['dScaleX', 'scaleX'], ['dScaleY', 'scaleY'], ['dAlpha', 'alpha'], ['dTint', 'tint'], ['dTexture', 'textureId'],
  ['dAnchorX', 'anchorX'], ['dAnchorY', 'anchorY'],
];
/** The queue columns the kernel writes, by slot: [slot, pre-render field]. */
export const EMIT_QUEUE_COLUMNS = [
  ['qX', 'renderQueueX'], ['qY', 'renderQueueY'], ['qScaleX', 'renderQueueScaleX'], ['qScaleY', 'renderQueueScaleY'],
  ['qRotC', 'renderQueueRotC'], ['qRotS', 'renderQueueRotS'], ['qAlpha', 'renderQueueAlpha'], ['qTint', 'renderQueueTint'],
  ['qTexture', 'renderQueueTextureId'], ['qAnchorX', 'renderQueueAnchorX'], ['qAnchorY', 'renderQueueAnchorY'],
];
/** Queue columns pre-render may not have (0 in the table, the kernel skips them). */
export const EMIT_OPTIONAL_QUEUE_COLUMNS = [
  ['qType', 'renderQueueType'], ['qSortKey', 'renderQueueSortKey'], ['qRepeatX', 'renderQueueRepeatX'],
  ['qRepeatY', 'renderQueueRepeatY'], ['qTileMode', 'renderQueueTileMode'], ['qTileOffU', 'renderQueueTileOffsetU'],
  ['qTileOffV', 'renderQueueTileOffsetV'], ['qTileMulX', 'renderQueueTileMulX'], ['qTileMulY', 'renderQueueTileMulY'],
  ['qShadowH', 'renderQueueShadowH'], ['qShadowOffX', 'renderQueueShadowOffX'], ['qShadowOffY', 'renderQueueShadowOffY'],
];

/**
 * Bind the kernel to the render-queue memory.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} emit createRenderQueueMemory's layout.emit
 */
export async function bindPreRenderEmit(memory, emit) {
  const k = await loadWasmKernel('preRenderEmit', wasmUrl, memory, ['emit_rows', 'persist_check', 'persist_poses', 'persist_remember']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, emit.tableByte, EMIT_SLOTS.length);
  table[SLOT.rEnds] = emit.endsByte;
  table[SLOT.rWarns] = emit.warnsByte;
  table[SLOT.rForeign] = emit.foreignByte;
  table[SLOT.rCounts] = emit.resultsByte;
  table[SLOT.tProxy] = emit.proxyByte;
  table[SLOT.tFrameCount] = emit.frameCountByte;
  table[SLOT.tFrameStart] = emit.frameStartByte;
  table[SLOT.tFrameW] = emit.frameWidthByte;
  table[SLOT.tFrameH] = emit.frameHeightByte;
  return {
    buffer,
    emitRows: k.emit_rows,
    persistCheck: k.persist_check,
    persistPoses: k.persist_poses,
    persistRemember: k.persist_remember,
    layout: emit,
    table,
    tableByte: emit.tableByte,
    results: new Uint32Array(buffer, emit.resultsByte, 4),
    // The lists are read by index up to the counts in results.
    u32: new Uint32Array(buffer),
    endsAt: emit.endsByte >> 2,
    warnsAt: emit.warnsByte >> 2,
    foreignAt: emit.foreignByte >> 2,
    texturesReady: false,
  };
}

/**
 * The table slot for `view`: its byte offset in the kernel's memory. An optional column the worker does
 * not have is 0 (the kernel skips it). False for a column the kernel cannot read: a required one that is
 * missing, or any one that lives in another buffer.
 */
function putSlot(b, slot, view, optional) {
  if (view && view.buffer === b.buffer) {
    b.table[SLOT[slot]] = view.byteOffset;
    return true;
  }
  if (!optional || view) return false;
  b.table[SLOT[slot]] = 0;
  return true;
}

/**
 * Write the column table from the current views: the components' static fields, pre-render's queue
 * buffer of this frame, its collector and animation state. Every call (the queue buffer alternates, a
 * scene may rebind its components); a few dozen stores against a whole frame of rows.
 * @returns {boolean} false when a column the kernel needs is not in the memory: the JS emits the frame
 */
export function writeEmitColumns(b, w, SpriteRenderer, ShadowCaster, DecorationComponent, source) {
  if (!putSlot(b, 'cType', source.collectorType) || !putSlot(b, 'cIndex', source.collectorIndex) || !putSlot(b, 'cY', source.collectorY)) return false;
  if (!putSlot(b, 'stashX', source.stashX) || !putSlot(b, 'stashY', source.stashY) || !putSlot(b, 'stashRc', source.stashRotC) || !putSlot(b, 'stashRs', source.stashRotS)) return false;
  for (let k = 0; k < EMIT_SPRITE_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_SPRITE_COLUMNS[k][0], SpriteRenderer[EMIT_SPRITE_COLUMNS[k][1]])) return false;
  }
  if (!putSlot(b, 'sZ', SpriteRenderer.zIndex, true)) return false;
  // ShadowCaster and decorations are optional as a whole: a scene without them has neither columns nor rows.
  for (let k = 0; k < EMIT_CASTER_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_CASTER_COLUMNS[k][0], ShadowCaster[EMIT_CASTER_COLUMNS[k][1]], true)) return false;
  }
  for (let k = 0; k < EMIT_DECORATION_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_DECORATION_COLUMNS[k][0], DecorationComponent[EMIT_DECORATION_COLUMNS[k][1]], true)) return false;
  }
  if (!putSlot(b, 'aFrame', w.entityFrameIndex) || !putSlot(b, 'aAccum', w.entityFrameAccumulator)) return false;
  b.table[SLOT.aEntities] = w.entityFrameIndex.length;
  if (!putSlot(b, 'aLastTex', w.entityLastTextureId, true)) return false;
  for (let k = 0; k < EMIT_QUEUE_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_QUEUE_COLUMNS[k][0], w[EMIT_QUEUE_COLUMNS[k][1]])) return false;
  }
  for (let k = 0; k < EMIT_OPTIONAL_QUEUE_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_OPTIONAL_QUEUE_COLUMNS[k][0], w[EMIT_OPTIONAL_QUEUE_COLUMNS[k][1]], true)) return false;
  }
  return true;
}

/**
 * W4c. The persist path's columns, after writeEmitColumns: the rows queue buffer `buf` last held (pre-render's
 * _persistType, _persistEntity, _persistFrame and _persistAnim of that buffer) and the sprites' dirty flags.
 * @returns {boolean} false when one is not in the memory: the JS runs the persist path
 */
export function writePersistColumns(b, w, SpriteRenderer, buf) {
  return putSlot(b, 'pType', w._persistType[buf]) && putSlot(b, 'pEntity', w._persistEntity[buf])
    && putSlot(b, 'pFrame', w._persistFrame[buf]) && putSlot(b, 'pAnim', w._persistAnim[buf])
    && putSlot(b, 'sDirty', SpriteRenderer.renderDirty, true);
}

/**
 * The texture metadata as the kernel's tables: proxyToGlobalAnim[sheet][state] flattened, the frame
 * count and first frame per global animation, the frame sizes. Called when the metadata arrives.
 * @returns {boolean} false when the metadata does not fit the tables (the JS keeps the emit)
 */
export function writeEmitTextures(b, meta) {
  b.texturesReady = false;
  const L = b.layout;
  const t = b.table;
  const proxy = new Int32Array(b.buffer, L.proxyByte, EMIT_PROXY_SHEETS * EMIT_PROXY_STATES);
  proxy.fill(-1);
  t[SLOT.tSheets] = 0;
  t[SLOT.tAnims] = 0;
  t[SLOT.tFrames] = 0;
  if (!meta) return false;
  const starts = meta.animationFrameStart || [];
  const counts = meta.animationFrameCount || [];
  const anims = starts.length;
  if (anims > EMIT_MAX_ANIMATIONS || counts.length !== anims) return false;
  const width = meta.frameWidth || null;
  const height = meta.frameHeight || null;
  const frames = width && height ? Math.min(width.length, height.length) : 0;
  if (frames > EMIT_MAX_FRAMES) return false;
  for (let g = 0; g < anims; g++) {
    // The JS reads a hole as undefined; the kernel has no hole, so such metadata stays JS.
    if (!Number.isInteger(starts[g]) || !Number.isInteger(counts[g])) return false;
  }
  let sheets = 0;
  for (const [sheetKey, states] of Object.entries(meta.proxyToGlobalAnim || {})) {
    const sheet = Number(sheetKey);
    if (!Number.isInteger(sheet) || sheet < 0 || sheet >= EMIT_PROXY_SHEETS) return false;
    for (const [stateKey, g] of Object.entries(states || {})) {
      const state = Number(stateKey);
      if (!Number.isInteger(state) || state < 0 || state >= EMIT_PROXY_STATES) continue;
      if (!Number.isInteger(g) || g < 0) return false;
      proxy[sheet * EMIT_PROXY_STATES + state] = g;
    }
    if (sheet + 1 > sheets) sheets = sheet + 1;
  }
  new Int32Array(b.buffer, L.frameCountByte, anims).set(counts);
  new Int32Array(b.buffer, L.frameStartByte, anims).set(starts);
  if (frames > 0) {
    new Uint16Array(b.buffer, L.frameWidthByte, frames).set(width.subarray(0, frames));
    new Uint16Array(b.buffer, L.frameHeightByte, frames).set(height.subarray(0, frames));
  }
  t[SLOT.tSheets] = sheets;
  t[SLOT.tAnims] = anims;
  t[SLOT.tFrames] = frames;
  b.texturesReady = true;
  return true;
}
