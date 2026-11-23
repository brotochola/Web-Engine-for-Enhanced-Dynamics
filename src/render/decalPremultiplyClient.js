// The WASM decal premultiply (E-76 W21c): loads decalPremultiply.wasm onto the decal memory (decalMemory.js), where
// the tiles live. Pixi premultiplies each dirty tile with premultiply_simd into the memory's scratch tile and
// copies that into the run of tiles it uploads next (an upload straight from shared memory cost the other
// workers, E-123). The bytes are the JS premultiply's (tests/reference/decalPremultiply.mjs), the only premultiply now.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { engineWasmUrl } from '../wasm/engine.js';


export async function bindDecalPremultiply(memory, layout) {
  const k = await loadWasmKernel('decalPremultiply', engineWasmUrl, memory, ['premultiply_simd']);
  const tileBytes = layout.tilePixels * layout.tilePixels * 4;
  return {
    premultiply: k.premultiply_simd,
    scratchByte: layout.premultipliedByte,
    scratch: new Uint8ClampedArray(memory.buffer, layout.premultipliedByte, tileBytes),
    pixels: layout.tilePixels * layout.tilePixels,
    tileBytes,
  };
}

/** Tile `tileIndex` of the memory, premultiplied, into `dst` from byte `at` on (a run of tiles for one upload, E-270). */
export function premultiplyDecalTile(b, tileIndex, dst, at) {
  b.premultiply(tileIndex * b.tileBytes, b.scratchByte, b.pixels);
  dst.set(b.scratch, at);
}
