/**
 * Compact shadow casters and honor maxShadowsPerLight / maxShadowsPerEntity
 * without packing CPU shadow sprites. A caster keeps the lights closest to
 * itself. Each light still keeps the casters closest to it.
 */

import { GPU_CASTER_LIGHT_FLOAT } from './gpuQueueLayout.js';

export function compactShadowCasterIndices(shadowH, typeArr, count, outIdx) {
  let n = 0;
  const cap = outIdx.length;
  const nSrc = count | 0;
  for (let i = 0; i < nSrc && n < cap; i++) {
    if (typeArr && typeArr[i] === 3) continue;
    if (shadowH && shadowH[i] > 0) outIdx[n++] = i;
  }
  return n;
}

/** Light vec4 on a caster row: x, y, intensity, rangeSq. Same slot as aInstLight. */
export const CASTER_LIGHT_FLOAT = GPU_CASTER_LIGHT_FLOAT;

/** Integer RT pixels. Nominal resolution is not the framebuffer size. */
export function rtPixelSize(canvasPx, resolution) {
  const r = resolution > 0 ? +resolution : 1;
  return Math.max(1, Math.round((+canvasPx || 0) * r));
}

/** RT pixels / canvas pixels. Projection and display use this, not the nominal resolution. */
export function rtPixelScale(canvasPx, rtPx) {
  return canvasPx > 0 ? rtPx / canvasPx : 1;
}

// The stamp itself (casters against each light, the closest kept) is shadowStamp.wasm (shadowStampClient.js); the
// JS it replaced is tests/reference/shadowStamp.mjs.
