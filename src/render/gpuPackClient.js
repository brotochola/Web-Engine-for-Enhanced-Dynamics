// The WASM instanced-row pack (E-76 W9): loads gpuPack.wasm onto the render-queue memory and packs
// sprite and caster rows as packInstancedRows does on its two fast paths (world space, no pixel
// snap, no type filter), with the same bits. The queue columns, the destination and the indices are
// views on that memory, so their byteOffsets are the kernel's addresses; indices kept elsewhere are
// copied into the memory's index scratch first. Anything else returns -1 and the caller packs in JS.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { GPU_CASTER_FLOATS, GPU_SPRITE_FLOATS } from './gpuQueueLayout.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./gpuPack.wasm', import.meta.url);

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
 *   `indexCap` u32, and one u32 for the particle count
 */
export async function bindGpuPack(memory, layout) {
  const k = await loadWasmKernel('gpuPack', wasmUrl, memory, ['pack_sprites', 'pack_casters']);
  return {
    buffer: memory.buffer,
    sprites: k.pack_sprites,
    casters: k.pack_casters,
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
 * packInstancedRows(q, ctx, dst, dstU32, floatsPer, capacity, shadowCast) through the kernel.
 * @returns {number} the rows written, or -1 when this call is not one the kernel packs
 */
export function packInstancedRowsWasm(b, q, ctx, dst, floatsPer, capacity, shadowCast) {
  if (!b || !q || !dst || !ctx) return -1;
  const o = ctx.o || ctx;
  if (ctx.useScreen || o.pixelSnap || ctx.filterTypes) return -1;
  if ((floatsPer | 0) !== (shadowCast ? GPU_CASTER_FLOATS : GPU_SPRITE_FLOATS)) return -1;
  if (dst.buffer !== b.buffer) return -1;
  const typeArr = ctx.typeArr;
  if (typeArr && typeArr.buffer !== b.buffer) return -1;
  const table = tableFor(b, q);
  if (table < 0) return -1;
  const count = ctx.scanCount | 0;
  let indexByte = 0;
  if (ctx.useIndices) {
    const idx = ctx.indices;
    if (idx.buffer === b.buffer && idx.BYTES_PER_ELEMENT === 4) {
      indexByte = idx.byteOffset;
    } else {
      const n = count < (capacity | 0) ? count : capacity | 0;
      if (n > b.indexCap) return -1;
      const base = b.indexByte >> 2;
      const u32 = b.u32;
      for (let k = 0; k < n; k++) u32[base + k] = idx[k];
      indexByte = b.indexByte;
    }
  }
  const depthDenom = ctx.depthDenom || 1;
  const invDepthDenom = 1 / (depthDenom > 0 ? depthDenom : 1);
  const pack = shadowCast ? b.casters : b.sprites;
  const out = pack(table, indexByte, count, capacity | 0, invDepthDenom, dst.byteOffset, typeArr ? typeArr.byteOffset : 0, b.particlesByte);
  ctx.particleCount = b.u32[b.particlesByte >> 2];
  return out;
}
