/**
 * Camera AABB → spatial Grid cells, then split those rows across pre-render workers.
 * Collect walks only these cells instead of the published SpriteRenderer query.
 *
 * Pad the world AABB by sprite half-extent (or visualRange) so a large quad whose
 * origin sits outside the view still lands in a visited cell.
 */

/**
 * Inclusive cell col/row range covering a world AABB. Out of grid → empty range.
 * @returns {{ col0: number, col1: number, row0: number, row1: number }}
 */
export function aabbCellRange(minX, minY, maxX, maxY, cellSize, gridWidth, gridHeight) {
  const cs = cellSize > 0 ? cellSize : 1;
  const gw = gridWidth | 0;
  const gh = gridHeight | 0;
  if (gw <= 0 || gh <= 0 || !(maxX >= minX) || !(maxY >= minY)) {
    return { col0: 0, col1: -1, row0: 0, row1: -1 };
  }
  let col0 = (minX / cs) | 0;
  let col1 = (maxX / cs) | 0;
  let row0 = (minY / cs) | 0;
  let row1 = (maxY / cs) | 0;
  if (col0 < 0) col0 = 0;
  if (row0 < 0) row0 = 0;
  if (col1 >= gw) col1 = gw - 1;
  if (row1 >= gh) row1 = gh - 1;
  if (col0 > col1 || row0 > row1) {
    return { col0: 0, col1: -1, row0: 0, row1: -1 };
  }
  return { col0, col1, row0, row1 };
}

/**
 * World AABB of the camera view, expanded by pad (world units).
 * `camX/camY` are the top-left of the view in world space.
 */
export function cameraWorldAabb(camX, camY, viewW, viewH, pad) {
  const p = pad > 0 ? pad : 0;
  return {
    minX: camX - p,
    minY: camY - p,
    maxX: camX + viewW + p,
    maxY: camY + viewH + p,
  };
}

/**
 * Split inclusive [row0, row1] into contiguous bands. Worker 0 gets the low rows
 * (smaller Y). Empty if this worker has no rows.
 * @returns {{ row0: number, row1: number }}
 */
export function splitRowRange(row0, row1, workerIndex, workerCount) {
  const n = workerCount | 0;
  const i = workerIndex | 0;
  if (n <= 1) return { row0, row1 };
  if (row1 < row0) return { row0: 0, row1: -1 };
  const total = (row1 - row0 + 1) | 0;
  const start = row0 + (((total * i) / n) | 0);
  const end = row0 + (((total * (i + 1)) / n) | 0) - 1;
  if (end < start) return { row0: 0, row1: -1 };
  return { row0: start, row1: end };
}

/**
 * Packed cell indices for a worker's camera rows, left-to-right then top-to-bottom.
 * Returns written count.
 */
export function fillCameraCellIndices(
  dest,
  col0,
  col1,
  row0,
  row1,
  gridWidth,
  workerIndex,
  workerCount
) {
  const rows = splitRowRange(row0, row1, workerIndex, workerCount);
  if (rows.row1 < rows.row0 || col1 < col0) return 0;
  const gw = gridWidth | 0;
  let n = 0;
  for (let row = rows.row0; row <= rows.row1; row++) {
    const base = row * gw;
    for (let col = col0; col <= col1; col++) dest[n++] = base + col;
  }
  return n;
}

/**
 * Inclusive world-Y band of the camera view for worker `i` of `n`.
 * Worker 0 gets the top of the view (smaller Y). Last worker eats the remainder.
 */
export function viewYBand(camY, viewH, workerIndex, workerCount) {
  const n = workerCount | 0;
  const y0 = +camY || 0;
  const h = +viewH || 0;
  if (n <= 1) return { y0, y1: y0 + h };
  const i = workerIndex | 0;
  const start = y0 + (h * i) / n;
  const end = i >= n - 1 ? y0 + h : y0 + (h * (i + 1)) / n;
  return { y0: start, y1: end };
}

export function inViewYBand(worldY, camY, viewH, workerIndex, workerCount) {
  if ((workerCount | 0) <= 1) return true;
  const band = viewYBand(camY, viewH, workerIndex, workerCount);
  return worldY >= band.y0 && worldY < band.y1;
}

/**
 * Screen on-screen test matching preRender collectVisibleEntities.
 * sx/sy are already in screen pixels: x * zoom - cameraOffset.
 */
export function spriteOnScreen(sx, sy, halfExtent, zoom, screenMinX, screenMaxX, screenMinY, screenMaxY) {
  const extent = halfExtent * zoom;
  return (
    sx >= screenMinX - extent &&
    sx <= screenMaxX + extent &&
    sy >= screenMinY - extent &&
    sy <= screenMaxY + extent
  );
}
