// OL-4: the walls' rows, from a real pre-render worker to what the light pass will read. The worker (tests/helpers/
// visibilityWired.mjs) gathers each light's walls, sweeps them in visibilitySweep.wasm and publishes a row a lamp
// (src/render/visibility/lampWallRow.js) instead of the polygon the old pass drew as a fan. Here the same frames run
// both ways on the same scene: the polygons are the truth, and every row must say what its light's polygon says, through
// wallRowLight (the shaders' lookup in JS): a point inside the polygon is lit, a point behind a wall keeps what the wall
// lets through, and a wall's own pixels (the entity an edge names) are lit beyond its edge.
import test from 'node:test';
import assert from 'node:assert/strict';

import { gbufEntityId } from '../../src/render/gbufWord.js';
import { WALL_UMBRA, WALL_VERT0, wallRowLight } from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bootPreRender, bootPreRenderGather, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const SCENE = { lights: 24, boxes: 150, circles: 50, polygons: 30, rings: 5, blockHalf: 0.25 };

/** The scene without collider offsets, so an occluder's outline is where its entity says. */
function scene(seed) {
  const s = makeScene(seed, SCENE);
  for (const e of s.ents) {
    e.offX = 0;
    e.offY = 0;
  }
  return s;
}

/** Even-odd point in polygon, and the point's distance to the polygon's nearest edge. */
function polygonAt(light, px, py) {
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = light.n - 1; i < light.n; j = i++) {
    const ax = light.x[j];
    const ay = light.y[j];
    const bx = light.x[i];
    const by = light.y[i];
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

/**
 * How far outside an occluder a point is, negative inside it (boxes and circles: the shapes that are easy to say).
 */
function outsideBy(e, x, y, px, py, angle) {
  if (e.kind === 'circle') return Math.sqrt((px - x) ** 2 + (py - y) ** 2) - e.r;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lx = (px - x) * c + (py - y) * s;
  const ly = -(px - x) * s + (py - y) * c;
  const dx = Math.abs(lx) - e.w / 2;
  const dy = Math.abs(ly) - e.h / 2;
  if (dx > 0 || dy > 0) return Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
  return -Math.min(-dx, -dy);
}

async function compare(t, boot) {
  const sc = scene(20261118);
  const frames = [0, 0.9, 2.3];
  const fans = await boot(sc, { rows: false });
  const polygons = frames.map((time) => {
    writeFrame(fans, time);
    return runFrame(fans);
  });
  const rowsBoot = await boot(sc, { rows: true });
  const rand = mulberry32(99);
  const totals = { lights: 0, rows: 0, lit: 0, shaded: 0, owned: 0, outlines: 0 };
  frames.forEach((time, f) => {
    writeFrame(rowsBoot, time);
    const out = runFrame(rowsBoot);
    assert.ok(out.rows, 'the worker publishes rows');
    assert.equal(out.lights.length, 0, 'and no polygon for a fan');
    assert.equal(out.selfLit.length, 0, 'nor a self-lit list');
    const rowOf = new Map(out.rows.lamps.map((lamp, r) => [lamp, r]));
    assert.equal(rowOf.size, out.rows.lamps.length, 'a lamp has one row');
    for (const light of polygons[f].lights) {
      totals.lights++;
      const ent = sc.ents[light.idx];
      const radius = ent.sqrtI * 10;
      // A light the sweep gave nothing to stop (no walls in reach, or it casts no shadow) is the plain 32-gon, and has no row.
      const seen = polygons[f].selfLit.filter((item) => item.endsWith(`@${light.idx}`)).map((item) => Number(item.split('@')[0]));
      if (!rowOf.has(light.idx)) {
        assert.equal(seen.length, 0, `light ${light.idx} has no row, so its polygon shows no wall`);
        continue;
      }
      totals.rows++;
      const o = rowOf.get(light.idx) * out.rows.rowFloats;
      const rows = out.rows.f32;
      assert.equal(rows[o], light.n, `light ${light.idx}: the row holds its polygon's vertices`);
      assert.ok(Math.abs(rows[o + 2] - light.lx) < 1e-3 && Math.abs(rows[o + 3] - light.ly) < 1e-3, 'at its lamp');

      // 1. Lit and shaded as the polygon says.
      for (let k = 0; k < 120; k++) {
        const a = rand() * Math.PI * 2;
        const d = radius * (0.03 + 0.95 * rand());
        const px = light.lx + Math.cos(a) * d;
        const py = light.ly + Math.sin(a) * d;
        const at = polygonAt(light, px, py);
        if (at.nearest < 2) continue;
        const got = wallRowLight(rows, o, px, py, 0);
        if (at.inside) {
          assert.equal(got, 1, `frame ${f} light ${light.idx}: (${px}, ${py}) is inside the polygon`);
          totals.lit++;
        } else {
          assert.ok(got >= WALL_UMBRA - 1e-6 && got < 1 - 1e-3, `frame ${f} light ${light.idx}: (${px}, ${py}) is behind a wall, reads ${got}`);
          totals.shaded++;
        }
      }

      // 2. Each edge that names a wall: the wall is one this light sees, and the edge touches it. With both its ends on
      //    the wall it runs along it (or through it: the sweep takes a box seen corner-on from one tangent corner to the
      //    other, a chord inside it), and there the wall's own pixels stay lit beyond the edge while any other pixel keeps
      //    what the wall lets through. With one end on it, it is the wall's shadow line, out to the next ray.
      const seenIds = new Set(seen.map((e) => gbufEntityId(e)));
      const v0 = o + 4 * WALL_VERT0;
      for (let i = 0; i < light.n; i++) {
        const code = rows[v0 + 4 * i + 3];
        if (code < 0.5) continue;
        const id = Math.floor(code / 256);
        const opacity = (code - id * 256) / 255;
        assert.ok(seenIds.has(id), `frame ${f} light ${light.idx}: edge ${i} names wall ${id}, which the light's fan pass lit too`);
        const ax = rows[v0 + 4 * i];
        const ay = rows[v0 + 4 * i + 1];
        const bx = rows[v0 + 4 * i + 4];
        const by = rows[v0 + 4 * i + 5];
        const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
        const mx = light.lx + (ax + bx) / 2;
        const my = light.ly + (ay + by) / 2;
        const entity = id - 1;
        const wall = sc.ents[entity];
        assert.ok(Math.abs(opacity - wall.block) < 1 / 255, `wall ${entity}'s opacity (${wall.block}) rides in its edge's code (${opacity})`);
        // Boxes and circles: the shapes whose outline is easy to say. Not in a merged polygon (a compound solid in reach:
        // a vertex a polar bin, 512 of them): there a vertex is where its bin's ray meets the swept polygon, anywhere
        // along one of its edges, and an edge between two walls that overlap is named for the one it ends on.
        if (len < 6 || light.n >= 500 || (wall.kind !== 'box' && wall.kind !== 'circle')) continue;
        const x = boundX(wall, time);
        const y = boundY(wall, time);
        const angle = (wall.angle || 0) + (wall.spin || 0) * time;
        const startOut = outsideBy(wall, x, y, light.lx + ax, light.ly + ay, angle);
        const endOut = outsideBy(wall, x, y, light.lx + bx, light.ly + by, angle);
        // An edge named for another wall would have neither end on this one.
        assert.ok(startOut < 1 || endOut < 1, `frame ${f} light ${light.idx}: edge ${i} touches wall ${entity} (its ends are ${startOut} and ${endOut} px outside it)`);
        totals.outlines++;
        if (!(startOut < 1 && endOut < 1)) continue;
        const off = outsideBy(wall, x, y, mx, my, angle);
        assert.ok(off < 0.75, `frame ${f} light ${light.idx}: edge ${i} runs along wall ${entity} (${off} px outside it)`);
        // Just beyond the edge, on the lamp's ray through its middle (so the point's direction is still this edge's), far
        // enough to be 2.5 px past the edge's line. An edge the ray grazes is left out: the point would be far along it.
        let nx = by - ay;
        let ny = -(bx - ax);
        const rx = (ax + bx) / 2;
        const ry = (ay + by) / 2;
        if (nx * rx + ny * ry < 0) {
          nx = -nx;
          ny = -ny;
        }
        const reach = Math.sqrt(rx * rx + ry * ry);
        const across = (nx * rx + ny * ry) / (len * reach);
        if (across < 0.25) continue;
        const qx = mx + (rx / reach) * (2.5 / across);
        const qy = my + (ry / reach) * (2.5 / across);
        if (polygonAt(light, qx, qy).inside) continue;
        const own = wallRowLight(rows, o, qx, qy, id);
        const other = wallRowLight(rows, o, qx, qy, 0);
        assert.equal(own, 1, `frame ${f} light ${light.idx}: wall ${entity}'s own pixel beyond its edge ${i} is lit`);
        assert.ok(Math.abs(other - (WALL_UMBRA + (1 - WALL_UMBRA) * (1 - opacity))) < 1e-3, `and another pixel there keeps what the wall lets through (${other})`);
        totals.owned++;
      }
    }
  });
  t.diagnostic(JSON.stringify(totals));
  assert.ok(totals.rows >= 30 && totals.lit > 1500 && totals.shaded > 800 && totals.owned > 300 && totals.outlines > 150, `enough was compared: ${JSON.stringify(totals)}`);
}

/** writeFrame's place of an entity at time t (the helper bounces them in the world). */
function bounce(x0, v, t, lo, hi) {
  const span = hi - lo;
  let u = (x0 - lo + v * t) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u <= span ? u : 2 * span - u);
}
const boundX = (e, t) => Math.fround(bounce(e.x, e.vx, t, 20, 2400 - 20));
const boundY = (e, t) => Math.fround(bounce(e.y, e.vy, t, 20, 1800 - 20));

test('the rows say what the polygons say (the JS gather)', async (t) => {
  await compare(t, (sc, opts) => bootPreRender(sc, { ...opts, maxNeighbors: 512 }));
});

test('the rows say what the polygons say (the gather in visibilityGather.wasm)', async (t) => {
  await compare(t, (sc, opts) => bootPreRenderGather(sc, { ...opts, maxNeighbors: 512 }));
});
