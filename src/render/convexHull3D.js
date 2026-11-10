/**
 * DX-VOLUME: the convex hull of points in 3D, for VolumeShadowCaster.setHull. Incremental: it runs when a volume is declared,
 * for tens of points, never in a frame. Its faces come out looking away from the hull, so a test can check them.
 */

/** The most points a hull takes: an edge's key is two point numbers. */
export const MAX_HULL_POINTS = 4096;

const makeFace = (x, y, z, i, j, k) => {
  const ax = x[j] - x[i];
  const ay = y[j] - y[i];
  const az = z[j] - z[i];
  const bx = x[k] - x[i];
  const by = y[k] - y[i];
  const bz = z[k] - z[i];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  return { i, j, k, nx, ny, nz, d: nx * x[i] + ny * y[i] + nz * z[i], seen: false };
};

/**
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {ArrayLike<number>} z
 * @param {number} n points to read
 * @returns {number[]|null} three point numbers a triangle, or null when the points enclose no volume
 */
export function convexHull3D(x, y, z, n) {
  const count = Math.min(n | 0, MAX_HULL_POINTS);
  if (count < 4) return null;
  let extent = 0;
  for (let p = 1; p < count; p++) {
    extent = Math.max(extent, Math.abs(x[p] - x[0]), Math.abs(y[p] - y[0]), Math.abs(z[p] - z[0]));
  }
  // A point that is not finite makes every tolerance NaN, and every test below false: no hull, rather than a wrong one.
  if (!Number.isFinite(extent)) return null;
  const eps = 1e-6 * Math.max(1, extent);

  // The first tetrahedron: the leftmost point, the farthest from it, the farthest from that line, the farthest from that plane.
  let a = 0;
  for (let p = 1; p < count; p++) if (x[p] < x[a]) a = p;
  let b = -1;
  let far = 0;
  for (let p = 0; p < count; p++) {
    const dx = x[p] - x[a];
    const dy = y[p] - y[a];
    const dz = z[p] - z[a];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > far) {
      far = d;
      b = p;
    }
  }
  if (b < 0 || far < eps * eps) return null;
  const ux = x[b] - x[a];
  const uy = y[b] - y[a];
  const uz = z[b] - z[a];
  let c = -1;
  let wide = 0;
  for (let p = 0; p < count; p++) {
    const wx = x[p] - x[a];
    const wy = y[p] - y[a];
    const wz = z[p] - z[a];
    const cx = uy * wz - uz * wy;
    const cy = uz * wx - ux * wz;
    const cz = ux * wy - uy * wx;
    const d = cx * cx + cy * cy + cz * cz;
    if (d > wide) {
      wide = d;
      c = p;
    }
  }
  if (c < 0 || Math.sqrt(wide) < eps * Math.sqrt(far)) return null;
  const base = makeFace(x, y, z, a, b, c);
  let e = -1;
  let tall = 0;
  for (let p = 0; p < count; p++) {
    const d = Math.abs(base.nx * x[p] + base.ny * y[p] + base.nz * z[p] - base.d);
    if (d > tall) {
      tall = d;
      e = p;
    }
  }
  if (e < 0 || tall < eps) return null;

  const mx = (x[a] + x[b] + x[c] + x[e]) / 4;
  const my = (y[a] + y[b] + y[c] + y[e]) / 4;
  const mz = (z[a] + z[b] + z[c] + z[e]) / 4;
  const outward = (i, j, k) => {
    const face = makeFace(x, y, z, i, j, k);
    return face.nx * mx + face.ny * my + face.nz * mz - face.d > 0 ? makeFace(x, y, z, i, k, j) : face;
  };
  let faces = [outward(a, b, c), outward(a, e, b), outward(b, e, c), outward(c, e, a)];

  for (let p = 0; p < count; p++) {
    if (p === a || p === b || p === c || p === e) continue;
    let outside = false;
    for (const face of faces) {
      face.seen = face.nx * x[p] + face.ny * y[p] + face.nz * z[p] - face.d > eps;
      if (face.seen) outside = true;
    }
    if (!outside) continue;
    // The faces p sees go; each edge of theirs that no other seen face shares is the horizon, and gets a face to p.
    const edges = new Set();
    for (const face of faces) {
      if (!face.seen) continue;
      edges.add(face.i * count + face.j);
      edges.add(face.j * count + face.k);
      edges.add(face.k * count + face.i);
    }
    const next = [];
    for (const face of faces) {
      if (!face.seen) {
        next.push(face);
        continue;
      }
      if (!edges.has(face.j * count + face.i)) next.push(makeFace(x, y, z, face.i, face.j, p));
      if (!edges.has(face.k * count + face.j)) next.push(makeFace(x, y, z, face.j, face.k, p));
      if (!edges.has(face.i * count + face.k)) next.push(makeFace(x, y, z, face.k, face.i, p));
    }
    faces = next;
  }

  const triangles = [];
  for (const face of faces) triangles.push(face.i, face.j, face.k);
  return triangles;
}
