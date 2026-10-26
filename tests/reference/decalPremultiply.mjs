// The decal tile premultiply in JavaScript: copyPremultiplyRgba as Pixi ran it until decalPremultiply.wasm (E-76 W21c)
// became its only premultiply. Kept as the parity reference the kernel is tested against (WASM_HYPOTHESES L12); the
// engine does not use it.

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Straight RGBA8 → premultiplied, matching WebGL UNPACK_PREMULTIPLY on ImageBitmap.
 * Decal tiles are mostly transparent texels with opaque cores: those move as
 * one u32 word; only partial alpha does the per-channel math.
 * `dstWords` / `srcWords`: Uint32Array views of the same bytes, for a caller that copies the
 * same buffers every frame; without them two views are made per call (E-107: 3.6 MB/s in Pixi).
 */
export function copyPremultiplyRgba(dst, src, dstWords = null, srcWords = null) {
  const n = src.length;
  if (LITTLE_ENDIAN && !(src.byteOffset & 3) && !(dst.byteOffset & 3) && !(n & 3)) {
    const words = n >> 2;
    const s32 = srcWords || new Uint32Array(src.buffer, src.byteOffset, words);
    const d32 = dstWords || new Uint32Array(dst.buffer, dst.byteOffset, words);
    for (let p = 0; p < words; p++) {
      const v = s32[p];
      const a = v >>> 24;
      if (a === 255) d32[p] = v;
      else if (a === 0) d32[p] = 0;
      else {
        const i = p << 2;
        dst[i] = (src[i] * a * 257 + 32896) >> 16;
        dst[i + 1] = (src[i + 1] * a * 257 + 32896) >> 16;
        dst[i + 2] = (src[i + 2] * a * 257 + 32896) >> 16;
        dst[i + 3] = a;
      }
    }
    return;
  }
  for (let i = 0; i < n; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
    } else if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
    } else {
      dst[i] = (src[i] * a * 257 + 32896) >> 16;
      dst[i + 1] = (src[i + 1] * a * 257 + 32896) >> 16;
      dst[i + 2] = (src[i + 2] * a * 257 + 32896) >> 16;
      dst[i + 3] = a;
    }
  }
}
