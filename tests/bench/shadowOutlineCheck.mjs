#!/usr/bin/env node
/**
 * DX-SHADOW3D against its projection (plan §8.2, F6/F7): a box (setBox), a card (a picture of one view) and a crate (a
 * render with height maps, which casts its solid) under the sun from 8 directions, then around a lamp at 3 heights
 * (checks/shadowOutlineScene.js, the shadows from the maps). Each shadow's outline on the floor is compared with the
 * projection the design writes, worked out here from the shapes (checks/checkShapes.js):
 *
 *   the sun: a point (x, y, z) lands at (x, y) - z · k, k the sun's horizontal direction over its height (|k| capped at
 *     Sun.shadowMaxLengthRatio); a volume or a solid casts the hull of its corners' landings, a card stands on its base's
 *     edge towards the sun (the feet's ellipse) with its columns across the sun (plan §6.6, §17.1);
 *   a lamp at floor point L, height E: a point lands at L + ((x, y) - L) · E / (E - z), the stretch capped at 8, and a
 *     card stands on its base's edge towards the lamp, its columns across the lamp (F7).
 *
 * The floor pixels are told shadow from light by the formula's own two levels (ambient + sun or lamp, ambient alone);
 * the casters' sprites are masked. Both ways: each measured outline pixel's distance to the projection, and each point
 * of the projection's outline to the nearest measured outline pixel.
 *
 *   node tests/bench/shadowOutlineCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 1.5]
 *     [--dirs 0,45,...] [--heights 60,150,300] [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * Exit 0 when, for every caster in every capture, the 99th percentile of both distances is within --tolerance px.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, HEIGHT_SCALE_Y as C, PICTURES, SOLIDS, pictureBase, pictureBounds, rayHit, solidCorners } from './checks/checkShapes.js';
import { SHADOW_OUTLINE as L } from './checks/layouts.js';
import {
  VIEWPORT, captureStill, convexHull, distanceToOutline, insidePolygon, lampLandingPoint, outlinePoints, parseCheckCli,
  percentile, queryOf, sunGeometry, sunRgb, verdict, withCheckBrowser,
} from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/shadowOutlineCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 1.5] [--dirs 0,45] [--heights 60,150,300] [--save dir] [--headless]';
const SEARCH = 8;

/** A caster's 3D points that bound what it casts, in the floor's space (x, y on the floor, z up), with how it lands. */
function casterCorners(c) {
  const fy = c.y / G;
  if (c.kind === 'box') {
    const z = c.height / C;
    const out = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      out.push([c.x + (sx * c.width) / 2, fy + (sy * c.depth) / 2, 0]);
      out.push([c.x + (sx * c.width) / 2, fy + (sy * c.depth) / 2, z]);
    }
    return out;
  }
  return solidCorners('crate', c.facing).map(([x, y, z]) => [c.x + x, fy + y, z]);
}

/** The card's corners (floor space), standing on its base's edge towards `toward` (a unit floor direction). */
function cardCorners(c, toward) {
  const P = PICTURES.card;
  const base = pictureBase('card', 'card');
  const [x0, y0, x1] = pictureBounds('card', 'card');
  const centre = [c.x + (base.cx - P.footX), (c.y + (base.bottom - P.footY)) / G - base.ry];
  const reach = Math.sqrt(base.rx * base.rx * toward[0] * toward[0] + base.ry * base.ry * toward[1] * toward[1]);
  const foot = [centre[0] + toward[0] * reach, centre[1] + toward[1] * reach];
  return { foot, u: [x0 - base.cx, x1 - base.cx], top: (base.bottom - y0) / C };
}

