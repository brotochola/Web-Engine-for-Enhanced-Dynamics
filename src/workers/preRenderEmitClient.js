// The WASM emit (E-76 W4a, E-112): loads preRenderEmit.wasm onto the render-queue memory, where the scene
// keeps every column pre-render's emit reads (the SpriteRenderer, ShadowCaster and DecorationComponent
// blocks, both queue buffers, the collector, the animation state; see renderQueueMemoryRegions). emit_rows
// writes the full emit's sprite and decoration rows with the JS's bits (W4d: the bullet and trail rows too, when
// BulletComponent is in the memory, writeEmitBulletColumns; the glow rows when LightEmitter is, writeEmitGlowColumns; the
// particle rows when ParticleComponent is, writeEmitParticleColumns; the LiquidFun rows when its render buffer is,
// writeEmitLiquidFunColumns); the rows of other types, the play-once ends and the
// missing textures come back as lists, and pre-render acts on them in JS.
// W4c: persist_frame (the check and the poses-only pass in one walk, E-116) and persist_remember are the
// entity queue's persist path, on the same table with the rows each queue buffer last held
// (writePersistColumns).
// W27: with the Adobe regions, emit_rows also expands Adobe Animate roots into their pieces, from
// AdobeAnimComponent (writeEmitAdobeColumns) and a copy of the registry's assets (writeEmitAdobeAssets), and
// adobe_advance advances their clips (advanceAdobeAnimations).

import { loadWasmKernel } from '../util/wasmKernel.js';
import {
  EMIT_ADOBE_ASSET_BYTES, EMIT_ADOBE_MAX_ASSETS, EMIT_PROXY_SHEETS, EMIT_PROXY_STATES, EMIT_MAX_ANIMATIONS, EMIT_MAX_FRAMES,
  EMIT_PARAM_DOUBLES, EMIT_TABLE_SLOTS,
} from '../util/wasmMemoryMap.js';
import { engineWasmUrl } from '../wasm/engine.js';


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
  'aaActive', 'aaPlaying', 'aaRate', 'aaTime', 'aaLoop', 'aaAsset', 'aaClip',
  'aaScaleX', 'aaScaleY', 'aaAnchorX', 'aaAnchorY', 'aaRotC', 'aaRotS', 'aaAlpha', 'aaTint',
  'adDir', 'adAssets', 'adList',
  'bActive', 'bX', 'bY', 'bStartX', 'bStartY', 'bOffsetY', 'bScale', 'bAlpha', 'bTint', 'bTexture',
  'bSpriteRotC', 'bSpriteRotS', 'bRotC', 'bRotS', 'bTrailWidth', 'bAnchorX', 'bAnchorY', 'bTrailTexture',
  'lColor', 'lIntensity', 'lSqrt', 'lGlowOffset', 'lGlow', 'tX', 'tY', 'lGradientTexture',
  'pcX', 'pcY', 'pcZ', 'pcScaleX', 'pcScaleY', 'pcFlipX', 'pcFlipY', 'pcRotC', 'pcRotS', 'pcAlpha', 'pcTint',
  'pcTexture', 'pcFlat', 'pcView', 'pcWhiteTexture', 'eParams',
  'lfX', 'lfY', 'lfScaleX', 'lfScaleY', 'lfAlpha', 'lfBaseAlpha', 'lfRotC', 'lfRotS', 'lfTint', 'lfTexture',
  'lfPrevX', 'lfPrevY', 'lfPrevCount',
];
if (EMIT_SLOTS.length > EMIT_TABLE_SLOTS) throw new Error('preRenderEmit: the column table outgrew its region');
const SLOT = Object.fromEntries(EMIT_SLOTS.map((name, k) => [name, k]));

