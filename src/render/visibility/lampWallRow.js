/**
 * OL-4 (ONE_LIGHT_PLAN.md, final B): a lamp's walls as a row the light pass reads.
 *
 * The visibility sweep gives each lamp a polygon around it: where its light gets before a wall stops it (hits at their
 * distance, free directions past its radius). The old pass drew that polygon as a fan. Here it becomes a row of a float
 * texture (uWallRows, a row a lamp) and the light pass asks it, for a pixel's floor point, whether the lamp sees it:
 * the pixel's direction picks the polygon's edge that covers it, and the side of that edge the point lies on says lit
 * or shaded. The edge is the fan's own, so the shadow's border is the same line.
 *
 * A row, in RGBA float texels:
 * - texel 0: the vertex count (0: nothing stops this lamp), the first vertex's angle, the lamp's floor point (x, y);
 * - texels 1 .. WALL_BIN_TEXELS: for each of WALL_BINS directions, four a texel, the vertex to start the search from;
 * - texels WALL_VERT0 ..: the vertices in the sweep's order (rising atan2), each its offset to the lamp (x, y), its angle
 *   (wallAngle, unwrapped so it only rises) and the code of the edge that starts at it; then the first vertex again, a
 *   whole turn later, to close the polygon.
 *
 * An edge's code: 0 for an edge that stops nothing (the far boundary, between two free rays), else the wall's G-buffer id
 * times 256 plus its opacity in 1..255 (ShadowCaster.opacity: what the transmit wedges drew). Beyond a wall's edge a
 * pixel keeps WALL_UMBRA of the lamp plus what the wall lets through, and the wall itself is lit, which is what the
 * self-lit fills did: its own pixels whole (the id the G-buffer wrote for the pixel) or, with lighting.wallDepth, whatever
 * lies within that depth of the edge the lamp reaches, fading (a wall drawn by a mesh has no id).
 */

/** Directions a row indexes. A power of two, four a texel. */
export const WALL_BINS = 256;
/** Texels the directions' index takes. */
export const WALL_BIN_TEXELS = WALL_BINS / 4;
/** A row's first vertex texel. */
export const WALL_VERT0 = 1 + WALL_BIN_TEXELS;
/** Steps the search may take from a direction's start vertex (the vertices that may share one direction's bin). */
export const WALL_WALK = 16;
/** The share of a lamp's light a wall's shadow keeps (the old pass's UMBRA_FLOOR: its shadows were never black). */
export const WALL_UMBRA = 0.33;
/**
 * The most vertices a row holds, whatever lighting.maxPolygonVertices is (a scene may set that in the thousands, and a
 * row is as wide as its cap): a polygon with more is thinned to fit (pre-render keeps one vertex in every few).
 */
export const WALL_ROW_MAX_VERTS = 512;

/**
 * writeWallRow's lamp (x, y, in the polygon's world px) and 1 / the floor's scale (camera.floorScaleY): doubles in a typed
 * array, since a double in an argument is boxed when the call is not inlined (E-85), and this runs once a lamp a frame.
 * The row is written in the floor's terms (y over the floor's scale), where the light pass works: the map is affine, so
 * the polygon's edges stay the sight lines they are and its vertices keep their order around the lamp.
 */
export const WALL_ROW_ARGS = new Float64Array([0, 0, 1]);

/** writeWallRow's scratch: how many vertices each bin is the first to see, and one more slot for those no bin sees. */
const BIN_MARKS = new Int32Array(WALL_BINS + 1);

/** Texels a row takes for polygons of up to `maxVerts` vertices (the closing vertex included). */
export function wallRowTexels(maxVerts) {
  return WALL_VERT0 + (maxVerts | 0) + 1;
}

/**
 * The shared buffer a scene's rows are published in (pre-render writes it, Pixi reads it): `headerInts` int32 (the rows
 * written, each row's lamp (its entity), and at `signatureAt` the frame's signature, two words: OL-10), then the rows'
 * floats from `rowsByte`. A signature whose second word is 0 says nothing (the frame is not known to be any other's).
 * @param {number} maxLights rows it holds (lighting.maxLights)
 * @param {number} maxVerts lighting.maxPolygonVertices; a row holds at most WALL_ROW_MAX_VERTS of them (`rowVerts`)
 */
