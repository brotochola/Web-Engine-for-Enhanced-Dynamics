#!/usr/bin/env node
/**
 * DX-DEPTH against the design (plan §8.2, §6.5, F5): a person walks 12 places around a table turned 45 degrees and around
 * a barn (checks/depthSortScene.js; both with height maps, the person without). Where the two overlap, each pixel shows
 * whichever is nearer the camera on the floor: a pixel of a sprite with a height map stands at its own floor y,
 * (screen y + heightScaleY · z) / floorScaleY, which for a surface point is the floor y of that point; a sprite without
 * one stands at its foot. Worked out here from the shapes' geometry (checks/checkShapes.js), not from the maps. The
 * scene has no light: the person is red, the object blue.
 *
 *   node tests/bench/depthSortCheck.mjs [--backend webgl|webgpu|both] [--objects table,barn] [--positions 0-11]
 *     [--margin 1] [--allow 0.005] [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * Compared: the pixels where both are opaque one px around (edges are blended in painter order, as a PNG), and the two
 * floor depths more than --margin floor px apart. Also counted: the pixels where the right answer is not the painter's
 * (the person's foot against the object's), which only the per-pixel depth gets right. Exit 0 when at every place the
 * wrong pixels are at most --allow of those compared (and 2 px).
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, PICTURES, SOLIDS, pictureAlpha, rayHit } from './checks/checkShapes.js';
import { DEPTH as L, depthPlace } from './checks/layouts.js';
import { VIEWPORT, captureStill, parseCheckCli, queryOf, verdict, withCheckBrowser } from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/depthSortCheck.mjs [--backend webgl|webgpu|both] [--objects table,barn] [--positions 0-11] [--margin 1] [--allow 0.005] [--save dir] [--headless]';

function positions(spec) {
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  return String(spec).split(',').map(Number);
}

/** What each screen pixel near the two sprites is: coverage of each and the object's floor y there. */
function layout(object, person) {
  const W = VIEWPORT.width;
  const H = VIEWPORT.height;
  const o = L[object];
  const s = SOLIDS[object];
  const P = PICTURES.walker;
  const objFloor = new Float32Array(W * H).fill(NaN);
  const personAt = new Uint8Array(W * H);
  for (let v = o.y - s.footY; v < o.y - s.footY + s.h; v++) {
    for (let u = o.x - s.footX; u < o.x - s.footX + s.w; u++) {
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      const hit = rayHit(object, s.facings[0], u + 0.5 - o.x, v + 0.5 - o.y);
      if (hit !== null) objFloor[v * W + u] = o.y / G + hit.p[1];
    }
  }
  for (let v = person.y - P.footY; v < person.y - P.footY + P.h; v++) {
    for (let u = person.x - P.footX; u < person.x - P.footX + P.w; u++) {
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      if (pictureAlpha('walker', 'stand_down', u - (person.x - P.footX), v - (person.y - P.footY)) > 127) personAt[v * W + u] = 1;
    }
  }
  return { objFloor, personAt };
}

function classify(pixels, u, v) {
  const o = (v * pixels.width + u) * 4;
  const r = pixels.data[o];
  const g = pixels.data[o + 1];
  const b = pixels.data[o + 2];
  if (r > 160 && g < 80 && b < 80) return 'person';
  if (b > 160 && r < 80 && g < 80) return 'object';
  return 'other';
}

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 0, usage: USAGE, flags: { objects: 'table,barn', positions: '0-11', margin: 1, allow: 0.005 } });
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      let allOk = true;
      for (const object of String(opts.objects).split(',')) {
        for (const pos of positions(opts.positions)) {
          const person = depthPlace(object, pos, G);
          const query = queryOf(opts, { backend, object, pos });
          const save = opts.save ? path.join(opts.save, `depthSort-${object}-${pos}-${backend}.png`) : null;
          const { pixels, errors } = await captureStill(ctx, {
            scene: '/tests/bench/checks/depthSortScene.js',
            sceneExport: 'DepthSortScene',
            query,
            waitMs: opts.waitMs,
            save,
          });
          const { objFloor, personAt } = layout(object, person);
          const W = VIEWPORT.width;
          const personFloor = person.y / G;
          const painterFront = person.y > L[object].y ? 'person' : 'object';
          let compared = 0;
          let wrong = 0;
          let depthOnly = 0;
          let depthOnlyRight = 0;
          let alone = 0;
          let aloneRight = 0;
          let firstWrong = null;
          const interior = (u, v, test) => {
            for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (!test((v + dv) * W + u + du)) return false;
            return true;
          };
          for (let v = 1; v < VIEWPORT.height - 1; v++) {
            for (let u = 1; u < W - 1; u++) {
              const i = v * W + u;
              const hasObj = !Number.isNaN(objFloor[i]);
              const hasPerson = personAt[i] === 1;
              if (!hasObj && !hasPerson) continue;
              const inObj = hasObj && interior(u, v, (j) => !Number.isNaN(objFloor[j]));
              const inPerson = hasPerson && interior(u, v, (j) => personAt[j] === 1);
              if (inObj && inPerson) {
                const dz = personFloor - objFloor[i];
                if (Math.abs(dz) <= opts.margin) continue;
                const want = dz > 0 ? 'person' : 'object';
                const read = classify(pixels, u, v);
                compared++;
                const right = read === want;
                if (!right) {
                  wrong++;
                  if (!firstWrong) firstWrong = `(${u}, ${v}) read ${read}, want ${want} (person ${personFloor.toFixed(1)}, object ${objFloor[i].toFixed(1)} floor y)`;
                }
                if (want !== painterFront) {
                  depthOnly++;
                  if (right) depthOnlyRight++;
                }
              } else if (inObj !== inPerson && !(hasObj && hasPerson)) {
                alone++;
                if (classify(pixels, u, v) === (inObj ? 'object' : 'person')) aloneRight++;
              }
            }
          }
          const ok = errors.length === 0 && wrong <= Math.max(2, Math.floor(compared * opts.allow)) && aloneRight >= alone * 0.99;
          if (!ok) allOk = false;
          console.log(
            `  ${ok ? 'ok  ' : 'BAD '}${backend} ${object} place ${pos} (${person.x}, ${person.y}): ${compared} overlapping px compared, ${wrong} wrong; ` +
              `${depthOnly} where the painter alone is wrong, ${depthOnlyRight} right; drawn alone ${aloneRight}/${alone} right` +
              (firstWrong ? `; first wrong ${firstWrong}` : '') +
              (errors.length ? `; page errors: ${errors.slice(0, 2).join(' | ')}` : ''),
          );
        }
      }
      verdict(`depthSort ${backend}`, allOk, `the nearer of the two shows at every overlapping pixel (margin ${opts.margin} floor px)`);
    }
  });
}

await main();
