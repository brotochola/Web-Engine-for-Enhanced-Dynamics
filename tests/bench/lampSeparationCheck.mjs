#!/usr/bin/env node
/**
 * DX-SHADOW3D's separate lights against the design (plan §8.2, §6.7: "each light is taken out by its own shadow"): a box
 * casts the sun's shadow on the white floor and a lamp (that casts no shadow) lights that floor
 * (checks/lampSeparationScene.js). Every floor pixel should read
 *
 *   ambient + night + sun · I · (1 - shadowAlpha inside the sun's shadow, 1 outside) + lamp · I_l / (I_l + h² + d²)
 *
 * (I_l = (radius / 10)², the lamp raised h px, d its floor distance), clamped at 1: the sun's shadow takes out the sun
 * alone, the lamp's light stays whole in it. The sun's shadow is the box's projection (the hull of its corners' landings,
 * plan §6.6), worked out here; pixels within --edge px of its outline are left out. Also printed: how much of the
 * lamp's light the shadow kept (1 is all of it; today's sprite shadows keep 1 - their alpha).
 *
 *   node tests/bench/lampSeparationCheck.mjs [--backend webgl|webgpu|both] [--tolerance 3] [--edge 4] [--sun-shadows map|sprite]
 *     [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * Exit 0 when every compared pixel, in the shadow and around it, is within --tolerance of 255.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, HEIGHT_SCALE_Y as C } from './checks/checkShapes.js';
import { SEPARATION as L } from './checks/layouts.js';
import {
  captureStill, convexHull, distanceToOutline, insidePolygon, parseCheckCli, percentile, queryOf, rgbAt, sunGeometry, sunRgb,
  verdict, withCheckBrowser,
} from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/lampSeparationCheck.mjs [--backend webgl|webgpu|both] [--tolerance 3] [--edge 4] [--sun-shadows map|sprite] [--save dir] [--headless]';

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 3, usage: USAGE, flags: { edge: 4, sunShadows: 'map' } });
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      const query = queryOf(opts, { backend, sunShadows: opts.sunShadows });
      const save = opts.save ? path.join(opts.save, `lampSeparation-${opts.sunShadows}-${backend}.png`) : null;
      const { pixels, sun, errors } = await captureStill(ctx, {
        scene: '/tests/bench/checks/lampSeparationScene.js',
        sceneExport: 'LampSeparationScene',
        query,
        waitMs: opts.waitMs,
        save,
      });
      const geo = sunGeometry(sun, G);
      const rgb = sunRgb(sun);
      // The box's sun shadow on the floor (screen px): base corners and its top's corners landed.
      const b = L.box;
      const fy = b.y / G;
      const z = b.height / C;
      const pts = [];
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = b.x + (sx * b.width) / 2;
        const y = fy + (sy * b.depth) / 2;
        pts.push([x, y], [x - z * geo.k[0], y - z * geo.k[1]]);
      }
      const shadow = convexHull(pts).map(([x, y]) => [x, y * G]);
      const lamp = L.lamp;
      const I = (lamp.radius * lamp.radius) / 100;
      const lampRgb = [(lamp.color >> 16) & 255, (lamp.color >> 8) & 255, lamp.color & 255].map((v) => v / 255);
      const inside = { deltas: [], worst: null, kept: [] };
      const outside = { deltas: [], worst: null };
      for (let v = 2; v < pixels.height - 2; v++) {
        for (let u = 2; u < pixels.width - 2; u++) {
          const x = u + 0.5;
          const y = v + 0.5;
          if (distanceToOutline(x, y, shadow) < opts.edge) continue;
          const dx = x - lamp.x;
          const dy = (y - lamp.y) / G;
          const fall = (lamp.brightness * I) / (I + lamp.elevation * lamp.elevation + dx * dx + dy * dy);
          // Only where the lamp counts: that is what the shadow must keep.
          if (fall < 0.08) continue;
          const shaded = insidePolygon(x, y, shadow);
          const vis = shaded ? 1 - sun.shadowAlpha : 1;
          const want = [0, 1, 2].map((c) => Math.min(1, L.ambient + sun.night[c] + rgb[c] * sun.intensity * vis + lampRgb[c] * fall));
          const read = rgbAt(pixels, u, v);
          const side = shaded ? inside : outside;
          for (let c = 0; c < 3; c++) {
            const delta = Math.abs(read[c] - want[c] * 255);
            side.deltas.push(delta);
            if (!side.worst || delta > side.worst.delta) side.worst = { delta, u, v, c, read: read[c], want: want[c] * 255 };
          }
          if (shaded) {
            const sunPart = L.ambient + sun.night[1] + rgb[1] * sun.intensity * vis;
            if (sunPart + lampRgb[1] * fall < 1) inside.kept.push((read[1] / 255 - sunPart) / (lampRgb[1] * fall));
          }
        }
      }
      const describe = (s) => (s.worst ? `worst ${s.worst.delta.toFixed(1)} at (${s.worst.u}, ${s.worst.v}) channel ${s.worst.c} read ${s.worst.read} want ${s.worst.want.toFixed(1)}, p99 ${percentile(s.deltas, 0.99).toFixed(1)}` : 'no pixel');
      const kept = inside.kept.length ? inside.kept.slice().sort((a, b) => a - b)[inside.kept.length >> 1] : NaN;
      console.log(`  ${backend} ${opts.sunShadows}: in the sun's shadow ${inside.deltas.length / 3} px, ${describe(inside)}; the lamp's light kept there: ${(kept * 100).toFixed(1)} %`);
      console.log(`  ${backend} ${opts.sunShadows}: around it ${outside.deltas.length / 3} px, ${describe(outside)}`);
      if (errors.length) console.log(`  ${backend}: page errors: ${errors.slice(0, 3).join(' | ')}`);
      verdict(
        `lampSeparation ${backend} ${opts.sunShadows}`,
        errors.length === 0 && inside.deltas.length > 0 && outside.deltas.length > 0 && inside.worst.delta <= opts.tolerance && outside.worst.delta <= opts.tolerance,
        `the sun's shadow keeps the lamp's light (${(kept * 100).toFixed(1)} % kept), within ${opts.tolerance} of 255; sun ${sun.intensity.toFixed(3)} at ${sun.elevation.toFixed(1)} deg, shadowAlpha ${sun.shadowAlpha}`,
      );
    }
  });
}

await main();