/** emit_rows's flags: emitSpriteQueue's loop invariants. */
export const EMIT_SORT_KEY = 1;
export const EMIT_Y_SORT = 2;
export const EMIT_TILES_DIRTY = 4;
export const EMIT_BOUNDS = 8;
/** persist_frame's flag for a scene without ShadowCaster (E-117): the shadow terms stay the full emit's zeros. */
export const EMIT_NO_CASTERS = 16;
/** E-138: a presorted frame's emit_rows leaves the sort keys and the shadow terms, which nothing reads that frame. */
export const EMIT_PRESORTED = 64;
/** A persist frame's emit_rows: every row but the sprites, which persist_frame (or the JS persist path) wrote. */
export const EMIT_OTHERS_ONLY = 128;
/** What JS reads back from emit_rows when it declined the frame (u32 0xffffffff as an i32). */
export const EMIT_DECLINED = -1;
/** What persist_frame returns when the rows are not the ones the buffer last held (W4c). */
export const EMIT_PERSIST_MISS = -1;
/** Warning kinds in the warns list. */
export const EMIT_WARN_NO_ANIM = 0;
export const EMIT_WARN_NO_START = 1;
export const EMIT_WARN_DECO_START = 2;
export const EMIT_WARN_BULLET_START = 3;
export const EMIT_WARN_PARTICLE_START = 4;
export const EMIT_WARN_LF_START = 5;

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
/** W27: AdobeAnimComponent's columns the kernel reads (and adobe_advance writes), by slot. */
export const EMIT_ADOBE_COLUMNS = [
  ['aaActive', 'active'], ['aaPlaying', 'playing'], ['aaRate', 'playbackRate'], ['aaTime', 'time'], ['aaLoop', 'loop'],
  ['aaAsset', 'assetId'], ['aaClip', 'clipId'], ['aaScaleX', 'scaleX'], ['aaScaleY', 'scaleY'], ['aaAnchorX', 'anchorX'],
  ['aaAnchorY', 'anchorY'], ['aaRotC', 'rotC'], ['aaRotS', 'rotS'], ['aaAlpha', 'alpha'], ['aaTint', 'tint'],
];
/** W4d: BulletComponent's columns the bullet and trail rows read, by slot (a trail starts at startX, startY). */
export const EMIT_BULLET_COLUMNS = [
  ['bActive', 'active'], ['bX', 'x'], ['bY', 'y'], ['bStartX', 'startX'], ['bStartY', 'startY'], ['bOffsetY', 'offsetY'],
  ['bScale', 'scale'], ['bAlpha', 'alpha'], ['bTint', 'tint'], ['bTexture', 'textureId'], ['bSpriteRotC', 'spriteRotC'],
  ['bSpriteRotS', 'spriteRotS'], ['bRotC', 'bulletRotC'], ['bRotS', 'bulletRotS'], ['bTrailWidth', 'trailWidth'],
  ['bAnchorX', 'anchorX'], ['bAnchorY', 'anchorY'],
];
/** The glow rows' LightEmitter columns, by slot; with Transform's x and y (tX, tY) of the light's entity. */
export const EMIT_GLOW_COLUMNS = [
  ['lColor', 'lightColor'], ['lIntensity', 'lightIntensity'], ['lSqrt', 'sqrtLightIntensity'],
  ['lGlowOffset', 'glowHeightOffset'], ['lGlow', 'hasGlowSprite'],
];
/** The particle rows' ParticleComponent columns, by slot; flat and viewMode may be missing (emitSpriteQueue tests them). */
export const EMIT_PARTICLE_COLUMNS = [
  ['pcX', 'x'], ['pcY', 'y'], ['pcZ', 'z'], ['pcScaleX', 'scaleX'], ['pcScaleY', 'scaleY'], ['pcFlipX', 'flipX'],
  ['pcFlipY', 'flipY'], ['pcRotC', 'rotC'], ['pcRotS', 'rotS'], ['pcAlpha', 'alpha'], ['pcTint', 'tint'], ['pcTexture', 'textureId'],
];
export const EMIT_PARTICLE_OPTIONAL_COLUMNS = [['pcFlat', 'flat'], ['pcView', 'viewMode']];
/** The LiquidFun rows' render buffer columns, by slot (pre-render's liquidFun views; baseAlpha may be missing). */
export const EMIT_LF_COLUMNS = [
  ['lfX', 'x'], ['lfY', 'y'], ['lfScaleX', 'scaleX'], ['lfScaleY', 'scaleY'], ['lfAlpha', 'alpha'], ['lfRotC', 'rotC'],
  ['lfRotS', 'rotS'], ['lfTint', 'tint'], ['lfTexture', 'textureId'],
];
/** W27: what an asset directory record says of its asset (preRenderEmit.c ASSET_*): none (or one the tables could not take), in them. */
export const EMIT_ADOBE_NONE = 0;
export const EMIT_ADOBE_IN = 1;
/** The record's u32 words (preRenderEmit.c AdobeAsset); its four doubles start at word 32. */
const REC = {
  kind: 0, clipStartLen: 1, clipStart: 2, clipCountLen: 3, clipCount: 4, clipRateLen: 5, clipRate: 6,
  minXLen: 7, minX: 8, minYLen: 9, minY: 10, maxXLen: 11, maxX: 12, maxYLen: 13, maxY: 14,
  frames: 15, frameStart: 16, frameCount: 17, pieces: 18,
  px: 19, py: 20, psx: 21, psy: 22, prc: 23, prs: 24, palpha: 25, pax: 26, pay: 27, ptex: 28,
};
const REC_WORDS = EMIT_ADOBE_ASSET_BYTES / 4;
const REC_BOUNDS_DOUBLE = 16;

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
  const k = await loadWasmKernel('preRenderEmit', engineWasmUrl, memory, ['emit_rows', 'persist_frame', 'persist_remember', 'adobe_advance']);
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
  table[SLOT.eParams] = emit.paramsByte;
  return {
    buffer,
    emitRows: k.emit_rows,
    persistFrame: k.persist_frame,
    persistRemember: k.persist_remember,
    adobeAdvance: k.adobe_advance,
    layout: emit,
    table,
    tableByte: emit.tableByte,
    // The emit's doubles (E_PARAMS), written with the particle columns.
    params: new Float64Array(buffer, emit.paramsByte, EMIT_PARAM_DOUBLES),
    // [ends, warnings, a tiled sprite, rows left to the JS, an Adobe expansion past the queue's end].
    results: new Uint32Array(buffer, emit.resultsByte, 8),
    // The lists are read by index up to the counts in results.
    u32: new Uint32Array(buffer),
    endsAt: emit.endsByte >> 2,
    warnsAt: emit.warnsByte >> 2,
    foreignAt: emit.foreignByte >> 2,
    texturesReady: false,
    // The frame sizes' length in the kernel's copy (frameWidthByte, frameHeightByte), once written.
    frames: 0,
    // W27: the Adobe tables are bound (bindEmitAdobe); the directory holds the registry's assets
    // (writeEmitAdobeAssets), copied from this assetById array when it had this length; the directory's byte.
    adobe: false,
    adobeReady: false,
    adobeFrom: null,
    adobeAssets: 0,
    adobeDirByte: 0,
    // The frame's Adobe entities for adobe_advance (u32), which lists the ended clips' entities there after.
    adobeList: new Uint32Array(0),
    adobeListCap: 0,
  };
}

