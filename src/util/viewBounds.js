// Boxes around the drawn view, for culling.
//
// The camera turns about the canvas center, so a rotated view is its rectangle
// turned about the focus. Culls test boxes, so they take the box around that
// turned rectangle. At rotation 0 it is the view rectangle itself, computed the
// way the unrotated culls always did.
//
// No imports: camera.js, utils.js and the workers all use this.

/**
 * Half extents of the box around a width × height rectangle turned by
 * `rotation` about its center. Units are whatever width and height are in.
 * @param {number} width
 * @param {number} height
 * @param {number} rotation radians
 * @param {{halfW: number, halfH: number}} out
 * @returns {{halfW: number, halfH: number}} out
 */
export function rotatedHalfExtents(width, height, rotation, out) {
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  if (!rotation) {
    out.halfW = halfW;
    out.halfH = halfH;
    return out;
  }
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  out.halfW = halfW * c + halfH * s;
  out.halfH = halfW * s + halfH * c;
  return out;
}

const _ext = { halfW: 0, halfH: 0 };

/**
 * World box around the drawn view of a top-left camera.
 * @param {number} zoom
 * @param {number} cameraX top-left, world px
 * @param {number} cameraY
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} rotation radians
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} out
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}} out
 */
export function viewWorldBounds(zoom, cameraX, cameraY, canvasWidth, canvasHeight, rotation, out) {
  const z = zoom > 0 ? zoom : 1;
  const viewW = canvasWidth / z;
  const viewH = canvasHeight / z;
  if (!rotation) {
    out.minX = cameraX;
    out.minY = cameraY;
    out.maxX = cameraX + viewW;
    out.maxY = cameraY + viewH;
    return out;
  }
  const e = rotatedHalfExtents(viewW, viewH, rotation, _ext);
  const cx = cameraX + viewW * 0.5;
  const cy = cameraY + viewH * 0.5;
  out.minX = cx - e.halfW;
  out.maxX = cx + e.halfW;
  out.minY = cy - e.halfH;
  out.maxY = cy + e.halfH;
  return out;
}
