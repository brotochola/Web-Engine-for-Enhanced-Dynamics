// Reference row writers for the GPU sprite queue (review D5). Moved out of
// src/render/gpuQueueLayout.js: no engine code calls them. packInstancedRows
// is the live packer; these stay as the parity references the tests and the
// closed H-02/E-21 benches are written against.
import { GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';

// Same as the (unexported) one packInstancedRows uses.
function snapWorldToPixel(v, cam, zoom) {
  if (!(zoom > 0)) return v;
  return Math.round((v - cam) * zoom) / zoom + cam;
}

export function writeGpuSpriteRow(dst, dstU32, out, row, opts) {
  const o = opts || {};
  let x = row.x;
  let y = row.y;
  if (o.pixelSnap) {
    x = snapWorldToPixel(x, o.snapCameraX || 0, o.snapZoom || 1);
    y = snapWorldToPixel(y, o.snapCameraY || 0, o.snapZoom || 1);
  }
  const depth = 1.0 - (out + 1) / ((o.depthDenom || 1) + 1);
  let a = row.a;
  if (a < 0) a = 0;
  else if (a > 1) a = 1;
  const a8 = (a * 255 + 0.5) | 0;
  const packed = ((a8 & 255) << 24) | (row.tint & 0xffffff);
  const base = out * GPU_SPRITE_FLOATS;
  dst[base] = x;
  dst[base + 1] = y;
  dst[base + 2] = row.sx;
  dst[base + 3] = row.sy;
  dst[base + 4] = row.ax;
  dst[base + 5] = row.ay;
  dst[base + 6] = row.rc;
  dst[base + 7] = row.rs;
  dst[base + 8] = depth;
  dstU32[base + 9] = packed >>> 0;
  dst[base + 10] = row.tex;
  dst[base + 11] = row.invX || 0;
  dst[base + 12] = row.invY || 0;
  dst[base + 13] = row.u || 0;
  dst[base + 14] = row.v || 0;
}

/** Painter output index owns depth. Call after gatherInstancedRows. */
export function rewritePackedDepth(dst, n, depthDenom, floatsPer) {
  const fp = floatsPer > 0 ? floatsPer : GPU_SPRITE_FLOATS;
  const denom = depthDenom > 0 ? depthDenom : 1;
  const sn = n | 0;
  for (let k = 0; k < sn; k++) {
    dst[k * fp + 8] = 1.0 - (k + 1) / denom;
  }
}

/**
 * Gather `indices`-selected rows from a flat float array into `dst`.
 *
 * E-21 — DEAD IN PRODUCTION. This function has **no caller in `src/`**. A recursive
 * scan of `src/` finds only the definition and its own doc comment; the only
 * references anywhere in the repository are in `tests/node/*` and `tests/bench/*`.
 * Do not read its history as a claim about the engine: see below.
 *
 * The live gather is `packInstancedRows` (`gpuQueueLayout.js:244`), called from
 * `instancedSpriteBatch.js:625` and from four sites in `preRenderWorker.js`
 * (`:2907`, `:3052`, `:3094`, `:3105`). It does the same job - SoA columns in,
 * interleaved instance floats out - with a different, larger signature.
 *
 * The comment that used to sit here said:
 *
 *   "`subarray` allocates a new TypedArray view per row... one view per queued
 *    sprite - 45 568 allocations per frame".
 *
 * That is true **of this function** and false **of the engine**, and the distinction
 * matters because it was quoted in DEVLOG and in the math-allocation implementation
 * log as an engine-level finding. H-02's 2026-10-14 keep was a 1.32x kernel win on
 * this loop with **0 GC events counted on either side**; the allocation story was
 * already falsified by that measurement, and it turns out the loop was never on the
 * frame path to begin with. Recorded in
 * `docs/internal/reports/E-21-gather-instanced-rows.md`.
 *
 * Kept rather than deleted: it is exported, it is covered by
 * `gatherInstancedRowsParity.test.js`, and it is the natural place to put a
 * contiguous-range gather if a future backend needs one. Its history is recorded
 * here so it cannot be re-cited as an engine speed claim.
 */
export function gatherInstancedRows(src, dst, indices, n, srcFp, dstFp, shadowQ) {
  const sn = n | 0;
  const sfp = srcFp | 0;
  const dfp = dstFp | 0;
  if (!src || !dst || sn <= 0) return 0;
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * dfp;
    const spriteN = sfp < GPU_SPRITE_FLOATS ? sfp : GPU_SPRITE_FLOATS;
    for (let f = 0; f < spriteN; f++) dst[to + f] = src[from + f];
    if (shadowQ && dfp >= GPU_CASTER_FLOATS) {
      const shAt = GPU_SPRITE_FLOATS;
      dst[to + shAt] = shadowQ.shadowH ? shadowQ.shadowH[i] : 0;
      dst[to + shAt + 1] = shadowQ.shadowOffX ? shadowQ.shadowOffX[i] : 0;
      dst[to + shAt + 2] = shadowQ.shadowOffY ? shadowQ.shadowOffY[i] : 0;
      const lightAt = GPU_CASTER_LIGHT_FLOAT;
      dst[to + lightAt] = 0;
      dst[to + lightAt + 1] = 0;
      dst[to + lightAt + 2] = 0;
      dst[to + lightAt + 3] = 0;
    }
  }
  return sn;
}

export function copyPackedRows(src, dst, count, floatsPer, prefix) {
  const n = count | 0;
  const fp = floatsPer | 0;
  if (!src || !dst || n <= 0 || fp <= 0) return;
  const from = 0;
  const to = (prefix | 0) * fp;
  const len = n * fp;
  if (to + len > dst.length || from + len > src.length) {
    const keep = Math.min(n, ((dst.length - to) / fp) | 0, ((src.length - from) / fp) | 0);
    if (keep <= 0) return;
    dst.set(src.subarray(from, from + keep * fp), to);
    return;
  }
  dst.set(src.subarray(from, from + len), to);
}
