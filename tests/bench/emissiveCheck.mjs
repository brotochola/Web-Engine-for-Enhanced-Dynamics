#!/usr/bin/env node
/**
 * DX-EMISSIVE against the design (plan §8.2, §6.9: "final = lit colour × light + own glow"): at night a lamp lights the
 * white floor behind a flame that glows by itself (checks/emissiveScene.js: an opaque core in a glow of alpha a =
 * 128/255), a white person in front of its right edge. Worked out here from the layout:
 *
 *   the floor:             F = ambient + lamp · I_l / (I_l + h² + d²)        (I_l = (radius / 10)², d on the floor)
 *   through the glow:      (1 - a) · F + a · flame        (what is behind keeps its own light; the glow is not lit)
 *   the core:              flame                          (its colour, not darkened by the night)
 *   the person over it:    the person's own pixels a px beyond the flame (it covers glow and floor alike)
 *
 *   node tests/bench/emissiveCheck.mjs [--backend webgl|webgpu|both] [--tolerance 3] [--save dir] [--headless]
 *     [--wait-ms 3000] [--query k=v]
 *
 * Pixels within 1 px of a part's edge are left out. Exit 0 when the floor, the glow and the core are each within
 * --tolerance of 255, and the person over the flame within 2 x --tolerance of itself beside it.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, PICTURES, pictureAlpha } from './checks/checkShapes.js';
import { EMISSIVE as L } from './checks/layouts.js';
import { captureStill, parseCheckCli, percentile, queryOf, rgbAt, verdict, withCheckBrowser } from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/emissiveCheck.mjs [--backend webgl|webgpu|both] [--tolerance 3] [--save dir] [--headless]';

function stat() {
  return { deltas: [], worst: null };
}

function add(s, u, v, read, want) {
  for (let c = 0; c < 3; c++) {
    const delta = Math.abs(read[c] - want[c] * 255);
    s.deltas.push(delta);
    if (!s.worst || delta > s.worst.delta) s.worst = { delta, u, v, c, read: read[c], want: want[c] * 255 };
  }
}

function describe(name, s) {
  if (!s.worst) return `${name}: no pixel`;
  return `${name} ${s.deltas.length / 3} px, worst ${s.worst.delta.toFixed(1)} at (${s.worst.u}, ${s.worst.v}) channel ${s.worst.c} read ${s.worst.read} want ${s.worst.want.toFixed(1)}, p99 ${percentile(s.deltas, 0.99).toFixed(1)}`;
}

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 3, usage: USAGE });
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      const query = queryOf(opts, { backend });
      const save = opts.save ? path.join(opts.save, `emissive-${backend}.png`) : null;
      const { pixels, errors } = await captureStill(ctx, { scene: '/tests/bench/checks/emissiveScene.js', sceneExport: 'EmissiveScene', query, waitMs: opts.waitMs, save });
      const F = PICTURES.flame;
      const B = PICTURES.walker;
      const flameRgb = F.color.map((v) => v / 255);
      const lamp = L.lamp;
      const I = (lamp.radius * lamp.radius) / 100;
      const floor = (x, y) => {
        const dx = x - lamp.x;
        const dy = (y - lamp.y) / G;
        return Math.min(1, L.ambient + (lamp.brightness * I) / (I + lamp.elevation * lamp.elevation + dx * dx + dy * dy));
      };
      // What covers a screen pixel: the flame's alpha there, the person's.
      const flameA = (u, v) => {
        const px = u - (L.flame.x - F.footX);
        const py = v - (L.flame.y - F.footY);
        return px >= 0 && py >= 0 && px < F.w && py < F.h ? pictureAlpha('flame', 'flame', px, py) : 0;
      };
      const person = (u, v) => {
        const px = u - (L.blocker.x - B.footX);
        const py = v - (L.blocker.y - B.footY);
        return px >= 0 && py >= 0 && px < B.w && py < B.h && pictureAlpha('walker', 'stand_down', px, py) > 127;
      };
      // The same in a 3 x 3 neighbourhood: away from every edge.
      const steady = (u, v) => {
        const a = flameA(u, v);
        const p = person(u, v);
        for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (flameA(u + du, v + dv) !== a || person(u + du, v + dv) !== p) return null;
        return { a, p };
      };
      const sFloor = stat();
      const sGlow = stat();
      const sCore = stat();
      const sPerson = stat();
      const x0 = L.flame.x - F.footX - 20;
      const x1 = L.flame.x - F.footX + F.w + 20;
      const y0 = L.flame.y - F.footY - 20;
      const y1 = L.flame.y - F.footY + F.h + 20;
      for (let v = y0; v < y1; v++) {
        for (let u = x0; u < x1; u++) {
          const s = steady(u, v);
          if (s === null) continue;
          const read = rgbAt(pixels, u, v);
          const f = floor(u + 0.5, v + 0.5);
          if (s.p) {
            if (s.a > 0) {
              // The person over the flame against the person beside it (the first column past the flame's right edge).
              let w = u;
              while (flameA(w, v) > 0 || flameA(w - 1, v) > 0) w++;
              if (person(w, v) && person(w + 1, v)) add(sPerson, u, v, read, rgbAt(pixels, w + 1, v).map((x) => x / 255));
            }
            continue;
          }
          if (s.a === 0) add(sFloor, u, v, read, [f, f, f]);
          else if (s.a === 255) add(sCore, u, v, read, flameRgb);
          else {
            const a = s.a / 255;
            add(sGlow, u, v, read, flameRgb.map((c) => Math.min(1, (1 - a) * f + a * c)));
          }
        }
      }
      console.log(`  ${backend}: ${describe('floor', sFloor)}`);
      console.log(`  ${backend}: ${describe('through the glow', sGlow)}`);
      console.log(`  ${backend}: ${describe('the core', sCore)}`);
      console.log(`  ${backend}: ${describe('the person over the flame', sPerson)}`);
      if (errors.length) console.log(`  ${backend}: page errors: ${errors.slice(0, 3).join(' | ')}`);
      const within = (s, t) => s.worst !== null && s.worst.delta <= t;
      verdict(
        `emissive ${backend}`,
        errors.length === 0 && within(sFloor, opts.tolerance) && within(sGlow, opts.tolerance) && within(sCore, opts.tolerance) && within(sPerson, 2 * opts.tolerance),
        `what is seen through the flame keeps its own light, the flame its colour (tolerance ${opts.tolerance})`,
      );
    }
  });
}

await main();