/** The expected shadow of each caster on the floor, as a polygon in screen px (null: not compared, and why). */
function expectedShadows(casters, light) {
  return casters.map((c) => {
    let pts;
    if (light.sun) {
      const { k, perp, toSun } = light.sun;
      if (c.kind === 'card') {
        const { foot, u, top } = cardCorners(c, toSun);
        pts = [];
        for (const uu of u) for (const z of [0, top]) pts.push([foot[0] + uu * perp[0] - z * k[0], foot[1] + uu * perp[1] - z * k[1]]);
      } else {
        pts = casterCorners(c).map(([x, y, z]) => [x - z * k[0], y - z * k[1]]);
      }
    } else {
      const lamp = { x: light.lamp.x, y: light.lamp.y / G, elevation: light.lamp.elevation };
      let top;
      if (c.kind === 'card') {
        const P = PICTURES.card;
        const base = pictureBase('card', 'card');
        const centre = [c.x + (base.cx - P.footX), (c.y + (base.bottom - P.footY)) / G - base.ry];
        const tx = lamp.x - centre[0];
        const ty = lamp.y - centre[1];
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const card = cardCorners(c, [tx / tl, ty / tl]);
        top = card.top;
        const dx = lamp.x - card.foot[0];
        const dy = lamp.y - card.foot[1];
        const dl = Math.sqrt(dx * dx + dy * dy) || 1;
        const perp = [dy / dl, -dx / dl];
        pts = [];
        for (const uu of card.u) {
          for (const z of [0, card.top]) pts.push(lampLandingPoint([card.foot[0] + uu * perp[0], card.foot[1] + uu * perp[1], z], lamp));
        }
      } else {
        const corners = casterCorners(c);
        top = Math.max(...corners.map((p) => p[2]));
        pts = corners.map((p) => lampLandingPoint(p, lamp));
      }
      // What reaches the lamp's height casts no shadow from it, and near it the stretch is capped: not a projection.
      if (top >= lamp.elevation * 0.85) return { caster: c, polygon: null, why: `taller (${top.toFixed(0)} px) than 0.85 of the lamp's ${lamp.elevation} px` };
    }
    return { caster: c, polygon: convexHull(pts).map(([x, y]) => [x, y * G]) };
  });
}

/** The casters' own sprites on the screen (what the floor is hidden by), grown by `grow` px. */
function spriteMask(casters, grow) {
  const W = VIEWPORT.width;
  const H = VIEWPORT.height;
  const mask = new Uint8Array(W * H);
  const mark = (u, v) => {
    for (let dv = -grow; dv <= grow; dv++) {
      for (let du = -grow; du <= grow; du++) {
        const x = u + du;
        const y = v + dv;
        if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1;
      }
    }
  };
  for (const c of casters) {
    if (c.kind === 'card') {
      const P = PICTURES.card;
      const [x0, y0, x1, y1] = pictureBounds('card', 'card');
      for (let v = c.y - P.footY + y0; v < c.y - P.footY + y1; v++) for (let u = c.x - P.footX + x0; u < c.x - P.footX + x1; u++) mark(u, v);
    } else if (c.kind === 'crate') {
      const s = SOLIDS.crate;
      for (let v = c.y - s.footY; v < c.y - s.footY + s.h; v++) {
        for (let u = c.x - s.footX; u < c.x - s.footX + s.w; u++) if (rayHit('crate', c.facing, u + 0.5 - c.x, v + 0.5 - c.y) !== null) mark(u, v);
      }
    }
  }
  return mask;
}

/**
 * Compares the floor's shadows with the expected polygons. `levels(u, v)` gives the formula's lit and shadow levels at a
 * pixel (0..1, the channels' mean), or null where they are too close to tell.
 */
function compareOutlines(pixels, shadows, mask, levels) {
  const W = pixels.width;
  const H = pixels.height;
  const state = new Int8Array(W * H).fill(-1); // -1 not compared, 0 lit, 1 shadow
  for (let v = 1; v < H - 1; v++) {
    for (let u = 1; u < W - 1; u++) {
      const i = v * W + u;
      if (mask[i]) continue;
      const lv = levels(u + 0.5, v + 0.5);
      if (lv === null) continue;
      const o = i * 4;
      const read = (pixels.data[o] + pixels.data[o + 1] + pixels.data[o + 2]) / (3 * 255);
      state[i] = read < (lv.lit + lv.shadow) / 2 ? 1 : 0;
    }
  }
  const boundary = new Uint8Array(W * H);
  const outline = [];
  for (let v = 1; v < H - 1; v++) {
    for (let u = 1; u < W - 1; u++) {
      const i = v * W + u;
      if (state[i] !== 1) continue;
      if (state[i - 1] === 0 || state[i + 1] === 0 || state[i - W] === 0 || state[i + W] === 0) {
        boundary[i] = 1;
        outline.push([u + 0.5, v + 0.5]);
      }
    }
  }
  const live = shadows.filter((s) => s.polygon !== null);
  const results = shadows.map((s) => ({ caster: s.caster.kind, why: s.why, measured: [], expected: [] }));
  // Each measured outline pixel belongs to the nearest expected outline.
  for (const [x, y] of outline) {
    let best = Infinity;
    let at = -1;
    for (const s of live) {
      const d = distanceToOutline(x, y, s.polygon);
      if (d < best) {
        best = d;
        at = shadows.indexOf(s);
      }
    }
    if (at >= 0) results[at].measured.push(best);
  }
  // Each point of an expected outline: the nearest measured outline pixel (where the floor there is seen and compared).
  for (const s of live) {
    const r = results[shadows.indexOf(s)];
    for (const [x, y] of outlinePoints(s.polygon, 1)) {
      const u = Math.floor(x);
      const v = Math.floor(y);
      if (u < SEARCH || v < SEARCH || u >= W - SEARCH || v >= H - SEARCH) continue;
      let seen = true;
      for (let dv = -2; dv <= 2 && seen; dv++) for (let du = -2; du <= 2; du++) if (state[(v + dv) * W + u + du] === -1) seen = false;
      if (!seen) continue;
      if (live.some((o) => o !== s && insidePolygon(x, y, o.polygon))) continue;
      let best = SEARCH;
      for (let dv = -SEARCH; dv <= SEARCH; dv++) {
        for (let du = -SEARCH; du <= SEARCH; du++) {
          if (!boundary[(v + dv) * W + u + du]) continue;
          const d = Math.sqrt((u + du + 0.5 - x) ** 2 + (v + dv + 0.5 - y) ** 2);
          if (d < best) best = d;
        }
      }
      r.expected.push(best);
    }
  }
  return results;
}

