// The WASM instanced-row pack (E-76 W9): loads gpuPack.wasm onto the render-queue memory and packs
// sprite and caster rows as packInstancedRows does on its two fast paths (world space, no pixel
// snap, no type filter), with the same bits. The queue columns, the destination and the indices are
// views on that memory, so their byteOffsets are the kernel's addresses; indices kept elsewhere are
// copied into the memory's index scratch first. Anything else returns -1 and the caller packs in JS.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { GPU_CASTER_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_SPRITE_FLOATS } from './gpuQueueLayout.js';
import { engineWasmUrl } from '../wasm/engine.js';


/** Lists shorter than this pack by gathering: the scatter's inverse costs a pass over the queue. */
export const SCATTER_MIN_ROWS = 4096;

/** The queue columns the kernel reads, in its column-table order (wasm/gpuPack.c). */
export const GPU_PACK_COLUMNS = [
  'x', 'y', 'scaleX', 'scaleY', 'rotC', 'rotS', 'alpha', 'tint', 'textureId', 'anchorX', 'anchorY',
  'tileMulX', 'tileMulY', 'tileOffsetU', 'tileOffsetV', 'shadowH', 'shadowOffX', 'shadowOffY',
];

/**
 * Bind the kernel to the render-queue memory.
 * @param {WebAssembly.Memory} memory
 * @param {{ tableByte: number, tableSlots: number, indexByte: number, indexCap: number, particlesByte: number }} layout
 *   createRenderQueueMemory's layout: room for `tableSlots` column tables, an index scratch of
 *   `indexCap` u32, the scatter's inverse (`inverseByte`, one u32 per queue row; 0 for none) and one
 *   u32 for the particle count
 */
/** The doubles the general pack reads (wasm/gpuPack.c pack_general): flags, then the camera, snap and type values. */
const GENERAL_PARAMS = 16;

export async function bindGpuPack(memory, layout) {
  const k = await loadWasmKernel('gpuPack', engineWasmUrl, memory, [
    'pack_sprites', 'pack_casters', 'pack_sprites_scatter', 'pack_casters_scatter',
    'pack_sprites_split', 'pack_sprites_split_scatter', 'pack_sprites_general', 'pack_casters_general', 'pack_pose',
    'pack_sprites_indexed_scatter',
  ]);
  return {
    buffer: memory.buffer,
    sprites: k.pack_sprites,
    casters: k.pack_casters,
    spritesScatter: k.pack_sprites_scatter,
    castersScatter: k.pack_casters_scatter,
    spritesSplit: k.pack_sprites_split,
    spritesSplitScatter: k.pack_sprites_split_scatter,
    // E-162: the pose and the statics' row in draw order, the statics in the queue's row order.
    spritesIndexedScatter: k.pack_sprites_indexed_scatter,
    // Close-out group B: packInstancedRows' slow path (a type filter, screen space, pixel snap), its parameters 16
    // bytes into the results region (GENERAL_PARAMS doubles).
    spritesGeneral: k.pack_sprites_general,
    castersGeneral: k.pack_casters_general,
    // W9e: a pose batch's two streams (renderer.interpolation), on the same parameters.
    pose: k.pack_pose,
    params: new Float64Array(memory.buffer, layout.particlesByte + 16, GENERAL_PARAMS),
    paramsByte: layout.particlesByte + 16,
    inverseByte: layout.inverseByte | 0,
    u32: new Uint32Array(memory.buffer),
    tableByte: layout.tableByte,
    tableSlots: layout.tableSlots,
    tables: new Map(),
    used: 0,
    indexByte: layout.indexByte,
    indexCap: layout.indexCap,
    particlesByte: layout.particlesByte,
  };
}

/**
 * The byte offset of the column table for q's columns, written on first use; -1 when a column is
 * not in the memory or the tables are full. Keyed by the columns, not by q: pre-render reuses one
 * q object and points it at queue A or B each frame.
 */
function tableFor(b, q) {
  const cols = GPU_PACK_COLUMNS;
  const entry = b.tables.get(q.x);
  if (entry !== undefined) {
    let same = true;
    for (let c = 0; c < cols.length; c++) {
      if (entry.cols[c] !== q[cols[c]]) {
        same = false;
        break;
      }
    }
    if (same) return entry.at;
  }
  let at = -1;
  const ref = new Array(cols.length);
  for (let c = 0; c < cols.length; c++) {
    const v = q[cols[c]];
    if (!v || v.buffer !== b.buffer) return -1;
    ref[c] = v;
  }
  if (b.used < b.tableSlots) {
    at = b.tableByte + b.used * cols.length * 4;
    b.used++;
    const base = at >> 2;
    for (let c = 0; c < cols.length; c++) b.u32[base + c] = ref[c].byteOffset;
  }
  b.tables.set(q.x, { at, cols: ref });
  return at;
}