export function wallRowsLayout(maxLights, maxVerts) {
  const rowVerts = Math.max(3, Math.min(maxVerts | 0, WALL_ROW_MAX_VERTS));
  const rowTexels = wallRowTexels(rowVerts);
  const rowFloats = 4 * rowTexels;
  const lights = Math.max(1, maxLights | 0);
  const signatureAt = 1 + lights;
  const headerInts = signatureAt + 2;
  const rowsByte = (4 * headerInts + 15) & ~15;
  return { rowVerts, rowTexels, rowFloats, lights, headerInts, signatureAt, rowsByte, bytes: rowsByte + lights * rowFloats * 4 };
}

/**
 * A direction's place around the lamp, in [0, 4): a quarter turn is one unit, rising with atan2(y, x). The shaders'
 * wallAngle, with float32 steps where they have them.
 */
export function wallAngle(x, y) {
  const sum = Math.fround(Math.abs(x) + Math.abs(y));
  const t = Math.fround(x / (sum > 1e-6 ? sum : 1e-6));
  return y >= 0 ? Math.fround(1 - t) : Math.fround(3 + t);
}

/** An edge's code from its wall's G-buffer id (1..65535) and opacity (0..1]; never 0, which reads "stops nothing". */
export function wallEdgeCode(gbufId, opacity) {
  let o = Math.round(opacity * 255);
  if (o < 1) o = 1;
  else if (o > 255) o = 255;
  return gbufId * 256 + o;
}

/** A row that stops nothing (a lamp with no walls in reach). */
export function writeEmptyWallRow(out, o) {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 0;
}

/**
 * Write a lamp's row from its visibility polygon. The lamp and the floor's scale are WALL_ROW_ARGS.
 * @param {Float32Array} out the rows
 * @param {number} o the row's first float
 * @param {Float32Array} xs the polygon's vertices (world px), in the sweep's order (rising atan2 around the lamp)
 * @param {Float32Array} ys
 * @param {Float32Array} codes each vertex's own code: 0 where its ray hit nothing, else the wall it hit (wallEdgeCode)
 * @param {number} n vertices (at most the maxVerts the row was sized for)
 * @returns {number} the vertices written (0: the row stops nothing)
 */
export function writeWallRow(out, o, xs, ys, codes, n) {
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
  // The directions' index (OL-8): for each bin, the vertex before the last one at or under the bin's start (one early,
  // so a direction the shader rounds into the bin before still finds its edge by walking on). Counted: a vertex is at
  // or under bin b's start, ang0 + b / 64, from bin ceil(64 * (its angle - ang0)) on (the angles are float32 and under
  // 8, so that difference and its product are exact); each vertex marks that bin, and the running count of the marks
  // is how many vertices each bin sees, in integers, with no branch a bin. It was a walk of the 256 bins against the
  // vertices' angles, a comparison a bin and a branch that ends on a different vertex each time. Two other forms were
  // slower (wallRowMicrobench, 2026-11-18): filling the bins by runs as the vertices go by wins under 32 vertices and
  // loses 18 % at 128 (its inner loop ends on a different bin each vertex), and counting in the row's own floats
  // carries the count through a float each bin.
  const marks = BIN_MARKS;
  for (let b = 0; b <= WALL_BINS; b++) marks[b] = 0;
  for (let i = 0; i < n; i++) {
    const rx = Math.fround(xs[i] - lx);
    const ry = Math.fround((ys[i] - ly) * floorInv);
    if (i > 0) {
      // Unwrapped: each vertex turns on from the one before it, never back (two vertices on one ray may read an ulp apart).
      const raw = wallAngle(rx, ry);
      let step = raw - prevRaw;
      if (step < -2) step += 4;
      else if (step > 2) step -= 4;
      if (step > 0) turned += step;
      if (turned > 4) turned = 4;
      prevRaw = raw;
      // The first bin that starts at or over this vertex's angle; a whole turn on, none (the scratch's last slot).
      let reach = Math.ceil(64 * (Math.fround(ang0 + turned) - ang0)) | 0;
      if (reach > WALL_BINS) reach = WALL_BINS;
      marks[reach]++;
    }
    const v = v0 + 4 * i;
    out[v] = rx;
    out[v + 1] = ry;
    out[v + 2] = ang0 + turned;
    // The edge from this vertex to the next lies on the wall the next vertex hit, or, where that ray is free, on the wall
    // this one hit: an edge stops nothing only when both its ends are free rays (the far boundary). A wall's last hit
    // and the free ray after it are usually one ray (an edge with no width); in a merged polygon (a compound solid in
    // reach: a vertex a polar bin) they are a bin apart, and the edge between them is the wall's shadow line.
    const next = codes[i + 1 < n ? i + 1 : 0];
    out[v + 3] = next !== 0 ? next : codes[i];
  }
  const close = v0 + 4 * n;
  out[close] = x0;
  out[close + 1] = y0;
  out[close + 2] = ang0 + 4;
  out[close + 3] = 0;

  // The running count: the vertices after the first that a bin's start is at or over; the one before the last of them.
  const bins = o + 4;
  let seen = 0;
  for (let b = 0; b < WALL_BINS; b++) {
    seen += marks[b];
    out[bins + b] = seen > 1 ? seen - 1 : 0;
  }
  out[o] = n;
  out[o + 1] = ang0;
  out[o + 2] = lx;
  out[o + 3] = ly * floorInv;
  return n;
}