/**
 * W27. Bind the Adobe tables when the layout has them (a scene with AdobeAnimComponent). Until writeEmitAdobeAssets
 * copies the registry in, frames with an Adobe root are declined.
 * @returns {boolean} whether the layout has them
 */
export function bindEmitAdobe(b, emit) {
  if (!(emit.adobeAssetsByte >= 0) || !(emit.adobeListByte >= 0)) return false;
  b.adobe = true;
  b.table[SLOT.adList] = emit.adobeListByte;
  b.adobeList = new Uint32Array(b.buffer, emit.adobeListByte, emit.entities);
  b.adobeListCap = emit.entities;
  return true;
}

/**
 * W27. AdobeAnimComponent's columns in this frame's table, and the asset directory when it is ready and `ok`
 * (the caller's own conditions); else the directory slot is 0 and the kernel declines a frame with an Adobe root.
 * @returns {boolean} whether the kernel can expand roots this frame
 */
export function writeEmitAdobeColumns(b, AdobeAnimComponent, ok) {
  let ready = ok && b.adobeReady;
  for (let k = 0; k < EMIT_ADOBE_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_ADOBE_COLUMNS[k][0], AdobeAnimComponent[EMIT_ADOBE_COLUMNS[k][1]])) ready = false;
  }
  b.table[SLOT.adDir] = ready ? b.adobeDirByte : 0;
  return ready;
}