/**
 * The kernel's index list for ctx: its byte offset, 0 for none, or -1 when it does not fit the index
 * scratch. A list kept outside the memory is copied into the scratch.
 */
function indexByteFor(b, ctx, count, capacity) {
  if (!ctx.useIndices) return 0;
  const idx = ctx.indices;
  if (idx.buffer === b.buffer && idx.BYTES_PER_ELEMENT === 4) return idx.byteOffset;
  const n = count < (capacity | 0) ? count : capacity | 0;
  if (n > b.indexCap) return -1;
  const base = b.indexByte >> 2;
  const u32 = b.u32;
  for (let k = 0; k < n; k++) u32[base + k] = idx[k];
  return b.indexByte;
}

/**
 * packInstancedRows(q, ctx, dst, dstU32, floatsPer, capacity, shadowCast) through the kernel.
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs
 */
export function packInstancedRowsWasm(b, q, ctx, dst, floatsPer, capacity, shadowCast) {
  if (!b || !q || !dst || !ctx) return -1;
  const o = ctx.o || ctx;
  const general = Boolean(ctx.useScreen || o.pixelSnap || ctx.filterTypes);
  if ((floatsPer | 0) !== (shadowCast ? GPU_CASTER_FLOATS : GPU_SPRITE_FLOATS)) return -1;
  if (dst.buffer !== b.buffer) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  if (indexByte < 0) return -1;
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const typeByte = typeArr ? typeArr.byteOffset : 0;
  if (general) {
    // The slow path: packInstancedRows' own values, read as it reads them.
    const P = b.params;
    P[0] = (ctx.useScreen ? 1 : 0) | (ctx.useScreen && ctx.cameraRot ? 2 : 0) | (o.pixelSnap ? 4 : 0)
      | (ctx.filterTypes ? 8 : 0) | (ctx.hasInclude ? 16 : 0);
    P[1] = ctx.cameraX || 0;
    P[2] = ctx.cameraY || 0;
    P[3] = ctx.screenScale || 1;
    P[4] = ctx.camC;
    P[5] = ctx.camS;
    P[6] = ctx.focusX;
    P[7] = ctx.focusY;
    P[8] = ctx.halfW;
    P[9] = ctx.halfH;
    P[10] = o.snapCameraX || 0;
    P[11] = o.snapCameraY || 0;
    P[12] = o.snapZoom || 1;
    P[13] = ctx.includeType | 0;
    P[14] = ctx.exclude0 | 0;
    P[15] = ctx.exclude1 | 0;
    const pack = shadowCast ? b.castersGeneral : b.spritesGeneral;
    const n = pack(table, indexByte, count, capacity | 0, invDepthDenom, dst.byteOffset, typeByte, b.particlesByte, b.paramsByte);
    ctx.particleCount = b.u32[b.particlesByte >> 2];
    return n;
  }
  let out = -1;
  // W9b: a long list over most of the queue goes through its inverse, reading the queue in order.
  // The kernel declines (-1) a list with a repeated or out-of-range row, and the gather packs it.
  const rows = q.count | 0;
  if (indexByte && b.inverseByte && count >= SCATTER_MIN_ROWS && count * 2 >= rows && rows <= b.indexCap) {
    const scatter = shadowCast ? b.castersScatter : b.spritesScatter;
    out = scatter(table, indexByte, count, capacity | 0, invDepthDenom, dst.byteOffset, typeByte, b.particlesByte, b.inverseByte, rows);
  }
  if (out < 0) {
    const pack = shadowCast ? b.casters : b.sprites;
    out = pack(table, indexByte, count, capacity | 0, invDepthDenom, dst.byteOffset, typeByte, b.particlesByte);
  }
  ctx.particleCount = b.u32[b.particlesByte >> 2];
  return out;
}

/**
 * E-82b: packSplitRows (gpuQueueLayout.js) through the kernel. Each plain sprite's pose goes into `pose`
 * (POSE_PLAIN_FLOATS a row) and, unless `stat` is null, its statics into `stat` (POSE_STATIC_FLOATS a row).
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs
 */
