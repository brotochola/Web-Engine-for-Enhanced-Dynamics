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
 * (s = 1 - lighting.sun.skyLight, 1 in the scene: the whole sun term follows the normal), clamped at 1. The floor around
 * the ball is checked too (the floor path: ambient + sun · I, or each lamp's I_l / (I_l + h² + d²)).
 *
 *   node tests/bench/normalLightCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 5]
 *     [--strength 0,1] [--inset 3] [--save dir] [--headless] [--wait-ms 3000] [--query k=v]
 *
 * --strength <sun>,<lamps> (default 0,1, the engine's): lighting.normalStrength (OL-2), how much the ball's normals count
 * for the sun and for the lamps, each from 0 (the light as drawn: the formula with every cosine 1) to 1 (the formula
 * above); the scene takes the same two numbers. 1,1 checks the full normals. --inset: px left out at the ball's rim
 * (grazing normals and the soft edge). Exit 0 when every compared pixel is within --tolerance of 255 on every backend
 * and part. The tolerance is the maps' own steps at full strength: on this ball the worst pixel read 3.4 of 255 under the
 * lamp and 4.0 under the sun (p99 2.4, mean 0.6; 2026-11-18), half that at strength 0.5.
 */
import path from 'node:path';

import { FLOOR_SCALE_Y as G, SOLIDS, rayHit } from './checks/checkShapes.js';
import { NORMAL_LIGHT as L } from './checks/layouts.js';
import { captureStill, parseCheckCli, percentile, queryOf, rgbAt, sunGeometry, sunRgb, verdict, withCheckBrowser } from './checks/checkLib.mjs';

const USAGE = 'node tests/bench/normalLightCheck.mjs [--backend webgl|webgpu|both] [--part sun|lamp|both] [--tolerance 5] [--strength 0,1] [--inset 3] [--save dir] [--headless]';

/** --strength's two numbers, each in 0..1: { sun, lamps }. */
function parseStrength(text) {
  const [sun, lamps] = String(text).split(',').map(Number);
  if (!(sun >= 0 && sun <= 1 && lamps >= 0 && lamps <= 1)) throw new Error(`--strength is <sun>,<lamps>, each 0 to 1, not ${text}`);
  return { sun, lamps };
}

/**
 * The light (0..1 a channel) at floor-space point p with normal n, as §6.7 writes it, each kind of light mixed between as
 * drawn and by the normal by its strength (OL-2: lighting.normalStrength).
 */
function lightAt(p, n, env) {
  const base = [0, 1, 2].map((c) => env.ambient + env.night[c]);
  const sunFlat = [0, 0, 0];
  const sunLit = [0, 0, 0];
  const lampsFlat = [0, 0, 0];
  const lampsLit = [0, 0, 0];
  if (env.sun) {
    const S = env.sun.towards;
    const ratio = Math.min(Math.max(0, n[0] * S[0] + n[1] * S[1] + n[2] * S[2]) * env.sun.w, 1.6);
    const term = env.skyLight + (1 - env.skyLight) * ratio;
    for (let c = 0; c < 3; c++) {
      sunLit[c] = env.sun.rgb[c] * env.sun.intensity * term;
      sunFlat[c] = env.sun.rgb[c] * env.sun.intensity;
    }
  }
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
      lampsLit[c] += rgb[c] * fall * cosine;
      lampsFlat[c] += rgb[c] * fall;
    }
  }
  const { sun, lamps } = env.strength;
  return base.map((v, c) => Math.min(1, v + sunFlat[c] + sun * (sunLit[c] - sunFlat[c]) + lampsFlat[c] + lamps * (lampsLit[c] - lampsFlat[c])));
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
  const opts = parseCheckCli(process.argv.slice(2), { tolerance: 5, usage: USAGE, flags: { part: 'both', strength: '0,1', inset: 3 } });
  const parts = opts.part === 'both' ? ['sun', 'lamp'] : [opts.part];
  const strength = parseStrength(opts.strength);
  await withCheckBrowser(opts, async (ctx) => {
    for (const backend of opts.backends) {
      for (const part of parts) {
        const query = queryOf(opts, { backend, part, normalSun: String(strength.sun), normalLamps: String(strength.lamps) });
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
          skyLight: 0,
          lamps: part === 'lamp' ? [L.lamp] : [],
          strength,
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
