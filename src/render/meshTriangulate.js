// Ear-clip a simple polygon into a triangle list.
// ponytail: self-intersections and holes fail closed (return -1).
// Upgrade: earcut with hole indices.

let _prev = null;
let _next = null;

function cross(xy, a, b, c) {
  const ax = xy[a * 2];
  const ay = xy[a * 2 + 1];
  const bx = xy[b * 2];
  const by = xy[b * 2 + 1];
  const cx = xy[c * 2];
  const cy = xy[c * 2 + 1];
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTri(xy, p, a, b, c, ccw) {
  const c1 = cross(xy, a, b, p);
  const c2 = cross(xy, b, c, p);
  const c3 = cross(xy, c, a, p);
  // Inclusive: a vertex sitting on the closing edge is not an ear.
  if (ccw) return c1 >= 0 && c2 >= 0 && c3 >= 0;
  return c1 <= 0 && c2 <= 0 && c3 <= 0;
}

function isEar(xy, p, c, n, next, ccw) {
  const cr = cross(xy, p, c, n);
  if (ccw ? cr <= 0 : cr >= 0) return false;
  let v = next[n];
  let guard = 0;
  while (v !== p && guard++ < 65536) {
    if (pointInTri(xy, v, p, c, n, ccw)) return false;
    v = next[v];
  }
  return v === p;
}

/**
 * @param {ArrayLike<number>} xy flat x,y
 * @param {number} count vertex count
 * @param {Uint16Array|Uint32Array} out triangle indices, local to the outline
 * @returns {number} index count, or -1
 */
export function triangulateSimplePolygon(xy, count, out) {
  const n = count | 0;
  if (n < 3 || n > 65535 || !xy || !out) return -1;
  const need = (n - 2) * 3;
  if (out.length < need) return -1;

  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    area += xy[i * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[i * 2 + 1];
  }
  if (area === 0 || !Number.isFinite(area)) return -1;
  const ccw = area > 0;

  // D.1 Fast path: If polygon is strictly convex, fan from vertex 0 directly in O(N).
  let isConvex = true;
  for (let i = 0; i < n; i++) {
    const p = i === 0 ? n - 1 : i - 1;
    const nx = i + 1 === n ? 0 : i + 1;
    const cr = cross(xy, p, i, nx);
    if (ccw ? cr <= 0 : cr >= 0) {
      isConvex = false;
      break;
    }
  }
  if (isConvex) {
    let w = 0;
    for (let i = 1; i < n - 1; i++) {
      out[w++] = 0;
      out[w++] = ccw ? i : i + 1;
      out[w++] = ccw ? i + 1 : i;
    }
    return w;
  }

  if (!_prev || _prev.length < n) {
    _prev = new Uint32Array(n);
    _next = new Uint32Array(n);
  }
  const prev = _prev;
  const next = _next;
  for (let i = 0; i < n; i++) {
    prev[i] = i === 0 ? n - 1 : i - 1;
    next[i] = i + 1 === n ? 0 : i + 1;
  }

  let remaining = n;
  let start = 0;
  let written = 0;
  let guard = n * n;
  while (remaining > 3 && guard-- > 0) {
    let ear = -1;
    let cur = start;
    for (let k = 0; k < remaining; k++) {
      const p = prev[cur];
      const nx = next[cur];
      if (isEar(xy, p, cur, nx, next, ccw)) {
        ear = cur;
        break;
      }
      cur = next[cur];
    }
    if (ear < 0) return -1;
    const p = prev[ear];
    const nx = next[ear];
    if (ccw) {
      out[written++] = p;
      out[written++] = ear;
      out[written++] = nx;
    } else {
      out[written++] = p;
      out[written++] = nx;
      out[written++] = ear;
    }
    next[p] = nx;
    prev[nx] = p;
    remaining--;
    start = nx;
  }
  if (remaining !== 3) return -1;
  const a = start;
  const b = next[a];
  const c = next[b];
  if (ccw) {
    out[written++] = a;
    out[written++] = b;
    out[written++] = c;
  } else {
    out[written++] = a;
    out[written++] = c;
    out[written++] = b;
  }
  return written;
}