export function packSplitRowsWasm(b, q, ctx, pose, stat, capacity) {
  if (!b || !q || !pose || !ctx) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  if (pose.buffer !== b.buffer || (stat !== null && stat.buffer !== b.buffer)) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  if (indexByte < 0) return -1;
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const typeByte = typeArr ? typeArr.byteOffset : 0;
  let out = -1;
  // As above: a long list over most of the queue goes through its inverse (with the statics: a listed
  // frame's statics are never current).
  const rows = q.count | 0;
  if (stat !== null && indexByte && b.inverseByte && count >= SCATTER_MIN_ROWS && count * 2 >= rows && rows <= b.indexCap) {
    out = b.spritesSplitScatter(table, indexByte, count, capacity | 0, invDepthDenom, pose.byteOffset, stat.byteOffset,
      typeByte, b.particlesByte, b.inverseByte, rows);
  }
  if (out < 0) {
    out = b.spritesSplit(table, indexByte, count, capacity | 0, invDepthDenom, pose.byteOffset,
      stat !== null ? stat.byteOffset : 0, typeByte, b.particlesByte);
  }
  ctx.particleCount = b.u32[b.particlesByte >> 2];
  return out;
}

/**
 * E-162: a painter-sorted frame's indexed streams through the kernel: each drawn row's pose (GPU_POSE_FLOATS) and its
 * slot pair (GPU_INDEXED_SLOT_FLOATS: its row, as a float, and the slot's depth, as the split pack writes it) at its
 * draw slot, and, unless `stat` is null, every queue row's statics at its row (GPU_INDEXED_STATIC_FLOATS a row, the
 * depth term 0). Only for an index list over most of the queue, as packSplitRowsWasm's scatter takes it, and a queue
 * whose rows `stat` holds.
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs (the caller packs it split)
 */
export function packIndexedRowsWasm(b, q, ctx, pose, slots, stat, capacity) {
  if (!b || !q || !pose || !slots || !ctx || !b.spritesIndexedScatter) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  if (pose.buffer !== b.buffer || slots.buffer !== b.buffer || (stat !== null && stat.buffer !== b.buffer)) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  const n = q.count | 0;
  if (indexByte <= 0 || !b.inverseByte || count < SCATTER_MIN_ROWS || count * 2 < n || n > b.indexCap) return -1;
  if (stat !== null && stat.length < n * GPU_INDEXED_STATIC_FLOATS) return -1;
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const out = b.spritesIndexedScatter(table, indexByte, count, capacity | 0, invDepthDenom, pose.byteOffset,
    slots.byteOffset, stat !== null ? stat.byteOffset : 0, typeArr ? typeArr.byteOffset : 0, b.particlesByte,
    b.inverseByte, n);
  if (out < 0) return -1;
  ctx.particleCount = b.u32[b.particlesByte >> 2];
  return out;
}

/**
 * W9e: a pose batch's upload (instancedSpriteBatch.js _packPoseOnly, or _packPoseAndStatics when `stat` is not
 * null) through the kernel: the pose stream into `pose` (POSE_DYN_FLOATS a row) and the statics into `stat`
 * (POSE_STATIC_FLOATS a row). The context's values go in as the JS reads them (an unset snap zoom stays NaN, which
 * skips the snap as snapWorldToPixel does).
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs (an array outside the memory)
 */
export function packPoseRowsWasm(b, q, ctx, pose, stat, capacity) {
  if (!b || !q || !pose || !ctx) return -1;
  const o = ctx.o || ctx;
  if (pose.buffer !== b.buffer || (stat !== null && stat.buffer !== b.buffer)) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  // The previous pose: none with the pose snap, as the JS reads it.
  const prevX = o.snap ? null : o.prevX || null;
  const prevY = o.snap ? null : o.prevY || null;
  if ((prevX && prevX.buffer !== b.buffer) || (prevY && prevY.buffer !== b.buffer)) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  if (indexByte < 0) return -1;
  const P = b.params;
  P[0] = (ctx.useScreen ? 1 : 0) | (ctx.useScreen && ctx.cameraRot ? 2 : 0) | (o.pixelSnap ? 4 : 0)
    | (ctx.filterTypes ? 8 : 0) | (ctx.hasInclude ? 16 : 0);
  P[1] = ctx.cameraX;
  P[2] = ctx.cameraY;
  P[3] = ctx.screenScale;
  P[4] = ctx.camC;
  P[5] = ctx.camS;
  P[6] = ctx.focusX;
  P[7] = ctx.focusY;
  P[8] = ctx.halfW;
  P[9] = ctx.halfH;
  P[10] = o.snapCameraX;
  P[11] = o.snapCameraY;
  P[12] = o.snapZoom;
  P[13] = ctx.includeType | 0;
  P[14] = ctx.exclude0 | 0;
  P[15] = ctx.exclude1 | 0;
  return b.pose(table, indexByte, count, capacity | 0, ctx.depthDenom, pose.byteOffset, stat !== null ? stat.byteOffset : 0,
    typeArr ? typeArr.byteOffset : 0, prevX ? prevX.byteOffset : 0, prevY ? prevY.byteOffset : 0, b.paramsByte);
}
