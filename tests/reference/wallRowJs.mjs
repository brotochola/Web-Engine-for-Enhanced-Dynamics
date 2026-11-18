// A lamp's row for the light pass (OL-4), written the plain way: the code src/render/visibility/lampWallRow.js had
// before OL-8, which walks the row's 256 directions and compares each against the vertices' angles. The shipped
// writeWallRow fills the same index by runs; tests/node/wallRowParity.test.js holds the two byte for byte.
import { WALL_BINS, WALL_ROW_ARGS, WALL_VERT0, wallAngle, writeEmptyWallRow } from '../../src/render/visibility/lampWallRow.js';

/**
 * @param {Float32Array} out the rows
 * @param {number} o the row's first float
 * @param {Float32Array} xs the polygon's vertices (world px), in the sweep's order
 * @param {Float32Array} ys
 * @param {Float32Array} codes each vertex's own code (0: its ray hit nothing)
 * @param {number} n vertices
 * @returns {number} the vertices written
 */
export function writeWallRowRef(out, o, xs, ys, codes, n) {
  if (n < 3) {
    writeEmptyWallRow(out, o);
    return 0;
  }
  const lx = WALL_ROW_ARGS[0];
  const ly = WALL_ROW_ARGS[1];
  const floorInv = WALL_ROW_ARGS[2];
  const v0 = o + 4 * WALL_VERT0;
  const x0 = Math.fround(xs[0] - lx);
  const y0 = Math.fround((ys[0] - ly) * floorInv);
  const ang0 = wallAngle(x0, y0);
  let prevRaw = ang0;
  let turned = 0;
  for (let i = 0; i < n; i++) {
    const rx = Math.fround(xs[i] - lx);
    const ry = Math.fround((ys[i] - ly) * floorInv);
    if (i > 0) {
      const raw = wallAngle(rx, ry);
      let step = raw - prevRaw;
      if (step < -2) step += 4;
      else if (step > 2) step -= 4;
      if (step > 0) turned += step;
      if (turned > 4) turned = 4;
      prevRaw = raw;
    }
    const v = v0 + 4 * i;
    out[v] = rx;
    out[v + 1] = ry;
    out[v + 2] = ang0 + turned;
    const next = codes[i + 1 < n ? i + 1 : 0];
    out[v + 3] = next !== 0 ? next : codes[i];
  }
  const close = v0 + 4 * n;
  out[close] = x0;
  out[close + 1] = y0;
  out[close + 2] = ang0 + 4;
  out[close + 3] = 0;

  const bins = o + 4;
  let i = 0;
  for (let b = 0; b < WALL_BINS; b++) {
    const start = ang0 + (4 * b) / WALL_BINS;
    while (i + 1 < n && out[v0 + 4 * (i + 1) + 2] <= start) i++;
    out[bins + b] = i > 0 ? i - 1 : 0;
  }
  out[o] = n;
  out[o + 1] = ang0;
  out[o + 2] = lx;
  out[o + 3] = ly * floorInv;
  return n;
}
