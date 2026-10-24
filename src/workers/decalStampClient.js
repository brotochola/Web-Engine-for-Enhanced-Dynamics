// The WASM decal stamp (E-76 W26): loads decalStamp.wasm onto the decal memory (decalMemory.js), where the tiles,
// the decal textures and the kernel's scratch live. The particle worker writes each stamp as a 64-byte record
// (stampParticleToTile) and stamp_tiles stamps the frame's records in one call, in their order, as
// Decal.stampToTileBuffers would one by one; the tiles it touched get their dirty flags after it returns.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { DECAL_STAMP_BYTES, DECAL_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./decalStamp.wasm', import.meta.url);

/** wasm/decalStamp.c's table, slot for slot. */
export const DECAL_SLOTS = ['tiles', 'dirty', 'tilesX', 'tilesY', 'tilePixels', 'stamps', 'columns', 'columnsCap', 'flags'];
if (DECAL_SLOTS.length > DECAL_TABLE_SLOTS) throw new Error('decalStamp: the column table outgrew its region');
/** Table flag: every stamp through the kernel's scalar loop (the bench's wasm-scalar). */
export const DECAL_F_SCALAR = 1;

export async function bindDecalStamp(memory, layout, tilesX, tilesY) {
  const k = await loadWasmKernel('decalStamp', wasmUrl, memory, ['stamp_tiles']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, layout.tableByte, DECAL_SLOTS.length);
  table[0] = layout.tilesByte;
  table[1] = layout.touchedByte;
  table[2] = tilesX;
  table[3] = tilesY;
  table[4] = layout.tilePixels;
  table[5] = layout.stampsByte;
  table[6] = layout.columnsByte;
  table[7] = layout.columnsCap;
  table[8] = 0;
  const words = (layout.maxStamps * DECAL_STAMP_BYTES) >> 2;
  return {
    stampTiles: k.stamp_tiles,
    table,
    tableByte: layout.tableByte,
    f64: new Float64Array(buffer, layout.stampsByte, words >> 1),
    u32: new Uint32Array(buffer, layout.stampsByte, words),
    maxStamps: layout.maxStamps,
    /** Records written since the last flush. */
    count: 0,
    touched: new Uint8Array(buffer, layout.touchedByte, layout.totalTiles),
    textures: layout.textures,
  };
}

/**
 * Stamp the records written since the last flush, then set the dirty flag of every tile the kernel touched
 * (after its pixels, as stampToTileBuffers' Atomics.store is). Returns the tiles stamped.
 */
export function flushDecalStamps(b, dirty, tileSize, resolution) {
  const n = b.count;
  if (n === 0) return 0;
  b.count = 0;
  const stamped = b.stampTiles(b.tableByte, n, tileSize, resolution);
  const touched = b.touched;
  for (let i = 0; i < touched.length; i++) {
    if (touched[i] !== 0) {
      touched[i] = 0;
      Atomics.store(dirty, i, 1);
    }
  }
  return stamped;
}
