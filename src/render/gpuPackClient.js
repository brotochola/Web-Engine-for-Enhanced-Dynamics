// The WASM instanced-row pack (E-76 W9): loads gpuPack.wasm onto the render-queue memory and packs
// sprite and caster rows as packInstancedRows does on its two fast paths (world space, no pixel
// snap, no type filter), with the same bits. The queue columns, the destination and the indices are
// views on that memory, so their byteOffsets are the kernel's addresses; indices kept elsewhere are
// copied into the memory's index scratch first. Anything else returns -1 and the caller packs in JS.

import { loadWasmKernel } from '../util/wasmKernel.js';
import {
  GPU_CASTER_FLOATS, GPU_GBUF_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from './gpuQueueLayout.js';
import { engineWasmUrl } from '../wasm/engine.js';


/** Lists shorter than this pack by gathering: the scatter's inverse costs a pass over the queue. */
export const SCATTER_MIN_ROWS = 4096;

/** The queue columns the kernel reads, in its column-table order (wasm/gpuPack.c). */
export const GPU_PACK_COLUMNS = [
  'x', 'y', 'scaleX', 'scaleY', 'rotC', 'rotS', 'alpha', 'tint', 'textureId', 'anchorX', 'anchorY',
  'tileMulX', 'tileMulY', 'tileOffsetU', 'tileOffsetV', 'shadowH', 'shadowOffX', 'shadowOffY',
];

/**
 * E-372: the sun frames' region (renderQueueMemory.js `keyedSun`), where the keyed caster scan reads what it needs to
 * write each keyed caster row's sun frame: a block of KEYED_SUN_BLOCK_WORDS u32, the sheet table (a descriptor of
 * KEYED_SUN_SHEET_WORDS u32 a sheet id), the list of the rows the scan leaves to the JS (KEYED_SUN_LIST_CAP pairs:
 * keyed row, entity) and the pool the descriptors' frames are copied into (i32).
 */
export const KEYED_SUN_BLOCK_WORDS = 16;
export const KEYED_SUN_SHEETS = 256;
export const KEYED_SUN_SHEET_WORDS = 8;
export const KEYED_SUN_LIST_CAP = 8192;
export const KEYED_SUN_POOL_WORDS = 65536;
/**
 * E-393: past the pool, the lamps' frames' block (LAMP_FRAMES_BLOCK_WORDS u32, gpuPack.c LF_*) and light table
 * (LAMP_FRAMES_LIGHTS lights of LAMP_LIGHT_DOUBLES f64: x, y, the light's entity, 1 for a light and 0 for none).
 */
export const LAMP_FRAMES_BLOCK_WORDS = 16;
export const LAMP_FRAMES_LIGHTS = 1024;
export const LAMP_LIGHT_DOUBLES = 4;

/** E-372: the sun frames' region's bytes (E-393: with the lamps' block and light table). */
export function keyedSunRegionBytes() {
  const tables = KEYED_SUN_BLOCK_WORDS + KEYED_SUN_SHEETS * KEYED_SUN_SHEET_WORDS;
  return (tables + 2 * KEYED_SUN_LIST_CAP + KEYED_SUN_POOL_WORDS + LAMP_FRAMES_BLOCK_WORDS) * 4
    + LAMP_FRAMES_LIGHTS * LAMP_LIGHT_DOUBLES * 8;
}

/**
 * E-372: views of the sun frames' region at `byte` (null for none, 0 or less), and what its sheet table holds:
 * preRenderWorker.js syncKeyedSunTables writes it (`tables`, and by sheet id the frames it copied and their turn).
 * E-393: the lamps' block and light table past the pool (lamp_frames lists its rows in `list`, a row a word).
 * @param {ArrayBufferLike} buffer
 * @param {number} byte
 */
export function keyedSunViews(buffer, byte) {
  if (!(byte > 0)) return null;
  const sheetsByte = byte + KEYED_SUN_BLOCK_WORDS * 4;
  const listByte = sheetsByte + KEYED_SUN_SHEETS * KEYED_SUN_SHEET_WORDS * 4;
  const poolByte = listByte + 2 * KEYED_SUN_LIST_CAP * 4;
  const lampByte = poolByte + KEYED_SUN_POOL_WORDS * 4;
  const lightsByte = lampByte + LAMP_FRAMES_BLOCK_WORDS * 4;
  return {
    byte,
    block: new Uint32Array(buffer, byte, KEYED_SUN_BLOCK_WORDS),
    sheets: new Uint32Array(buffer, sheetsByte, KEYED_SUN_SHEETS * KEYED_SUN_SHEET_WORDS),
    sheetsByte,
    list: new Uint32Array(buffer, listByte, 2 * KEYED_SUN_LIST_CAP),
    listByte,
    listCap: KEYED_SUN_LIST_CAP,
    pool: new Int32Array(buffer, poolByte, KEYED_SUN_POOL_WORDS),
    poolByte,
    lampBlock: new Uint32Array(buffer, lampByte, LAMP_FRAMES_BLOCK_WORDS),
    lampByte,
    lights: new Float64Array(buffer, lightsByte, LAMP_FRAMES_LIGHTS * LAMP_LIGHT_DOUBLES),
    lightsByte,
    tables: null,
    frameOf: new Array(KEYED_SUN_SHEETS).fill(null),
    frameAt: new Array(KEYED_SUN_SHEETS).fill(null),
    frameShift: new Int32Array(KEYED_SUN_SHEETS).fill(-2),
  };
}

/**
 * Bind the kernel to the render-queue memory.
 * @param {WebAssembly.Memory} memory
 * @param {{ tableByte: number, tableSlots: number, indexByte: number, indexCap: number, particlesByte: number }} layout
 *   createRenderQueueMemory's layout: room for `tableSlots` column tables, an index scratch of
 *   `indexCap` u32, the scatter's inverse (`inverseByte`, one u32 per queue row; 0 for none) and one
 *   u32 for the particle count; E-372: the sun frames' region (`keyedSunByte`, -1 or none: no region)
 */
/** The doubles the general pack reads (wasm/gpuPack.c pack_general): flags, then the camera, snap and type values. */
const GENERAL_PARAMS = 16;

export async function bindGpuPack(memory, layout) {
  const k = await loadWasmKernel('gpuPack', engineWasmUrl, memory, [
    'pack_sprites', 'pack_casters', 'pack_sprites_scatter', 'pack_casters_scatter',
    'pack_sprites_split', 'pack_sprites_split_scatter', 'pack_sprites_general', 'pack_casters_general', 'pack_pose',
    'pack_sprites_indexed_scatter', 'pack_sprites_keyed', 'pack_casters_keyed', 'pack_casters_keyed_scan',
    'pack_sprites_keyed_rows', 'pack_sprites_keyed_gbuf', 'pack_sprites_keyed_rows_gbuf', 'lamp_frames',
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
    // E-177: the pose and the statics' key in draw order, the statics that changed as updates of a table by key.
    spritesKeyed: k.pack_sprites_keyed,
    // E-201: the same with each drawn instance's queue row instead of its pose (the shader fetches the pose by row).
    spritesKeyedRows: k.pack_sprites_keyed_rows,
    // E-387: the two with the instances' G-buffer words too (exports of their own: the plain ones keep their code).
    spritesKeyedGbuf: k.pack_sprites_keyed_gbuf,
    spritesKeyedRowsGbuf: k.pack_sprites_keyed_rows_gbuf,
    // E-191: keyed caster rows (a pose, a key, the shadow terms) of a list of queue rows.
    castersKeyed: k.pack_casters_keyed,
    // E-192: the same rows for the casters it finds in the queue itself.
    castersKeyedScan: k.pack_casters_keyed_scan,
    // E-393: the lamps' frames of directional casters in the stamp rows.
    lampFrames: k.lamp_frames,
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
    // E-372: the sun frames' region (null: the keyed caster scan writes no frame).
    keyedSun: keyedSunViews(memory.buffer, layout.keyedSunByte | 0),
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
 * slot (GPU_INDEXED_SLOT_FLOATS: its row, as a float; E-186: no depth, which nothing read) at its draw slot, and, unless `stat` is null, every queue row's statics at its row (GPU_INDEXED_STATIC_FLOATS a row, the
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

/** E-177: the words of an update (gpuPack.c KEYED_ROW_WORDS): the statics, then the key. */
export const GPU_KEYED_ROW_WORDS = 16;
/** E-177: the word of an update that holds its key. */
export const GPU_KEYED_KEY_WORD = 12;
/** E-177: the bit of a sprite row's key that says its statics changed since the emit before (preRenderEmit.c KEY_CHANGED). */
export const GPU_KEYED_CHANGED = 0x80000000;
/** E-189: with GPU_KEYED_CHANGED, the bit that says the texture alone changed (preRenderEmit.c KEY_TEX_ONLY). */
export const GPU_KEYED_TEX_ONLY = 0x40000000;
/** E-189: a texture update's u32 words (gpuPack.c KEYED_TEX_WORDS): the statics row, then the texture's float bits. */
export const GPU_KEYED_TEX_WORDS = 2;

/**
 * E-387: the byte of the block (gpuPack.c GB_*, six u32) that has a keyed pack of `n` rows write their G-buffer words
 * into `keyed.gbufOut` (GPU_GBUF_FLOATS a draw slot), as gbufWord.js writeGbufWords writes them from the key column:
 * from `keyed.gbufFlags` (SpriteRenderer.gbufFlags; its length is the entity count), `keyed.gbufSelf`
 * (ShadowCaster.selfShadow; null or empty: none) and `keyed.gbufZ` (SpriteRenderer.zIndex where the painter orders by
 * it; null or empty: no bands). 0, no words, when the destination or the flags are missing, an array is outside the
 * memory, the destination has no room for n slots, or the zIndex column is shorter than the flags. The block goes where
 * the general pack's parameters go, which a keyed pack does not read.
 */
function keyedGbufByte(b, keyed, n) {
  const out = keyed.gbufOut;
  const flags = keyed.gbufFlags;
  if (!out || !flags || flags.length === 0 || out.length < GPU_GBUF_FLOATS * n) return 0;
  if (out.buffer !== b.buffer || flags.buffer !== b.buffer) return 0;
  const self = keyed.gbufSelf;
  const selfN = self ? self.length : 0;
  // The block's 0 says "none" for these two, so a column at byte 0 (never, in a layout) declines.
  if (selfN > 0 && (self.buffer !== b.buffer || self.byteOffset === 0)) return 0;
  const z = keyed.gbufZ;
  const zN = z ? z.length : 0;
  if (zN > 0 && (z.buffer !== b.buffer || z.byteOffset === 0 || zN < flags.length)) return 0;
  const at = b.paramsByte >> 2;
  const u32 = b.u32;
  u32[at] = out.byteOffset;
  u32[at + 1] = flags.byteOffset;
  u32[at + 2] = selfN > 0 ? self.byteOffset : 0;
  u32[at + 3] = selfN;
  u32[at + 4] = zN > 0 ? z.byteOffset : 0;
  u32[at + 5] = flags.length;
  return b.paramsByte;
}

/**
 * E-177: a split frame whose statics stay with their key, through the kernel. Each drawn row's pose (GPU_POSE_FLOATS)
 * and slot (GPU_INDEXED_SLOT_FLOATS: its key's row of the statics texture, as a float; E-186: no depth) at its draw
 * slot. A sprite row's key is its entity, with GPU_KEYED_CHANGED set when the emit found
 * its statics changed since the emit before; a row without one, or with one at or past `keyed.keyBase`, takes keyBase
 * plus its slot. The changed rows and the rows without a key list their statics as updates at `keyed.updatesByte` (room
 * for capacity updates of GPU_KEYED_ROW_WORDS: the statics, then the key at GPU_KEYED_KEY_WORD); the update count goes
 * to `keyed.updates`. The queue's `key` column must be in the memory too. E-191: with `keyed.shadowByte` (0 for none) and
 * the queue's shadow columns in the memory, each slot's shadow terms (shadowH, offX, offY; zeros for a glow row) go there
 * too, and `keyed.shadowed` says whether they did. E-189: with `keyed.texUpdatesByte` (0 for none), a row whose key also
 * carries GPU_KEYED_TEX_ONLY goes there as a texture update (GPU_KEYED_TEX_WORDS) instead, counted in `keyed.texUpdates`.
 * E-387: with `keyed.gbufOut` and `keyed.gbufFlags` (keyedGbufByte's columns), each slot's G-buffer words go there too,
 * the words gbufWord.js writeGbufWords writes from the key column, and `keyed.gbufWritten` says whether they did.
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs
 */
export function packKeyedRowsWasm(b, q, ctx, pose, slots, keyed, capacity) {
  if (!b || !q || !pose || !slots || !ctx || !keyed || !b.spritesKeyed) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  const key = q.key;
  if (!key || key.buffer !== b.buffer || pose.buffer !== b.buffer || slots.buffer !== b.buffer) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  if (indexByte < 0) return -1;
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  // E-191: the slots' shadow terms too where the caller asks for them (a byte, 0 for none) and the queue has them.
  const shadowByte = keyed.shadowByte > 0 && q.shadowH && q.shadowH.buffer === b.buffer ? keyed.shadowByte : 0;
  // E-387: the slots' G-buffer words too where the caller hands their columns (the kernel packs min(count, capacity)).
  const gbufByte = keyedGbufByte(b, keyed, count < (capacity | 0) ? count : capacity | 0);
  const texByte = keyed.texUpdatesByte > 0 ? keyed.texUpdatesByte : 0;
  const out = gbufByte > 0
    ? b.spritesKeyedGbuf(table, key.byteOffset, indexByte, count, capacity | 0, invDepthDenom, pose.byteOffset,
      slots.byteOffset, keyed.keyBase >>> 0, keyed.updatesByte, typeArr ? typeArr.byteOffset : 0, b.particlesByte,
      shadowByte, texByte, gbufByte)
    : b.spritesKeyed(table, key.byteOffset, indexByte, count, capacity | 0, invDepthDenom, pose.byteOffset,
      slots.byteOffset, keyed.keyBase >>> 0, keyed.updatesByte, typeArr ? typeArr.byteOffset : 0, b.particlesByte,
      shadowByte, texByte);
  keyed.shadowed = shadowByte > 0;
  keyed.gbufWritten = gbufByte > 0;
  const r = b.particlesByte >> 2;
  ctx.particleCount = b.u32[r];
  keyed.updates = b.u32[r + 1];
  keyed.texUpdates = keyed.texUpdatesByte > 0 ? b.u32[r + 2] : 0;
  return out;
}

/**
 * E-201: packKeyedRowsWasm with each drawn instance's queue row (a float) at `rows` instead of its pose: the keyed
 * program fetches the pose from the queue's own pose columns by that row. The rest as packKeyedRowsWasm (E-387: the
 * G-buffer words too).
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs
 */
export function packKeyedRowsByRowWasm(b, q, ctx, rows, slots, keyed, capacity) {
  if (!b || !q || !rows || !slots || !ctx || !keyed || !b.spritesKeyedRows) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  const key = q.key;
  if (!key || key.buffer !== b.buffer || rows.buffer !== b.buffer || slots.buffer !== b.buffer) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  const indexByte = indexByteFor(b, ctx, count, capacity);
  if (indexByte < 0) return -1;
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const shadowByte = keyed.shadowByte > 0 && q.shadowH && q.shadowH.buffer === b.buffer ? keyed.shadowByte : 0;
  const gbufByte = keyedGbufByte(b, keyed, count < (capacity | 0) ? count : capacity | 0);
  const texByte = keyed.texUpdatesByte > 0 ? keyed.texUpdatesByte : 0;
  const out = gbufByte > 0
    ? b.spritesKeyedRowsGbuf(table, key.byteOffset, indexByte, count, capacity | 0, invDepthDenom, rows.byteOffset,
      slots.byteOffset, keyed.keyBase >>> 0, keyed.updatesByte, typeArr ? typeArr.byteOffset : 0, b.particlesByte,
      shadowByte, texByte, gbufByte)
    : b.spritesKeyedRows(table, key.byteOffset, indexByte, count, capacity | 0, invDepthDenom, rows.byteOffset,
      slots.byteOffset, keyed.keyBase >>> 0, keyed.updatesByte, typeArr ? typeArr.byteOffset : 0, b.particlesByte,
      shadowByte, texByte);
  keyed.shadowed = shadowByte > 0;
  keyed.gbufWritten = gbufByte > 0;
  const r = b.particlesByte >> 2;
  ctx.particleCount = b.u32[r];
  keyed.updates = b.u32[r + 1];
  keyed.texUpdates = keyed.texUpdatesByte > 0 ? b.u32[r + 2] : 0;
  return out;
}

/**
 * E-191: keyed caster rows (GPU_KEYED_CASTER_FLOATS: x, y, the key as a float and a zero, shadowH, offX, offY) for the
 * queue rows listed in `indices` (the first `count`, at most `capacity`), into `dst`; the queue's key and shadow columns
 * must be in the memory. -1 when the call is not one the kernel takes, or when a listed row has no key below
 * `keyBase` (its statics are not in the keyed texture): the caller packs the full rows.
 * @returns {number} the rows written, or -1
 */
export function packKeyedCastersWasm(b, q, indices, count, dst, keyBase, capacity) {
  if (!b || !b.castersKeyed || !q || !dst || !indices) return -1;
  const key = q.key;
  if (!key || key.buffer !== b.buffer || dst.buffer !== b.buffer || !q.shadowH || q.shadowH.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const n = Math.min(count | 0, capacity | 0, indices.length);
  if (n <= 0) return 0;
  let indexByte;
  if (indices.buffer === b.buffer) {
    indexByte = indices.byteOffset;
  } else {
    if (n > b.indexCap) return -1;
    b.u32.set(indices.subarray(0, n), b.indexByte >> 2);
    indexByte = b.indexByte;
  }
  const out = b.castersKeyed(table, key.byteOffset, indexByte, n, n, dst.byteOffset, keyBase >>> 0);
  return out === 0xffffffff ? -1 : out;
}

/** E-372: the sun frames' block's words (gpuPack.c KS_*), the first of the region's (keyedSunViews' `block`). */
export const KEYED_SUN = Object.freeze({
  TYPES: 0, ENTITIES: 1, ENTITY_COUNT: 2, ACTIVE: 3, MODE: 4, DIRECTION: 5, ANIMATION: 6, CASTS: 7, ORIENT: 8, KIND: 9,
  SHEET: 10, FRAME: 11, SHEETS: 12, LIST: 13, LIST_CAP: 14, LISTED: 15,
});
/**
 * E-372: a sheet descriptor's words (gpuPack.c SF_*): flags, the direction count, groups, the frames axis (maxFrames),
 * a fixed card's direction (front), the bytes of a uniform table's frames for the sun's turn (frameOf) and of the frames
 * by absolute direction (frameAt); and its flags: a table, uniform (frameOf copied), its sheet casts its solid for the
 * sun, its casters left to the JS (its frames not copied).
 */
export const KEYED_SUN_SHEET = Object.freeze({
  FLAGS: 0, COUNT: 1, GROUPS: 2, MAX_FRAMES: 3, FRONT: 4, FRAME_OF: 5, FRAME_AT: 6, LAMP_GEO: 7,
});
export const KEYED_SUN_TABLE = 1;
export const KEYED_SUN_UNIFORM = 2;
export const KEYED_SUN_SOLID = 4;
export const KEYED_SUN_DEFER = 8;
/**
 * E-393: and for the lamps' frames (lamp_frames): the sheet stands on a contact (its casters left to it cast their solid
 * for the lamps), and the table's border geometry for the lamps' turn is in the pool (lampTurnGeometry's lampGeo, its
 * byte at LAMP_GEO; doubles).
 */
export const KEYED_SUN_CONTACT = 16;
export const KEYED_SUN_LAMP_GEO = 32;

/** E-372: whether column v is one the kernel reads at its byte: in the memory, past byte 0, `min` elements at least. */
function kernelColumn(v, buffer, min) {
  return !!v && v.buffer === buffer && v.byteOffset > 0 && v.length >= min;
}

/**
 * E-372: the sun frames' block (gpuPack.c KS_*) for `sun`'s columns, written in the region's first words: the region's
 * byte for the kernel, or 0 (no frame written) when there is no region or the kernel cannot read a column: one outside
 * the memory, a row column shorter than the `count` rows scanned, an entity column shorter than `sun.active`.
 */
function keyedSunByte(b, sun, count) {
  const region = b.keyedSun;
  if (region === null) return 0;
  const buf = b.buffer;
  if (!sun.active) return 0;
  const n = sun.active.length;
  if (!kernelColumn(sun.types, buf, count) || !kernelColumn(sun.entities, buf, count)) return 0;
  if (!kernelColumn(sun.active, buf, n) || !kernelColumn(sun.mode, buf, n) || !kernelColumn(sun.dirs, buf, n)
    || !kernelColumn(sun.anims, buf, n) || !kernelColumn(sun.sheets, buf, n)) return 0;
  if (sun.casts !== null && !kernelColumn(sun.casts, buf, n)) return 0;
  if (sun.orients !== null && !kernelColumn(sun.orients, buf, n)) return 0;
  if (sun.kinds !== null && !kernelColumn(sun.kinds, buf, n)) return 0;
  if (sun.frames !== null && !kernelColumn(sun.frames, buf, n)) return 0;
  const B = region.block;
  B[KEYED_SUN.TYPES] = sun.types.byteOffset;
  B[KEYED_SUN.ENTITIES] = sun.entities.byteOffset;
  B[KEYED_SUN.ENTITY_COUNT] = n;
  B[KEYED_SUN.ACTIVE] = sun.active.byteOffset;
  B[KEYED_SUN.MODE] = sun.mode.byteOffset;
  B[KEYED_SUN.DIRECTION] = sun.dirs.byteOffset;
  B[KEYED_SUN.ANIMATION] = sun.anims.byteOffset;
  B[KEYED_SUN.CASTS] = sun.casts !== null ? sun.casts.byteOffset : 0;
  B[KEYED_SUN.ORIENT] = sun.orients !== null ? sun.orients.byteOffset : 0;
  B[KEYED_SUN.KIND] = sun.kinds !== null ? sun.kinds.byteOffset : 0;
  B[KEYED_SUN.SHEET] = sun.sheets.byteOffset;
  B[KEYED_SUN.FRAME] = sun.frames !== null ? sun.frames.byteOffset : 0;
  B[KEYED_SUN.SHEETS] = region.sheetsByte;
  B[KEYED_SUN.LIST] = region.listByte;
  B[KEYED_SUN.LIST_CAP] = region.listCap;
  B[KEYED_SUN.LISTED] = 0;
  return region.byte;
}

/**
 * E-192: packKeyedCastersWasm's rows for the casters of the queue's first `count` rows (shadowH above 0, not a glow: the
 * test of compactShadowCasterIndices, in the queue's order), at most `capacity`, without a list of them. -1 when the call
 * is not one the kernel takes or a caster has no key below `keyBase`: the caller lists the casters and packs the full
 * rows.
 * E-372: with `sun` (null: none), each row's sun frame in its fourth float too, as preRenderWorker.js sunFrameFor gives it,
 * from the sun frames' region (b.keyedSun, its tables brought to this turn by syncKeyedSunTables) and `sun`'s columns:
 * `types` and `entities` (the collector's, by queue row), DirectionalSprite's `active`, `mode`, `dirs` (directionIndex)
 * and `anims` (animation), ShadowCaster's `casts` (active), `orients` and `kinds` (sunKind), SpriteRenderer's `sheets`
 * (spritesheetId) and the entities' `frames` (null for none of the last four). It sets `sun.framed`, whether the kernel
 * wrote them (else every row keeps 0), and `sun.listed`, the rows it left at 0 for the JS (pairs in b.keyedSun.list,
 * keyed row then entity; past its listCap only counted).
 * @returns {number} the rows written, or -1
 */
export function packKeyedCastersScanWasm(b, q, count, dst, keyBase, capacity, sun = null) {
  if (!b || !b.castersKeyedScan || !q || !dst) return -1;
  const key = q.key;
  if (!key || key.buffer !== b.buffer || dst.buffer !== b.buffer || !q.shadowH || q.shadowH.buffer !== b.buffer) return -1;
  const type = q.type;
  if (type && type.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const sunAt = sun !== null ? keyedSunByte(b, sun, count >>> 0) : 0;
  const out = b.castersKeyedScan(table, key.byteOffset, type ? type.byteOffset : 0, count >>> 0, capacity >>> 0,
    dst.byteOffset, keyBase >>> 0, sunAt);
  if (sun !== null) {
    sun.framed = sunAt > 0;
    sun.listed = sunAt > 0 ? b.keyedSun.block[KEYED_SUN.LISTED] : 0;
  }
  return out === 0xffffffff ? -1 : out;
}

/** E-393: the lamps' frames' block's words (gpuPack.c LF_*: keyedSunViews' `lampBlock`). */
export const LAMP_FRAMES = Object.freeze({
  ACTIVE: 0, MODE: 1, DIRECTION: 2, ANIMATION: 3, ORIENT: 4, KIND: 5, SHEET: 6, FRAME: 7, ENTITY_COUNT: 8, SHEETS: 9,
  LIGHTS: 10, LIST: 11, LIST_CAP: 12, LISTED: 13, DONE: 14,
});

/** E-393: whether column v is one the kernel reads at its byte, `bytes` an element: kernelColumn, its element's size too. */
function lampColumn(v, buffer, min, bytes) {
  return kernelColumn(v, buffer, min) && v.BYTES_PER_ELEMENT === bytes;
}

/**
 * E-393: the lamps' frames of `stampN` stamp rows (`rows`: keyed rows when `keyed`, GPU_KEYED_STAMP_FLOATS each, else
 * full rows of GPU_CASTER_FLOATS) through the kernel (gpuPack.c lamp_frames), as preRenderWorker.js
 * applyKeyedLampFramesInto and applyLampFramesInto write them, from the sun frames' region (its sheet table brought to
 * `cols`' tables by syncKeyedSunTables). `lightIdx` (u16) names each row's light in `lights`, whose first `lightCount` (at
 * most LAMP_FRAMES_LIGHTS) go into the light table (x, y, id; none for a missing one); `cols` holds the columns, as
 * _applyLampFrames binds them: DirectionalSprite's `active`, `mode`, `dirs` (directionIndex) and `anims` (animation),
 * SpriteRenderer's `sheets` (spritesheetId), ShadowCaster's `orients` and `kinds` (lampKind) and the entities' `frames`
 * (null for none of the last three). -1, nothing written, when the call is not one the kernel takes: no region or kernel,
 * the rows or the light index outside the memory, a column outside it, of another element size or shorter than
 * `cols.active`. Else the rows the kernel went through: every row, or the first one its list had no room for (it and the
 * rows after it as they were, for the JS); `cols.listed` the rows before it left to the JS, a row a word in
 * b.keyedSun.list.
 * @returns {number}
 */
export function lampFramesWasm(b, rows, stampN, lightIdx, lights, lightCount, invG, cols, keyed) {
  const region = b ? b.keyedSun : null;
  if (region === null || !b.lampFrames || !rows || !lightIdx || !cols.active) return -1;
  const buf = b.buffer;
  const n = stampN >>> 0;
  const floats = keyed ? GPU_KEYED_STAMP_FLOATS : GPU_CASTER_FLOATS;
  if (rows.buffer !== buf || rows.length < n * floats || !lampColumn(lightIdx, buf, n, 2)) return -1;
  const entities = cols.active.length;
  if (!lampColumn(cols.active, buf, entities, 1) || !lampColumn(cols.mode, buf, entities, 1)
    || !lampColumn(cols.dirs, buf, entities, 1) || !lampColumn(cols.anims, buf, entities, 1)
    || !lampColumn(cols.sheets, buf, entities, 1)) return -1;
  if (cols.orients !== null && !lampColumn(cols.orients, buf, entities, 1)) return -1;
  if (cols.kinds !== null && !lampColumn(cols.kinds, buf, entities, 1)) return -1;
  if (cols.frames !== null && !lampColumn(cols.frames, buf, entities, 2)) return -1;
  let m = lightCount | 0;
  if (m > lights.length) m = lights.length;
  if (m > LAMP_FRAMES_LIGHTS) m = LAMP_FRAMES_LIGHTS;
  if (m < 0) m = 0;
  const T = region.lights;
  for (let i = 0, at = 0; i < m; i++, at += LAMP_LIGHT_DOUBLES) {
    const L = lights[i];
    if (L) {
      T[at] = L.x;
      T[at + 1] = L.y;
      T[at + 2] = L.id;
      T[at + 3] = 1;
    } else {
      T[at + 3] = 0;
    }
  }
  const B = region.lampBlock;
  B[LAMP_FRAMES.ACTIVE] = cols.active.byteOffset;
  B[LAMP_FRAMES.MODE] = cols.mode.byteOffset;
  B[LAMP_FRAMES.DIRECTION] = cols.dirs.byteOffset;
  B[LAMP_FRAMES.ANIMATION] = cols.anims.byteOffset;
  B[LAMP_FRAMES.ORIENT] = cols.orients !== null ? cols.orients.byteOffset : 0;
  B[LAMP_FRAMES.KIND] = cols.kinds !== null ? cols.kinds.byteOffset : 0;
  B[LAMP_FRAMES.SHEET] = cols.sheets.byteOffset;
  B[LAMP_FRAMES.FRAME] = cols.frames !== null ? cols.frames.byteOffset : 0;
  B[LAMP_FRAMES.ENTITY_COUNT] = entities;
  B[LAMP_FRAMES.SHEETS] = region.sheetsByte;
  B[LAMP_FRAMES.LIGHTS] = region.lightsByte;
  B[LAMP_FRAMES.LIST] = region.listByte;
  B[LAMP_FRAMES.LIST_CAP] = region.list.length;
  B[LAMP_FRAMES.LISTED] = 0;
  const done = b.lampFrames(rows.byteOffset, n, lightIdx.byteOffset, m, invG, region.lampByte, keyed ? 1 : 0) >>> 0;
  cols.listed = B[LAMP_FRAMES.LISTED];
  return done;
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
