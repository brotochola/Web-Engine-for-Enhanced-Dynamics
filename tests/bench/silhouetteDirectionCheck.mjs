#!/usr/bin/env node
/**
 * DX-DIRSPRITE's shadows against the design (plan §8.2, §5.5, §6.3): each light casts the frame it sees. A person drawn
 * from 4 directions (checks/silhouetteDirectionScene.js: 30 px wide from the front and the back, 12 from the side)
 * stands facing south with the sun in the east: the camera sees the front, the sun the side, so the shadow is the
 * profile's card, standing on the profile's base (its feet's ellipse) and running west. Across the sun (north to south
 * on the floor) the shadow is as wide as the profile, 12 floor px (12 · floorScaleY on the screen), not the front's 30;
 * its middle is the base's centre, one ellipse radius north of the lowest row. The control faces the person east,
 * towards the sun, which then sees the front: 30 px.
 *
 *   node tests/bench/silhouetteDirectionCheck.mjs [--backend webgl|webgpu|both] [--tolerance 1.5] [--sun-shadows map|sprite]
 *     [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * Measured on the floor west of the person, column by column (the median over the columns), with the formula's two
 * levels (ambient + sun, ambient + sun · (1 - shadowAlpha)) telling shadow from light. Exit 0 when the width and the
 * middle are within --tolerance px for both facings.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, HEIGHT_SCALE_Y as C, PICTURES, pictureBase, pictureBounds } from './checks/checkShapes.js';
import { SILHOUETTE as L } from './checks/layouts.js';
import { captureStill, parseCheckCli, queryOf, sunGeometry, sunRgb, verdict, withCheckBrowser } from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/silhouetteDirectionCheck.mjs [--backend webgl|webgpu|both] [--tolerance 1.5] [--sun-shadows map|sprite] [--save dir] [--headless]';

/** The frame each facing shows the sun in the east: south shows it the side, east the front. */
const CASES = [
  { facing: 90, frame: 'stand_left', seen: 'the profile' },
  { facing: 0, frame: 'stand_down', seen: 'the front' },
];

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
}

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 1.5, usage: USAGE, flags: { sunShadows: 'map' } });
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      let allOk = true;
      for (const kase of CASES) {
        const query = queryOf(opts, { backend, facing: kase.facing, sunShadows: opts.sunShadows });
        const save = opts.save ? path.join(opts.save, `silhouette-${kase.facing}-${backend}.png`) : null;
        const { pixels, sun, errors } = await captureStill(ctx, {
          scene: '/tests/bench/checks/silhouetteDirectionScene.js',
          sceneExport: 'SilhouetteDirectionScene',
          query,
          waitMs: opts.waitMs,
          save,
        });
        const geo = sunGeometry(sun, G);
        const rgb = sunRgb(sun);
        const lit = [0, 1, 2].map((c) => Math.min(1, L.ambient + sun.night[c] + rgb[c] * sun.intensity)).reduce((a, b) => a + b) / 3;
        const shade = [0, 1, 2].map((c) => Math.min(1, L.ambient + sun.night[c] + rgb[c] * sun.intensity * (1 - sun.shadowAlpha))).reduce((a, b) => a + b) / 3;
        const cut = (lit + shade) / 2;
        // The expected card: the seen frame's width across the sun, centred on its base's centre (floor), as long as its
        // height over heightScaleY times |k|.
        const P = PICTURES.walker;
        const base = pictureBase('walker', kase.frame);
        const [x0, y0, x1] = pictureBounds('walker', kase.frame);
        const width = (x1 - x0) * G;
        const middle = L.walker.y + (base.bottom - P.footY) - base.ry * G;
        const length = ((base.bottom - y0) / C) * Math.sqrt(geo.k[0] * geo.k[0] + geo.k[1] * geo.k[1]);
        // Columns west of what the person's sprite hides (its widest frame), inside the shadow's length.
        const front = pictureBounds('walker', 'stand_down');
        const from = Math.ceil(L.walker.x - P.footX + front[0]) - 4;
        const to = Math.floor(L.walker.x - length * 0.85);
        const widths = [];
        const middles = [];
        for (let x = from; x > to; x--) {
          let n = 0;
          let sum = 0;
          for (let y = Math.round(middle - 30); y <= Math.round(middle + 30); y++) {
            const o = (y * pixels.width + x) * 4;
            const read = (pixels.data[o] + pixels.data[o + 1] + pixels.data[o + 2]) / (3 * 255);
            if (read < cut) {
              n++;
              sum += y + 0.5;
            }
          }
          if (n > 0) {
            widths.push(n);
            middles.push(sum / n);
          }
        }
        const w = median(widths);
        const m = median(middles);
        const ok = errors.length === 0 && widths.length >= 10 && Math.abs(w - width) <= opts.tolerance && Math.abs(m - middle) <= opts.tolerance;
        if (!ok) allOk = false;
        console.log(
          `  ${ok ? 'ok  ' : 'BAD '}${backend} facing ${kase.facing} (the sun sees ${kase.seen}): shadow ${w} px across (want ${width.toFixed(2)}), ` +
            `middle at y ${m.toFixed(2)} (want ${middle.toFixed(2)}), ${widths.length} columns of ${Math.max(0, from - to)}; sun ${sun.elevation.toFixed(1)} deg` +
            (errors.length ? `; page errors: ${errors.slice(0, 2).join(' | ')}` : ''),
        );
      }
      verdict(`silhouetteDirection ${backend}`, allOk, `the shadow is the frame the sun sees, within ${opts.tolerance} px`);
    }
  });
}

await main();
