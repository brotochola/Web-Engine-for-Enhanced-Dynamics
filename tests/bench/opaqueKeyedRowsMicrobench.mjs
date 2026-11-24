#!/usr/bin/env node
/**
 * Kernel (E-479): the opaque pass's rows of a by-row keyed frame (opaquePass.js buildOpaqueKeyedRows), which Pixi builds
 * every frame the pass draws: 250 000 draw slots (bunnyMarkScene's), the queue's columns on a SharedArrayBuffer, rows and
 * slots on the batch's own arrays as the engine has them.
 *
 *   node tests/bench/opaqueKeyedRowsMicrobench.mjs [--n 250000] [--case bunny|mixed] [--output path]
 *
 * bunny: every row opaque, in queue order, 8 frames. mixed: the rows in a painter's order (near sorted), a third of them
 * with an alpha under 1 or a frame with soft texels (Predator's crowd).
 */
import { buildOpaqueKeyedRows } from '../../src/render/opaquePass.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const FRAMES = 64;

export function setupOpaqueRows({ n = 250000, mixed = false, seed = 0x0479 } = {}) {
  const rng = mulberry32(seed);
  const shared = (Ctor) => new Ctor(new SharedArrayBuffer(n * Ctor.BYTES_PER_ELEMENT));
  const q = { alpha: shared(Float32Array), textureId: shared(Uint16Array), scaleX: shared(Float32Array), scaleY: shared(Float32Array) };
  for (let i = 0; i < n; i++) {
    q.alpha[i] = mixed && rng() < 0.2 ? rng() : 1;
    q.textureId[i] = (rng() * (mixed ? FRAMES : 8)) | 0;
    q.scaleX[i] = rng() < 0.5 ? 1 : -1;
    q.scaleY[i] = 1;
  }
  const texels = new Uint8Array(FRAMES);
  const area = new Float32Array(FRAMES);
  for (let t = 0; t < FRAMES; t++) {
    texels[t] = mixed && t % 6 === 0 ? 1 : 0;
    area[t] = 100 + t;
  }
  const rows = new Float32Array(n);
  const slots = new Float32Array(n);
  const order = Float32Array.from({ length: n }, (_, k) => k);
  if (mixed) {
    for (let k = 0; k < n; k++) {
      const j = Math.min(n - 1, k + ((rng() * 64) | 0));
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
    }
  }
  rows.set(order);
  for (let k = 0; k < n; k++) slots[k] = (order[k] * 7) % n;
  return { n, q, texels, area, rows, slots, out: new Float32Array(n * 3), cover: new Float64Array(1) };
}

export function runOpaqueRowsJs(s, n = s.n) {
  return buildOpaqueKeyedRows(s.rows, s.slots, n, s.q.alpha, s.q.textureId, s.q.scaleX, s.q.scaleY, s.texels, s.area, s.out, s.cover);
}

function main() {
  const args = parseArgs();
  const n = Number(args.n ?? 250000);
  const cases = {};
  let checksum = 2166136261;
  for (const name of args.case ? [String(args.case)] : ['bunny', 'mixed']) {
    const s = setupOpaqueRows({ n, mixed: name === 'mixed' });
    const m = runOpaqueRowsJs(s);
    checksum = Math.imul(checksum ^ checksumFloats(s.out, m * 3) ^ m, 16777619) >>> 0;
    warmNormalCompile(() => runOpaqueRowsJs(s, 2000));
    const t = timeIt(`opaque rows ${name} (${m} of ${n})`, () => runOpaqueRowsJs(s), { iterations: 10, warmup: 5 });
    cases[name] = { ...t, rows: m, nsPerRow: 1e9 / t.opsPerSec / n };
    console.log(`  ${name}: ${cases[name].nsPerRow.toFixed(2)} ns a draw slot, ${(1e3 / t.opsPerSec).toFixed(3)} ms a frame`);
  }
  const report = { feature: 'opaque-keyed-rows', functions: ['buildOpaqueKeyedRows'], n, checksum, cases };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}`);
}

if (isCli(import.meta.url)) main();
