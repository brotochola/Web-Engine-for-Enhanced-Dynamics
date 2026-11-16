#!/usr/bin/env node
/**
 * DX-GBUF against its formula (plan §8.2, F4): a white ball with a height map and a normal map, under the sun and then
 * under a lamp (checks/normalLightScene.js). Each pixel of the ball should read the light at its 3D point with its
 * normal, as the design writes it (§6.7), worked out here from the ball's geometry (checks/checkShapes.js), not from the
 * shader or the maps:
 *
 *   light = ambient + night + sun · I · (1 - s + s · min(max(N·S, 0) / max(S_z, 0.25), 1.6))
 *           + Σ lamp · brightness · max(N·L̂, 0) · I_l / (I_l + |L - p|²),   I_l = (radius / 10)²
 *
 * (s = lighting.faces.sunDirect, 1 in the scene: the whole sun term follows the normal), clamped at 1. The floor around
 * the ball is checked too (the floor path: ambient + sun · I, or each lamp's I_l / (I_l + h² + d²)).
 *
 *   node tests/bench/normalLightCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 3]
 *     [--strength full|auto] [--inset 3] [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * --strength auto (default): §5.4's automatic strength of the normals (k = lamps / (lamps + ambient + sun), the drawn picture's
 * light mixed towards the normals' by k) instead of the full normals. --inset: px left out at the ball's rim (grazing
 * normals and the soft edge). Exit 0 when every compared pixel is within --tolerance of 255 on every backend and part.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, SOLIDS, rayHit } from './checks/checkShapes.js';
import { NORMAL_LIGHT as L } from './checks/layouts.js';
import { captureStill, parseCheckCli, percentile, queryOf, rgbAt, sunGeometry, sunRgb, verdict, withCheckBrowser } from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/normalLightCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 3] [--strength full|auto] [--inset 3] [--save dir] [--headless]';

/** The light (0..1 a channel) at floor-space point p with normal n, as §6.7 writes it. */
function lightAt(p, n, env) {
  const flat = [0, 1, 2].map((c) => env.ambient + env.night[c]);
  const lit = flat.slice();
  if (env.sun) {
    const S = env.sun.towards;
    const ratio = Math.min(Math.max(0, n[0] * S[0] + n[1] * S[1] + n[2] * S[2]) * env.sun.w, 1.6);
    const term = 1 - env.sunDirect + env.sunDirect * ratio;
    for (let c = 0; c < 3; c++) {
      lit[c] += env.sun.rgb[c] * env.sun.intensity * term;
      flat[c] += env.sun.rgb[c] * env.sun.intensity;
    }
  }
  let lampFlat = 0;
  for (const lamp of env.lamps) {
    const lx = lamp.x - p[0];
    const ly = lamp.y / G - p[1];
    const lz = lamp.elevation - p[2];
    const d2 = lx * lx + ly * ly + lz * lz;
    const d = Math.sqrt(d2);
    const I = (lamp.radius * lamp.radius) / 100;
    const fall = (lamp.brightness * I) / (I + d2);
    const cosine = Math.max(0, (n[0] * lx + n[1] * ly + n[2] * lz) / d);
    const rgb = [(lamp.color >> 16) & 255, (lamp.color >> 8) & 255, lamp.color & 255].map((v) => v / 255);
    for (let c = 0; c < 3; c++) {
      lit[c] += rgb[c] * fall * cosine;
      flat[c] += rgb[c] * fall;
    }
    lampFlat += fall;
  }
  if (env.strength === 'auto') {
    // §5.4: k = lamps' light / (lamps + ambient + sun), per pixel; by day the picture as drawn, by a lamp its normals.
    const rest = env.ambient + (env.sun ? env.sun.intensity : 0);
    const k = lampFlat > 0 ? lampFlat / (lampFlat + rest) : 0;
    return lit.map((v, c) => Math.min(1, flat[c] + k * (v - flat[c])));
  }
  return lit.map((v) => Math.min(1, v));
}

/** The floor's light at screen (x, y): today's floor path (no normal), each lamp raised by its height. */
function floorAt(x, y, env) {
  const out = [0, 1, 2].map((c) => env.ambient + env.night[c] + (env.sun ? env.sun.rgb[c] * env.sun.intensity : 0));
  for (const lamp of env.lamps) {
    const dx = lamp.x - x;
    const dy = (lamp.y - y) / G;
    const I = (lamp.radius * lamp.radius) / 100;
    const fall = (lamp.brightness * I) / (I + lamp.elevation * lamp.elevation + dx * dx + dy * dy);
    const rgb = [(lamp.color >> 16) & 255, (lamp.color >> 8) & 255, lamp.color & 255].map((v) => v / 255);
    for (let c = 0; c < 3; c++) out[c] += rgb[c] * fall;
  }
  return out.map((v) => Math.min(1, v));
}