/**
 * An asset array's length (0 when it is absent), or -1 when it is no array of numbers. A typed array of another
 * class or a plain array (an asset built by hand) is copied into the class the compiler makes, its values as that
 * class stores them.
 */
function arrayLength(a) {
  if (a === undefined || a === null) return 0;
  return ArrayBuffer.isView(a) || Array.isArray(a) ? a.length : -1;
}

/**
 * What the tables need of one asset: the lengths of its arrays and the bytes they take, or null when it is
 * malformed (an array that is not one, frame lists of two lengths, pieces past the piece arrays, bounds that are
 * not numbers): its characters are then not drawn, and pre-render says so.
 */
function planAsset(asset) {
  const L = {
    clipStart: arrayLength(asset.clipFrameStart),
    clipCount: arrayLength(asset.clipFrameCount),
    clipRate: arrayLength(asset.clipFrameRate),
    minX: arrayLength(asset.clipBoundsMinX),
    minY: arrayLength(asset.clipBoundsMinY),
    maxX: arrayLength(asset.clipBoundsMaxX),
    maxY: arrayLength(asset.clipBoundsMaxY),
    frameStart: arrayLength(asset.framePieceStart),
    frameCount: arrayLength(asset.framePieceCount),
  };
  for (const n of Object.values(L)) if (n < 0) return null;
  // framePieceCount?.[f] ?? 0 and framePieceStart?.[f] ?? 0 are read apart in the JS: one length for both.
  const frames = L.frameCount;
  if (frames > 0 && L.frameStart !== frames) return null;
  let pieces = 0;
  for (let f = 0; f < frames; f++) {
    const end = asset.framePieceStart[f] + asset.framePieceCount[f];
    if (end > pieces) pieces = end;
  }
  const bounds = [asset.assetBoundsMinX ?? 0, asset.assetBoundsMinY ?? 0, asset.assetBoundsMaxX ?? 0, asset.assetBoundsMaxY ?? 0];
  if (bounds.some((v) => typeof v !== 'number')) return null;
  if (pieces > 0) {
    for (const name of ['pieceX', 'pieceY', 'pieceScaleX', 'pieceScaleY', 'pieceAlpha', 'pieceAnchorX', 'pieceAnchorY']) {
      if (!(arrayLength(asset[name]) >= pieces)) return null;
    }
    if (!(arrayLength(asset.pieceTextureId) >= pieces)) return null;
    // pieceRotC ? pieceRotC[p] : Math.cos(pieceRotation[p]), and the same for the sine (an empty array is truthy).
    const rotation = arrayLength(asset.pieceRotation) >= pieces;
    for (const name of ['pieceRotC', 'pieceRotS']) {
      if (asset[name] == null ? !rotation : !(arrayLength(asset[name]) >= pieces)) return null;
    }
  }
  const line = (bytes) => Math.ceil(bytes / 8) * 8;
  const clips = line(L.clipStart * 4) + line(L.clipCount * 2) + line(L.clipRate * 4)
    + line(L.minX * 4) + line(L.minY * 4) + line(L.maxX * 4) + line(L.maxY * 4);
  const bytes = clips + line(frames * 4) + line(frames * 2) + 7 * line(pieces * 4) + 2 * pieces * 8 + line(pieces * 2);
  return { L, frames, pieces, bounds, bytes };
}