/**
 * The shaders' wallVisibility in JS (the tests' reference, and the formula's one place in words): the share of a lamp's
 * light that reaches floor point (px, py), from the lamp's row.
 * @param {Float32Array} rows
 * @param {number} o the row's first float
 * @param {number} px the floor point
 * @param {number} py
 * @param {number} selfId the G-buffer id of the entity whose sprite covers the pixel (0: none)
 * @param {number} [depth] lighting.wallDepth: px the light enters a wall from the edge it reaches (0: its own pixels, whole)
 * @returns {number} 0..1
 */
export function wallRowLight(rows, o, px, py, selfId, depth = 0) {
  const n = rows[o] | 0;
  if (n < 3) return 1;
  const ang0 = rows[o + 1];
  const vx = Math.fround(px - rows[o + 2]);
  const vy = Math.fround(py - rows[o + 3]);
  let a = wallAngle(vx, vy);
  if (a < ang0) a = Math.fround(a + 4);
  let b = Math.floor((a - ang0) * (WALL_BINS / 4));
  if (b > WALL_BINS - 1) b = WALL_BINS - 1;
  if (b < 0) b = 0;
  const v0 = o + 4 * WALL_VERT0;
  let e = rows[o + 4 + b] | 0;
  for (let s = 0; s < WALL_WALK; s++) {
    if (e + 1 >= n || rows[v0 + 4 * (e + 1) + 2] > a) break;
    e++;
  }
  const at = v0 + 4 * e;
  const code = rows[at + 3];
  if (code < 0.5) return 1;
  const ax = rows[at];
  const ay = rows[at + 1];
  const ex = rows[at + 4] - ax;
  const ey = rows[at + 5] - ay;
  // The vertices turn with rising atan2 around the lamp, so the lamp's side of an edge is where this cross is positive.
  const len = Math.sqrt(ex * ex + ey * ey);
  const inside = (ex * (vy - ay) - ey * (vx - ax)) / (len > 1e-4 ? len : 1e-4);
  let lit = inside + 0.5;
  if (lit >= 1) return 1;
  if (lit < 0) lit = 0;
  const owner = Math.floor(code / 256);
  const opacity = (code - owner * 256) / 255;
  let beyond = WALL_UMBRA + (1 - WALL_UMBRA) * (1 - opacity);
  if (depth > 0) {
    let into = 1 + inside / depth;
    if (into < 0) into = 0;
    else if (into > 1) into = 1;
    beyond += (1 - beyond) * into * into * (3 - 2 * into);
  } else if (selfId > 0.5 && Math.abs(owner - selfId) < 0.5) {
    beyond = 1;
  }
  return beyond + (1 - beyond) * lit;
}