function report(label, results, tolerance) {
  let ok = true;
  for (const r of results) {
    if (r.why) {
      console.log(`  ${label} ${r.caster}: not compared (${r.why})`);
      continue;
    }
    const m99 = percentile(r.measured, 0.99);
    const e99 = percentile(r.expected, 0.99);
    const fine = r.measured.length >= 20 && r.expected.length >= 20 && m99 <= tolerance && e99 <= tolerance;
    if (!fine) ok = false;
    console.log(
      `  ${fine ? 'ok  ' : 'BAD '}${label} ${r.caster}: measured outline ${r.measured.length} px, p99 ${m99.toFixed(2)}, max ${Math.max(...r.measured, 0).toFixed(2)}; ` +
        `projection ${r.expected.length} points, p99 ${e99.toFixed(2)}, max ${Math.max(...r.expected, 0).toFixed(2)}`,
    );
  }
  return ok;
}

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), {
    tolerance: 1.5,
    usage: USAGE,
    flags: { part: 'both', dirs: L.directions.join(','), heights: L.lampHeights.join(',') },
  });
  const parts = opts.part === 'both' ? ['sun', 'lamp'] : [opts.part];
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      let allOk = true;
      for (const part of parts) {
        const cases = part === 'sun' ? String(opts.dirs).split(',').map(Number) : String(opts.heights).split(',').map(Number);
        for (const value of cases) {
          const query = queryOf(opts, { backend, part, [part === 'sun' ? 'dir' : 'height']: value });
          const label = `${backend} ${part} ${part === 'sun' ? `from ${value} deg` : `lamp at ${value} px`}`;
          const save = opts.save ? path.join(opts.save, `shadowOutline-${part}-${value}-${backend}.png`) : null;
          const { pixels, sun, errors } = await captureStill(ctx, {
            scene: '/tests/bench/checks/shadowOutlineScene.js',
            sceneExport: 'ShadowOutlineScene',
            query,
            waitMs: opts.waitMs,
            save,
          });
          const casters = part === 'sun' ? L.sunCasters : L.lampCasters;
          let levels;
          let light;
          if (part === 'sun') {
            const rgb = sunRgb(sun);
            const lit = [0, 1, 2].map((c) => Math.min(1, L.ambient + sun.night[c] + rgb[c] * sun.intensity)).reduce((a, b) => a + b) / 3;
            const shade = [0, 1, 2].map((c) => Math.min(1, L.ambient + sun.night[c] + rgb[c] * sun.intensity * (1 - sun.shadowAlpha))).reduce((a, b) => a + b) / 3;
            levels = () => (lit - shade > 0.08 ? { lit, shadow: shade } : null);
            light = { sun: sunGeometry(sun, G) };
          } else {
            const lamp = { ...L.lamp, elevation: value };
            const I = (lamp.radius * lamp.radius) / 100;
            levels = (x, y) => {
              const dx = x - lamp.x;
              const dy = (y - lamp.y) / G;
              const fall = (lamp.brightness * I) / (I + lamp.elevation * lamp.elevation + dx * dx + dy * dy);
              const lit = Math.min(1, L.lampAmbient + fall);
              return lit - L.lampAmbient > 0.08 ? { lit, shadow: L.lampAmbient } : null;
            };
            light = { lamp };
          }
          const shadows = expectedShadows(casters, light);
          const results = compareOutlines(pixels, shadows, spriteMask(casters, 2), levels);
          const ok = report(label, results, opts.tolerance) && errors.length === 0;
          if (errors.length) console.log(`  ${label}: page errors: ${errors.slice(0, 3).join(' | ')}`);
          if (!ok) allOk = false;
        }
      }
      verdict(`shadowOutline ${backend}`, allOk, `every compared outline within ${opts.tolerance} px at the 99th percentile`);
    }
  });
}

await main();
