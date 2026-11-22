/**
 * Grid drawing the physics and nav debug renderers share (CR-23): the cells a camera sees, the grid's lines over them,
 * and a flowfield's arrows. Canvas 2D, screen px = (world - camera) · zoom.
 */

/** The visible cells: [startX, startY, endX, endY), `pad` more cells before the start, clamped to the grid. */
export const VISIBLE_CELLS = new Int32Array(4);

export function visibleCells(camera, canvas, zoom, cellSize, cols, rows, pad) {
  const out = VISIBLE_CELLS;
  out[0] = Math.max(0, Math.floor(camera.x / cellSize) - pad);
  out[1] = Math.max(0, Math.floor(camera.y / cellSize) - pad);
  out[2] = Math.min(cols, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
  out[3] = Math.min(rows, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);
  return out;
}

/**
 * The grid's lines over cells [x0, x1] x [y0, y1], each line to the range's far edge or `maxX`/`maxY` (world px), in
 * the context's stroke style.
 */
export function strokeGridLines(ctx, camera, zoom, cellSize, x0, y0, x1, y1, maxX, maxY) {
  const worldStartX = x0 * cellSize;
  const worldStartY = y0 * cellSize;
  const worldEndX = Math.min(x1 * cellSize, maxX);
  const worldEndY = Math.min(y1 * cellSize, maxY);
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) {
    const sx = (x * cellSize - camera.x) * zoom;
    ctx.moveTo(sx, (worldStartY - camera.y) * zoom);
    ctx.lineTo(sx, (worldEndY - camera.y) * zoom);
  }
  for (let y = y0; y <= y1; y++) {
    const sy = (y * cellSize - camera.y) * zoom;
    ctx.moveTo((worldStartX - camera.x) * zoom, sy);
    ctx.lineTo((worldEndX - camera.x) * zoom, sy);
  }
  ctx.stroke();
}

/** An arrow centred on (sx, sy) along the unit (dx, dy), `arrowLen` px long, its head 30° each side. */
export function strokeArrow(ctx, sx, sy, dx, dy, arrowLen) {
  ctx.beginPath();
  ctx.moveTo(sx - dx * arrowLen * 0.5, sy - dy * arrowLen * 0.5);
  ctx.lineTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
  ctx.stroke();

  const headLen = arrowLen * 0.4;
  // ±30° from unit (dx,dy) via CS rotate (cos30=√3/2, sin30=1/2)
  const c30 = 0.86602540378;
  const s30 = 0.5;
  const tipX = sx + dx * arrowLen * 0.5;
  const tipY = sy + dy * arrowLen * 0.5;
  const bx0 = -(dx * c30 - dy * s30) * headLen;
  const by0 = -(dx * s30 + dy * c30) * headLen;
  const bx1 = -(dx * c30 + dy * s30) * headLen;
  const by1 = -(-dx * s30 + dy * c30) * headLen;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + bx0, tipY + by0);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + bx1, tipY + by1);
  ctx.stroke();
}

/** A flowfield's arrows (int8 vectors, 127 = 1) in its visible cells, a cell's arrow 0.35 of the cell. */
export function strokeFlowfield(ctx, canvas, camera, zoom, vectors, gridWidth, gridHeight, cellSize) {
  const arrowLen = cellSize * 0.35 * zoom;
  const cells = visibleCells(camera, canvas, zoom, cellSize, gridWidth, gridHeight, 1);
  const x0 = cells[0];
  const y0 = cells[1];
  const x1 = cells[2];
  const y1 = cells[3];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const vecIdx = (y * gridWidth + x) * 2;
      const vx = vectors[vecIdx];
      const vy = vectors[vecIdx + 1];
      if (vx === 0 && vy === 0) continue;
      const sx = (x * cellSize + cellSize / 2 - camera.x) * zoom;
      const sy = (y * cellSize + cellSize / 2 - camera.y) * zoom;
      strokeArrow(ctx, sx, sy, vx / 127, vy / 127, arrowLen);
    }
  }
}