function compare(pixels, samples) {
  const deltas = [];
  let worst = { delta: -1 };
  for (const s of samples) {
    const read = rgbAt(pixels, s.x, s.y);
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(read[c] - s.want[c] * 255);
      deltas.push(delta);
      if (delta > worst.delta) worst = { delta, x: s.x, y: s.y, channel: c, read: read[c], want: s.want[c] * 255 };
    }
  }
  return { worst, p99: percentile(deltas, 0.99), mean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length), count: samples.length };
}

async function main() {
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 3, usage: USAGE, flags: { part: 'both', strength: 'auto', inset: 3 } });
  const parts = opts.part === 'both' ? ['sun', 'lamp'] : [opts.part];
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      for (const part of parts) {
        const query = queryOf(opts, { backend, part });
        const save = opts.save ? path.join(opts.save, `normalLight-${part}-${backend}.png`) : null;
        const { pixels, sun, errors } = await captureStill(ctx, {
          scene: '/tests/bench/checks/normalLightScene.js',
          sceneExport: 'NormalLightScene',
          query,
          waitMs: opts.waitMs,
          save,
        });
        const env = {
          ambient: L.ambient,
          night: part === 'sun' && sun.enabled ? sun.night : [0, 0, 0],
          sun: part === 'sun' ? { ...sunGeometry(sun, G), rgb: sunRgb(sun), intensity: sun.intensity } : null,
          sunDirect: 1,
          lamps: part === 'lamp' ? [L.lamp] : [],
          strength: opts.strength,
        };
        const ball = SOLIDS.ball;
        const cx = L.ball.x;
        const cy = L.ball.y - ball.radius * Math.SQRT1_2;
        const inner = ball.radius - opts.inset;
        const samples = [];
        const floor = [];
        for (let v = Math.floor(cy - ball.radius - 40); v <= Math.ceil(cy + ball.radius + 40); v++) {
          for (let u = Math.floor(cx - ball.radius - 40); u <= Math.ceil(cx + ball.radius + 40); u++) {
            const r = Math.sqrt((u + 0.5 - cx) ** 2 + (v + 0.5 - cy) ** 2);
            if (r <= inner) {
              const hit = rayHit('ball', 90, u + 0.5 - L.ball.x, v + 0.5 - L.ball.y);
              if (hit === null) continue;
              const p = [L.ball.x + hit.p[0], L.ball.y / G + hit.p[1], hit.p[2]];
              samples.push({ x: u, y: v, want: lightAt(p, hit.n, env) });
            } else if (r >= ball.radius + 8 && r <= ball.radius + 36) {
              floor.push({ x: u, y: v, want: floorAt(u + 0.5, v + 0.5, env) });
            }
          }
        }
        const b = compare(pixels, samples);
        const f = compare(pixels, floor);
        const at = (w) => `(${w.x}, ${w.y}) channel ${w.channel} read ${w.read} want ${w.want.toFixed(1)}`;
        console.log(`${backend} ${part}: ball ${b.count} px, worst ${b.worst.delta.toFixed(1)} at ${at(b.worst)}, p99 ${b.p99.toFixed(1)}, mean ${b.mean.toFixed(2)}`);
        console.log(`${backend} ${part}: floor ${f.count} px, worst ${f.worst.delta.toFixed(1)} at ${at(f.worst)}`);
        if (errors.length) console.log(`${backend} ${part}: page errors: ${errors.slice(0, 3).join(' | ')}`);
        const sunNote = env.sun ? `sun ${sun.intensity.toFixed(3)} at ${sun.elevation.toFixed(1)} deg` : 'lamp only';
        verdict(
          `normalLight ${backend} ${part}`,
          errors.length === 0 && b.count > 0 && b.worst.delta <= opts.tolerance && f.worst.delta <= opts.tolerance,
          `ball worst ${b.worst.delta.toFixed(1)}, floor worst ${f.worst.delta.toFixed(1)} of 255 (tolerance ${opts.tolerance}, strength ${opts.strength}, ${sunNote})`,
        );
      }
    }
  });
}

await main();
