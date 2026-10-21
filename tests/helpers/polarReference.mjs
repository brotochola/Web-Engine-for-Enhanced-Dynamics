// The polar raster and merge as they were before E-43 and E-61: every boundary
// edge rastered with its own two atan2, and every sweep edge tested against
// every output ray. The parity tests hold the shipped code to this, bit for bit.
import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { normalizeAngleSigned } from '../../src/util/utils.js';

const TWO_PI = Math.PI * 2;
const BIN_SCALE = POLAR_BINS / TWO_PI;

export function raySegT(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const fx = ax - ox;
  const fy = ay - oy;
  const t = (fx * ey - fy * ex) / denom;
  const u = (fx * dy - fy * dx) / denom;
  if (t > 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) return t;
  return Infinity;
}

export function createPolarReference() {
  const dist = new Float32Array(POLAR_BINS);
  let radius = 0;
  let active = 0;

  function stamp(b, x0, y0, x1, y1, lx, ly) {
    const ang = -Math.PI + (2 * b + 1) * 0.5 * (TWO_PI / POLAR_BINS);
    const t = raySegT(lx, ly, Math.cos(ang), Math.sin(ang), x0, y0, x1, y1);
    if (t < dist[b]) {
      dist[b] = t;
      active = 1;
    }
  }

  return {
    clear(r) {
      radius = r > 0 ? r : 0;
      active = 0;
      dist.fill(radius);
    },
    get active() {
      return active;
    },
    raster(x0, y0, x1, y1, lx, ly) {
      let open = normalizeAngleSigned(Math.atan2(y0 - ly, x0 - lx));
      let close = normalizeAngleSigned(Math.atan2(y1 - ly, x1 - lx));
      let span = close - open;
      if (span < 0) span += TWO_PI;
      if (span > Math.PI) {
        const swap = open;
        open = close;
        close = swap;
        span = TWO_PI - span;
      }
      if (!(span > 1e-4)) return;
      let b0 = ((open + Math.PI) * BIN_SCALE) | 0;
      let b1 = ((close + Math.PI) * BIN_SCALE) | 0;
      if (b0 < 0) b0 = 0;
      else if (b0 >= POLAR_BINS) b0 = POLAR_BINS - 1;
      if (b1 < 0) b1 = 0;
      else if (b1 >= POLAR_BINS) b1 = POLAR_BINS - 1;
      if (open <= close) {
        for (let b = b0; b <= b1; b++) stamp(b, x0, y0, x1, y1, lx, ly);
      } else {
        for (let b = b0; b < POLAR_BINS; b++) stamp(b, x0, y0, x1, y1, lx, ly);
        for (let b = 0; b <= b1; b++) stamp(b, x0, y0, x1, y1, lx, ly);
      }
    },
    /** clipVisibilityToPolar's result, or null where it returns n unchanged. */
    clip(lx, ly, inX, inY, n, maxVerts) {
      if (!active) return null;
      const cap = maxVerts | 0;
      const xs = Float32Array.from(inX.subarray(0, n));
      const ys = Float32Array.from(inY.subarray(0, n));
      const group = cap >= POLAR_BINS ? 1 : Math.ceil(POLAR_BINS / cap);
      const count = group === 1 ? POLAR_BINS : Math.ceil(POLAR_BINS / group);
      const outX = new Float32Array(count);
      const outY = new Float32Array(count);
      for (let k = 0; k < count; k++) {
        const b0 = k * group;
        const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
        let d = dist[b0];
        for (let b = b0 + 1; b < b1; b++) {
          if (dist[b] < d) d = dist[b];
        }
        const ang = -Math.PI + (b0 + b1) * 0.5 * (TWO_PI / POLAR_BINS);
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        if (n >= 3) {
          let best = radius;
          for (let i = 0; i < n; i++) {
            const j = i + 1 < n ? i + 1 : 0;
            const t = raySegT(lx, ly, c, s, xs[i], ys[i], xs[j], ys[j]);
            if (t < best) best = t;
          }
          if (best < d) d = best;
        }
        outX[k] = lx + c * d;
        outY[k] = ly + s * d;
      }
      return { m: count, x: Array.from(outX), y: Array.from(outY) };
    },
  };
}
