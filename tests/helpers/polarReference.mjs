// The polar raster and merge as they were before E-43 and E-61: every boundary
// edge rastered with its own two atan2, and every sweep edge tested against
// every output ray. The parity tests hold the shipped code to this, bit for bit.
// N-300: the merge keeps the sweep's vertices where the sweep is the nearer
// layer, by angle among the rays, at most WALL_ROW_MAX_VERTS in all.
import { POLAR_BINS, SWEEP_CAPS } from '../../src/render/visibility/angularSweep.js';
import { WALL_ROW_MAX_VERTS } from '../../src/render/visibility/lampWallRow.js';
import { normalizeAngleSigned } from '../../src/util/utils.js';

const TWO_PI = Math.PI * 2;
const BIN_SCALE = POLAR_BINS / TWO_PI;
const EPSILON = 1e-5;
const NEAR_MARGIN = 0.5;

/** The merge's angle order: atan2's over (-pi, pi], one unit per quarter turn. */
function pseudoAngle(x, y) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const p = ay / (ax + ay);
  if (y < 0) return x < 0 ? p - 2 : -p;
  return x < 0 ? 2 - p : p;
}

/** The angle of half-bin m (m = 2b + 1 is bin b's centre, 2b its lower border). */
function halfBinAngle(m) {
  return -Math.PI + m * 0.5 * (TWO_PI / POLAR_BINS);
}
const BORDER_PSEUDO = Float64Array.from({ length: POLAR_BINS }, (_, b) => pseudoAngle(Math.cos(halfBinAngle(2 * b)), Math.sin(halfBinAngle(2 * b))));

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
      const cap = Math.min(maxVerts | 0, WALL_ROW_MAX_VERTS);
      const xs = Float32Array.from(inX.subarray(0, n));
      const ys = Float32Array.from(inY.subarray(0, n));
      // N-300: the sweep's vertices kept. Near ones (inside the radius) nearer than their bin as they are; any other
      // beside a kept near one in the polygon's order, pulled in to its bin's hit where a solid is nearer than it. More
      // than cap - 3, or a polygon past the sweep's scratch (its event cap): none.
      let kept = [];
      if (n >= 3 && n <= SWEEP_CAPS.maxEvents) {
        const kind = [];
        const ang = [];
        const bin = [];
        const reach = [];
        for (let i = 0; i < n; i++) {
          const dx = xs[i] - lx;
          const dy = ys[i] - ly;
          const p = pseudoAngle(dx, dy);
          let f = 0;
          let b = 0;
          let d = 0;
          if (!Number.isNaN(p)) {
            while (b + 1 < POLAR_BINS && BORDER_PSEUDO[b + 1] <= p) b++;
            d = Math.sqrt(dx * dx + dy * dy);
            f = d < radius - NEAR_MARGIN && d < dist[b] ? 1 : 2;
          }
          kind.push(f);
          ang.push(p);
          bin.push(b);
          reach.push(d);
        }
        for (let i = 0; i < n; i++) {
          const near = kind[i] === 1;
          const beside = kind[i] === 2 && (kind[(i + n - 1) % n] === 1 || kind[(i + 1) % n] === 1);
          if (!near && !beside) continue;
          const hit = dist[bin[i]];
          if (beside && hit < radius - EPSILON && hit < reach[i]) {
            const k = hit / reach[i];
            kept.push({ p: ang[i], x: Math.fround(lx + (xs[i] - lx) * k), y: Math.fround(ly + (ys[i] - ly) * k) });
          } else {
            kept.push({ p: ang[i], x: xs[i], y: ys[i] });
          }
        }
        if (kept.length > cap - 3) kept = [];
      }
      // In the polygon's order from the seam (it may start on it at +pi): after the largest fall in angle, cyclically.
      let first = 0;
      let fall = -Infinity;
      kept.forEach((v, i) => {
        const before = kept[(i + kept.length - 1) % kept.length];
        if (before.p - v.p > fall) {
          fall = before.p - v.p;
          first = i;
        }
      });
      kept = kept.slice(first).concat(kept.slice(0, first));
      const rays = cap - kept.length;
      const group = rays >= POLAR_BINS ? 1 : Math.ceil(POLAR_BINS / rays);
      const count = group === 1 ? POLAR_BINS : Math.ceil(POLAR_BINS / group);
      const outX = new Float32Array(count);
      const outY = new Float32Array(count);
      const rayP = new Float64Array(count);
      for (let k = 0; k < count; k++) {
        const b0 = k * group;
        const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
        let d = dist[b0];
        for (let b = b0 + 1; b < b1; b++) {
          if (dist[b] < d) d = dist[b];
        }
        const ang = halfBinAngle(b0 + b1);
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        rayP[k] = pseudoAngle(c, s);
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
      // In turn, the kept vertices before each ray's angle, then those on it (the ray's point stands for them), then the
      // ray.
      const x = [];
      const y = [];
      let q = 0;
      for (let k = 0; k < count; k++) {
        for (; q < kept.length && kept[q].p < rayP[k]; q++) {
          x.push(kept[q].x);
          y.push(kept[q].y);
        }
        while (q < kept.length && kept[q].p === rayP[k]) q++;
        x.push(outX[k]);
        y.push(outY[k]);
      }
      for (; q < kept.length; q++) {
        x.push(kept[q].x);
        y.push(kept[q].y);
      }
      return { m: x.length, x, y };
    },
  };
}