/**
 * W27. Copy the registry's assets (AdobeAnimRegistry.assetById) into the asset directory and the tables after
 * it, every array as the kernel reads it: the piece rotations as doubles (an asset without pieceRotC/pieceRotS
 * gets Math.cos/Math.sin of pieceRotation, as the JS emit computes them). An asset that does not fit, that
 * planAsset turns down, or past the directory's ids is left out: its roots draw nothing and its clocks stand,
 * and the caller reports it. Called when pre-render binds the kernel and whenever the registry's array changes.
 * @param {Array<object | null | undefined>} assets by asset id
 * @returns {Array<{ name: string, bytes: number, reason: 'room' | 'malformed' | 'ids' }>} the assets left out
 */
export function writeEmitAdobeAssets(b, assets) {
  const L = b.layout;
  const dirByte = L.adobeAssetsByte;
  const dirBytes = EMIT_ADOBE_MAX_ASSETS * EMIT_ADOBE_ASSET_BYTES;
  const words = new Uint32Array(b.buffer, dirByte, dirBytes / 4);
  const doubles = new Float64Array(b.buffer, dirByte, dirBytes / 8);
  words.fill(0);
  b.adobeFrom = assets;
  b.adobeAssets = assets.length;
  b.adobeReady = false;
  b.adobeDirByte = dirByte;
  b.table[SLOT.adDir] = 0;
  b.table[SLOT.adAssets] = 0;
  const skipped = [];
  const ids = Math.min(assets.length, EMIT_ADOBE_MAX_ASSETS);
  if (assets.length > EMIT_ADOBE_MAX_ASSETS) {
    skipped.push({ name: `${assets.length - EMIT_ADOBE_MAX_ASSETS} assets past id ${EMIT_ADOBE_MAX_ASSETS - 1}`, bytes: 0, reason: 'ids' });
  }
  const buffer = b.buffer;
  const end = dirByte + L.adobeAssetsBytes;
  let at = dirByte + dirBytes;
  /** The first `n` values of a typed or a plain array. */
  const first = (src, n) => (ArrayBuffer.isView(src) ? src.subarray(0, n) : src.slice(0, n));
  /** Copy `src`'s first `n` values as `Ctor` at the next free byte; returns that byte (0 for an empty array). */
  const put = (Ctor, src, n) => {
    if (n === 0) return 0;
    const byte = at;
    new Ctor(buffer, byte, n).set(first(src, n));
    at += Math.ceil((n * Ctor.BYTES_PER_ELEMENT) / 8) * 8;
    return byte;
  };
  /** The piece rotation column: the prebaked one widened, or the trig of pieceRotation. */
  const putRotation = (baked, rotation, n, trig) => {
    if (n === 0) return 0;
    const byte = at;
    const dst = new Float64Array(buffer, byte, n);
    if (baked != null) dst.set(first(baked, n));
    else for (let p = 0; p < n; p++) dst[p] = trig(rotation[p]);
    at += n * 8;
    return byte;
  };
  for (let id = 0; id < ids; id++) {
    const asset = assets[id];
    if (!asset) continue;
    const r = id * REC_WORDS;
    const plan = planAsset(asset);
    // Left at none (the directory was cleared).
    if (!plan) {
      skipped.push({ name: String(asset.name ?? id), bytes: 0, reason: 'malformed' });
      continue;
    }
    if (at + plan.bytes > end) {
      skipped.push({ name: String(asset.name ?? id), bytes: plan.bytes, reason: 'room' });
      continue;
    }
    const { L: n, frames, pieces } = plan;
    words[r + REC.clipStartLen] = n.clipStart;
    words[r + REC.clipStart] = put(Uint32Array, asset.clipFrameStart, n.clipStart);
    words[r + REC.clipCountLen] = n.clipCount;
    words[r + REC.clipCount] = put(Uint16Array, asset.clipFrameCount, n.clipCount);
    words[r + REC.clipRateLen] = n.clipRate;
    words[r + REC.clipRate] = put(Float32Array, asset.clipFrameRate, n.clipRate);
    words[r + REC.minXLen] = n.minX;
    words[r + REC.minX] = put(Float32Array, asset.clipBoundsMinX, n.minX);
    words[r + REC.minYLen] = n.minY;
    words[r + REC.minY] = put(Float32Array, asset.clipBoundsMinY, n.minY);
    words[r + REC.maxXLen] = n.maxX;
    words[r + REC.maxX] = put(Float32Array, asset.clipBoundsMaxX, n.maxX);
    words[r + REC.maxYLen] = n.maxY;
    words[r + REC.maxY] = put(Float32Array, asset.clipBoundsMaxY, n.maxY);
    words[r + REC.frames] = frames;
    words[r + REC.frameStart] = put(Uint32Array, asset.framePieceStart, frames);
    words[r + REC.frameCount] = put(Uint16Array, asset.framePieceCount, frames);
    words[r + REC.pieces] = pieces;
    words[r + REC.px] = put(Float32Array, asset.pieceX, pieces);
    words[r + REC.py] = put(Float32Array, asset.pieceY, pieces);
    words[r + REC.psx] = put(Float32Array, asset.pieceScaleX, pieces);
    words[r + REC.psy] = put(Float32Array, asset.pieceScaleY, pieces);
    words[r + REC.prc] = putRotation(asset.pieceRotC, asset.pieceRotation, pieces, Math.cos);
    words[r + REC.prs] = putRotation(asset.pieceRotS, asset.pieceRotation, pieces, Math.sin);
    words[r + REC.palpha] = put(Float32Array, asset.pieceAlpha, pieces);
    words[r + REC.pax] = put(Float32Array, asset.pieceAnchorX, pieces);
    words[r + REC.pay] = put(Float32Array, asset.pieceAnchorY, pieces);
    words[r + REC.ptex] = put(Uint16Array, asset.pieceTextureId, pieces);
    doubles.set(plan.bounds, r / 2 + REC_BOUNDS_DOUBLE);
    words[r + REC.kind] = EMIT_ADOBE_IN;
  }
  b.table[SLOT.adAssets] = ids;
  b.adobeReady = true;
  return skipped;
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
 * W4d. BulletComponent's columns and the trail's texture, after writeEmitColumns: all of them in the memory (the
 * bullet pool in the engine block, W19), or bActive 0 and emit_rows lists the bullet and trail rows for the JS.
 * @param {number} trailTexture the trail's first frame (_resolveBuiltinTextureId('_bulletTrail'))
 * @returns {boolean} whether the kernel writes the bullet and trail rows this frame
 */
export function writeEmitBulletColumns(b, BulletComponent, trailTexture) {
  for (let k = 0; k < EMIT_BULLET_COLUMNS.length; k++) {
    if (!putSlot(b, EMIT_BULLET_COLUMNS[k][0], BulletComponent[EMIT_BULLET_COLUMNS[k][1]])) {
      b.table[SLOT.bActive] = 0;
      return false;
    }
  }
  b.table[SLOT.bTrailTexture] = trailTexture;
  return true;
}

/**
 * The glow rows' columns and the gradient's texture, after writeEmitColumns: LightEmitter's (in the emit's blocks)
 * and Transform's x and y (in the collect's), all in the memory, or lColor 0 and emit_rows lists the glow rows for
 * the JS.
 * @param {number} gradientTexture the glow's texture (_resolveBuiltinTextureId('_lightGradient'))
 * @returns {boolean} whether the kernel writes the glow rows this frame
 */
export function writeEmitGlowColumns(b, LightEmitter, Transform, gradientTexture) {
  let ok = putSlot(b, 'tX', Transform.x) && putSlot(b, 'tY', Transform.y);
  for (let k = 0; ok && k < EMIT_GLOW_COLUMNS.length; k++) ok = putSlot(b, EMIT_GLOW_COLUMNS[k][0], LightEmitter[EMIT_GLOW_COLUMNS[k][1]]);
  b.table[SLOT.lGradientTexture] = gradientTexture;
  if (!ok) b.table[SLOT.lColor] = 0;
  return ok;
}

/**
 * The particle rows' columns, their default texture and the zenithal terms, after writeEmitColumns: ParticleComponent
 * in the memory (the particle memory placed in it), or pcX 0 and emit_rows lists the particle rows for the JS.
 * @param {number} whiteTexture a particle's texture when its textureId is 0 (_resolveBuiltinTextureId('_whiteCircle'))
 * @param {number} maxHeight pre-render's zenithalMaxHeight
 * @param {number} scaleFactor zenithalScaleFactor
 * @param {number} alphaFade zenithalAlphaFade
 * @returns {boolean} whether the kernel writes the particle rows this frame
 */
export function writeEmitParticleColumns(b, ParticleComponent, whiteTexture, maxHeight, scaleFactor, alphaFade) {
  let ok = true;
  for (let k = 0; ok && k < EMIT_PARTICLE_COLUMNS.length; k++) ok = putSlot(b, EMIT_PARTICLE_COLUMNS[k][0], ParticleComponent[EMIT_PARTICLE_COLUMNS[k][1]]);
  for (let k = 0; ok && k < EMIT_PARTICLE_OPTIONAL_COLUMNS.length; k++) {
    ok = putSlot(b, EMIT_PARTICLE_OPTIONAL_COLUMNS[k][0], ParticleComponent[EMIT_PARTICLE_OPTIONAL_COLUMNS[k][1]], true);
  }
  b.table[SLOT.pcWhiteTexture] = whiteTexture;
  b.params[0] = maxHeight;
  b.params[1] = scaleFactor;
  b.params[2] = alphaFade;
  if (!ok) b.table[SLOT.pcX] = 0;
  return ok;
}

/**
 * The LiquidFun rows' columns, after writeEmitColumns: the render buffer's (`lf`, pre-render's liquidFun views; x, y
 * and alpha may view LiquidFun's heap) and the previous positions, all in the memory, or lfX 0 and emit_rows declines
 * a frame with a LiquidFun row.
 * @param {null | Record<string, ArrayBufferView>} lf
 * @param {Float32Array | null} prevX pre-render's _prevLfX
 * @param {Float32Array | null} prevY _prevLfY
 * @param {number} prevCount the rows to interpolate from prevX and prevY (0: none)
 * @param {number} poseAlpha the interpolation's alpha (_poseAlpha)
 * @param {number} whiteTexture a particle's texture when its textureId is 0
 * @returns {boolean} whether the kernel writes the LiquidFun rows this frame
 */
export function writeEmitLiquidFunColumns(b, lf, prevX, prevY, prevCount, poseAlpha, whiteTexture) {
  let ok = !!lf;
  for (let k = 0; ok && k < EMIT_LF_COLUMNS.length; k++) ok = putSlot(b, EMIT_LF_COLUMNS[k][0], lf[EMIT_LF_COLUMNS[k][1]]);
  if (ok) ok = putSlot(b, 'lfBaseAlpha', lf.baseAlpha, true);
  // Without interpolation the previous positions are not read: no slots, no rows to interpolate. With it they must
  // be in the memory too, or the JS takes the frame.
  if (ok && prevCount > 0) {
    ok = putSlot(b, 'lfPrevX', prevX) && putSlot(b, 'lfPrevY', prevY);
  } else {
    b.table[SLOT.lfPrevX] = 0;
    b.table[SLOT.lfPrevY] = 0;
  }
  b.table[SLOT.lfPrevCount] = ok ? prevCount : 0;
  b.table[SLOT.pcWhiteTexture] = whiteTexture;
  b.params[3] = poseAlpha;
  if (!ok) b.table[SLOT.lfX] = 0;
  return ok;
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
  b.frames = 0;
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
  b.frames = frames;
  b.texturesReady = true;
  return true;
}
