// N-300: a lamp's row is read through WALL_BINS directions, each the vertex to start from, then at most WALL_WALK
// steps (lampWallRow.js wallRowLight, the light pass's lookup). A fence of thin posts puts many vertices in one
// direction's bin: each post its corners and the far ends of its shadow's sides. With a compound solid in reach the
// polygon is the polar merge, which now keeps those vertices among its rays (two a bin). Either way the walk must reach
// every direction's edge from its bin's start, and every point must read what the row's own polygon says (the row
// against the JS light loop's polygon is lampWallsWired.test.js's; here a kernel's event tie on these tiny posts would
// blur what this holds).
import test from 'node:test';
import assert from 'node:assert/strict';

import { WALL_BINS, WALL_UMBRA, WALL_VERT0, WALL_WALK, wallAngle, wallRowLight } from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bootPreRender, polarRayVertices, ringTriangles, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const LX = 1200;
const LY = 900;
const RADIUS = 800;
// 2 px posts 4 px apart, 640 px out to the north-east, across the lamp's rays: a bin there (1/64 of wallAngle's turn
// of 4, about 1.8 degrees on a diagonal) is 20 px, five posts.
const POSTS = 14;
const FENCE = 640;

function fenceScene(withSolid) {
  const still = { angle: 0, spin: 0, vx: 0, vy: 0, block: 1, offX: 0, offY: 0 };
  const ents = [{ kind: 'light', x: LX, y: LY, sqrtI: Math.fround(RADIUS / 10), vx: 0, vy: 0, casts: 1 }];
  const cx = LX + FENCE * Math.SQRT1_2;
  const cy = LY - FENCE * Math.SQRT1_2;
  for (let k = 0; k < POSTS; k++) {
    const s = (k - (POSTS - 1) / 2) * 4;
    ents.push({ kind: 'box', x: cx + s * Math.SQRT1_2, y: cy + s * Math.SQRT1_2, w: 2, h: 2, ...still });
  }
  let fixtures = 0;
  if (withSolid) {
    const tris = ringTriangles(18, 80, 32);
    ents.push({ kind: 'ring', x: LX - 350, y: LY + 250, tris, ...still });
    fixtures = tris.length;
  }
  return { ents, lights: 1, entities: ents.length, fixtures };
}

/** A row's vertex i: its offset to the lamp, its angle (wallAngle, unwrapped) and its edge's code. */
const vert = (o, i) => o + 4 * (WALL_VERT0 + i);

/** The row's polygon in world space: its vertices in order. */
function rowPolygon(rows, o) {
  const n = rows[o] | 0;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = rows[o + 2] + rows[vert(o, i)];
    y[i] = rows[o + 3] + rows[vert(o, i) + 1];
  }
  return { n, x, y };
}

/** Even-odd point in polygon, and the distance to its nearest edge. */
function polygonAt(poly, px, py) {
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = poly.n - 1; i < poly.n; j = i++) {
    const ax = poly.x[j];
    const ay = poly.y[j];
    const bx = poly.x[i];
    const by = poly.y[i];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0;
    const dx = px - (ax + t * ex);
    const dy = py - (ay + t * ey);
    nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy));
  }
  return { inside, nearest };
}

/** The walk as wallRowLight takes it, unbounded: the edge that covers angle `a` from vertex `e`. */
function coveringEdge(rows, o, e, a) {
  const n = rows[o] | 0;
  while (e + 1 < n && !(rows[vert(o, e + 1) + 2] > a)) e++;
  return e;
}

/** The bin's start vertex (the directions' index). */
const binStart = (rows, o, b) => rows[o + 4 + b] | 0;

/** The most steps a direction of the row needs from its bin's start: the walk to just under each bin's upper border. */
function mostSteps(rows, o) {
  const ang0 = rows[o + 1];
  let most = 0;
  for (let b = 0; b < WALL_BINS; b++) {
    const top = Math.fround(ang0 + ((b + 1) * 4) / WALL_BINS);
    const a = top - Math.abs(top) * 2 ** -22; // the last f32 angles of the bin
    const start = binStart(rows, o, b);
    const steps = coveringEdge(rows, o, start, a) - start;
    if (steps > most) most = steps;
  }
  return most;
}

for (const [withSolid, maxVerts] of [[false, 512], [true, 512], [true, 5000]]) {
  test(`a fence of thin posts, ${withSolid ? `near a compound solid (the polar merge), maxVerts ${maxVerts}` : 'the sweep alone'}: the walk reaches every direction's edge, and every point reads what the polygon says`, async (t) => {
    const sc = fenceScene(withSolid);
    const worker = await bootPreRender(sc, { maxVerts, maxNeighbors: 64 });
    writeFrame(worker, 0);
    const out = runFrame(worker);
    const r = out.lamps.indexOf(0);
    assert.ok(r >= 0, 'the lamp has a row');
    const o = r * out.rowFloats;
    const rows = out.f32;
    if (withSolid) assert.ok(polarRayVertices(rows, o) >= 3, `the merge ran (${polarRayVertices(rows, o)} vertices on its rays)`);
    const poly = rowPolygon(rows, o);
    const steps = mostSteps(rows, o);
    // Points across the fence's directions, in front of it and in its shadows (N-409: those on a shadow side's sliver of
    // directions too, read against its segment).
    const rand = mulberry32(0xfe7ce);
    const mid = Math.atan2(-Math.SQRT1_2, Math.SQRT1_2);
    const half = Math.atan2(POSTS * 2 + 4, FENCE);
    let lit = 0;
    let shaded = 0;
    const wrong = [];
    for (let k = 0; k < 6000; k++) {
      const a = mid + (rand() * 2 - 1) * half;
      const d = FENCE * (0.9 + 0.33 * rand());
      const px = LX + Math.cos(a) * d;
      const py = LY + Math.sin(a) * d;
      const at = polygonAt(poly, px, py);
      if (at.nearest < 0.75) continue;
      const got = wallRowLight(rows, o, px, py, 0);
      const ok = at.inside ? got === 1 : got >= WALL_UMBRA - 1e-6 && got < 1 - 1e-3;
      if (at.inside) lit++;
      else shaded++;
      if (!ok && wrong.length < 3) wrong.push(`(${px.toFixed(2)}, ${py.toFixed(2)}) ${at.inside ? 'inside' : 'behind a post'}, reads ${got}`);
    }
    t.diagnostic(`${rows[o]} vertices, at most ${steps} steps from a bin's start (WALL_BINS ${WALL_BINS}, WALL_WALK ${WALL_WALK}), ${lit} lit and ${shaded} shaded points`);
    assert.ok(steps > 8, `the fence crowds a bin (${steps} steps)`);
    assert.ok(steps <= WALL_WALK, `the walk reaches every direction's edge (${steps} steps, the walk ${WALL_WALK})`);
    assert.ok(lit > 500 && shaded > 500, `enough compared (${lit} lit, ${shaded} shaded)`);
    assert.deepEqual(wrong, [], 'every point as the polygon says');
  });
}
