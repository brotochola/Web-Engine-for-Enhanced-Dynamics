/**
 * Contiguous view Y-bands for multiple pre-render workers.
 * Bands are half-open ranges of whole foot-pixels. A decoration's innerZ
 * (±127 of the spriteYSortKey scale) stays on the same worker as its pixel.
 */

/**
 * Foot-pixel half-open range [pixelMinimum, pixelLimit) for worker
 * `workerIndex` of `workerCount` over the camera view
 * [cameraY, cameraY + viewHeight). Worker 0 eats everything above the first
 * cut; the last worker eats the rest. N=1 is the full pixel space — the
 * single-worker path never filters by band.
 *
 * @param {number} cameraY
 * @param {number} viewHeight
 * @param {number} workerIndex
 * @param {number} workerCount
 * @returns {{ pixelMinimum: number, pixelLimit: number }}
 */
export function viewSortKeyBand(cameraY, viewHeight, workerIndex, workerCount) {
  const n = workerCount | 0;
  const i = workerIndex | 0;
  if (n <= 1) {
    return { pixelMinimum: Number.NEGATIVE_INFINITY, pixelLimit: Number.POSITIVE_INFINITY };
  }
  const y0 = +cameraY || 0;
  const h = +viewHeight || 0;
  // Snap the float cut to a whole pixel so a pixel's full innerZ window
  // cannot sit on both sides of the cut.
  const pixelMinimum =
    i === 0 ? Number.NEGATIVE_INFINITY : Math.round(y0 + (h * i) / n);
  const pixelLimit =
    i >= n - 1 ? Number.POSITIVE_INFINITY : Math.round(y0 + (h * (i + 1)) / n);
  return { pixelMinimum, pixelLimit };
}

/**
 * @param {number} pixel
 * @param {number} pixelMinimum
 * @param {number} pixelLimit
 */
export function sortKeyBelongsToBand(pixel, pixelMinimum, pixelLimit) {
  return pixel >= pixelMinimum && pixel < pixelLimit;
}
