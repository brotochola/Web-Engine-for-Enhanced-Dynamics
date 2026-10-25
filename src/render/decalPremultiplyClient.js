// The WASM decal premultiply (E-76 W21c): loads decalPremultiply.wasm onto the decal memory (decalMemory.js), where
// the tiles live. Pixi premultiplies each dirty tile with premultiply_simd into the memory's scratch tile and
// copies that into the tile's own array, which it uploads (an upload straight from shared memory cost the other
// workers, E-123). The bytes are the JS premultiply's (tests/reference/decalPremultiply.mjs), the only premultiply now.

import { loadWasmKernel } from '../util/wasmKernel.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./decalPremultiply.wasm', import.meta.url);

export async function bindDecalPremultiply(memory, layout) {
  const k = await loadWasmKernel('decalPremultiply', wasmUrl, memory, ['premultiply_simd']);
  const tileBytes = layout.tilePixels * layout.tilePixels * 4;
  return {
    premultiply: k.premultiply_simd,
    scratchByte: layout.premultipliedByte,
    scratch: new Uint8ClampedArray(memory.buffer, layout.premultipliedByte, tileBytes),
    pixels: layout.tilePixels * layout.tilePixels,
    tileBytes,
  };
}

/** Tile `tileIndex` of the memory, premultiplied, into `dst` (the tile's own array). */
export function premultiplyDecalTile(b, tileIndex, dst) {
  b.premultiply(tileIndex * b.tileBytes, b.scratchByte, b.pixels);
  dst.set(b.scratch);
}
