// L1 microbench: camera bounds x3/frame (baseline) vs once + cache (PAR-CAM).
//
// Usage:
//   node tests/bench/par-cam-microbench.mjs
//   node tests/bench/par-cam-microbench.mjs --frames 200000 --output tests/results/par-cam-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { calculateCameraScreenBounds } from '../../src/core/utils.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runParCamMicrobench(cliArgs = parseArgs()) {
  const FRAMES = Number(cliArgs.frames ?? 200000);
  const SEED = Number(cliArgs.seed ?? 0xc0ffee);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;
  const CANVAS_W = 1920;
  const CANVAS_H = 1080;
  const CULL = 0.1;

  const rng = mulberry32(SEED);
  const zooms = new Float32Array(FRAMES);
  const xs = new Float32Array(FRAMES);
  const ys = new Float32Array(FRAMES);
  let z = 1;
  let cx = 1000;
  let cy = 800;
  for (let i = 0; i < FRAMES; i++) {
    if (rng() < 0.02) {
      z = 0.5 + rng() * 1.5;
      cx += (rng() - 0.5) * 40;
      cy += (rng() - 0.5) * 40;
    }
    zooms[i] = z;
    xs[i] = cx;
    ys[i] = cy;
  }

  const fresh = {
    zoom: 0,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
  };
  const cached = { ...fresh };
  let cacheZ = NaN;
  let cacheX = NaN;
  let cacheY = NaN;
  let cacheValid = false;

  function frameCameraBounds(zoom, cameraX, cameraY) {
    if (cacheValid && cacheZ === zoom && cacheX === cameraX && cacheY === cameraY) {
      return cached;
    }
    cacheZ = zoom;
    cacheX = cameraX;
    cacheY = cameraY;
    cacheValid = true;
    return calculateCameraScreenBounds(
      zoom,
      cameraX,
      cameraY,
      CANVAS_W,
      CANVAS_H,
      CULL,
      cached
    );
  }

  for (let i = 0; i < Math.min(FRAMES, 5000); i++) {
    cacheValid = false;
    const a = frameCameraBounds(zooms[i], xs[i], ys[i]);
    calculateCameraScreenBounds(zooms[i], xs[i], ys[i], CANVAS_W, CANVAS_H, CULL, fresh);
    if (
      a.zoom !== fresh.zoom ||
      a.cameraOffsetX !== fresh.cameraOffsetX ||
      a.cameraOffsetY !== fresh.cameraOffsetY ||
      a.minX !== fresh.minX ||
      a.maxX !== fresh.maxX ||
      a.minY !== fresh.minY ||
      a.maxY !== fresh.maxY
    ) {
      throw new Error(`PAR-CAM cache mismatch at frame ${i}`);
    }
    const b = frameCameraBounds(zooms[i], xs[i], ys[i]);
    if (b !== cached) throw new Error(`PAR-CAM expected cached object at frame ${i}`);
  }
  console.log('Correctness OK (cached bounds match fresh calculateCameraScreenBounds)');

  const resultA = { ...fresh };
  const resultB = { ...fresh };
  const resultC = { ...fresh };

  const baseline = timeIt(
    'bounds x3/frame (baseline)',
    (n) => {
      const lim = Math.min(n, FRAMES);
      let sink = 0;
      for (let i = 0; i < lim; i++) {
        calculateCameraScreenBounds(zooms[i], xs[i], ys[i], CANVAS_W, CANVAS_H, CULL, resultA);
        calculateCameraScreenBounds(zooms[i], xs[i], ys[i], CANVAS_W, CANVAS_H, CULL, resultB);
        calculateCameraScreenBounds(zooms[i], xs[i], ys[i], CANVAS_W, CANVAS_H, CULL, resultC);
        sink += resultA.maxX + resultB.maxY + resultC.zoom;
      }
      if (sink === Infinity) console.log(sink);
    },
    { iterations: FRAMES }
  );

  const optimized = timeIt(
    'bounds x1 + cache x2 (PAR-CAM)',
    (n) => {
      const lim = Math.min(n, FRAMES);
      let sink = 0;
      let localValid = false;
      let lz = NaN;
      let lx = NaN;
      let ly = NaN;
      const buf = { ...fresh };
      for (let i = 0; i < lim; i++) {
        const zoom = zooms[i];
        const cameraX = xs[i];
        const cameraY = ys[i];
        let bounds;
        if (localValid && lz === zoom && lx === cameraX && ly === cameraY) {
          bounds = buf;
        } else {
          lz = zoom;
          lx = cameraX;
          ly = cameraY;
          localValid = true;
          bounds = calculateCameraScreenBounds(
            zoom,
            cameraX,
            cameraY,
            CANVAS_W,
            CANVAS_H,
            CULL,
            buf
          );
        }
        sink += bounds.maxX + bounds.maxY + bounds.zoom;
        sink += bounds.minX + bounds.minY;
        sink += bounds.cameraOffsetX;
      }
      if (sink === Infinity) console.log(sink);
    },
    { iterations: FRAMES }
  );

  const report = {
    name: 'par-cam',
    hyp: 'PAR-CAM',
    seed: SEED,
    frames: FRAMES,
    correctness: { ok: true },
    timings: { baseline, optimized },
    ratios: { overall: optimized.ms / baseline.ms },
  };

  console.log(`Ratio opt/baseline: ${report.ratios.overall.toFixed(3)} (<1 = faster)`);
  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runParCamMicrobench();
}
