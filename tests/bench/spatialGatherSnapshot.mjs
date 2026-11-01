#!/usr/bin/env node
/**
 * E-147: one frame of the spatial gather, captured for a replay outside Node. Builds spatialWorkerMicrobench's
 * Predator-sized kernel (16 500 entities, 3 workers), runs warm-up frames, records every worker's gather_batch call
 * of the next frame (its arguments), and writes the WebAssembly memory as it stands after that frame: the grid, the
 * poses, the ranges and the batch lists the calls read are all in it.
 *
 *   node tests/bench/spatialGatherSnapshot.mjs [--config rebuild|predator] [--out tests/results/spatial-gather-snapshot]
 *
 * rebuild: every list rebuilt every frame (the gather's own cost); predator: Predator's skin and stagger.
 * The output is what tests/bench/spatialGatherReplayKernel.mjs reads in Chrome (chromeKernel.mjs): memory.bin and
 * calls.json. Not kept: tests/results/ is not committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function captureGatherFrame({ config = 'rebuild', warmup = 30 } = {}) {
  const spatial = config === 'rebuild' ? { neighborReuseSkin: 0, neighborTickInterval: 1 } : config === 'predator' ? {} : null;
  if (!spatial) throw new Error(`unknown config ${config}`);
  const k = await setupSpatialKernel({ n: 16500, workers: 3, spatial: { ...spatial, gatherCellOrder: true } });
  for (let f = 0; f < warmup; f++) k.frame();
  const calls = [];
  const originals = k.workers.map((w) => w._wasmGather.gather);
  k.workers.forEach((w, i) => {
    w._wasmGather.gather = (...args) => {
      calls.push({ worker: i, args });
      return originals[i](...args);
    };
  });
  k.frame();
  k.workers.forEach((w, i) => {
    w._wasmGather.gather = originals[i];
  });
  if (!calls.length) throw new Error('no gather call in the captured frame');
  const memory = k.mem.memory;
  return {
    pages: memory.buffer.byteLength / 65536,
    bytes: new Uint8Array(memory.buffer.slice(0)),
    calls,
    entities: k.n,
    config,
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(repoRoot, String(args.out || 'tests/results/spatial-gather-snapshot'));
  const snap = await captureGatherFrame({ config: String(args.config || 'rebuild') });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'memory.bin'), snap.bytes);
  fs.writeFileSync(
    path.join(out, 'calls.json'),
    JSON.stringify({ pages: snap.pages, entities: snap.entities, config: snap.config, calls: snap.calls }, null, 1),
  );
  const rows = snap.calls.reduce((s, c) => s + c.args[0], 0);
  console.log(`${snap.calls.length} gather calls, ${rows} rows, ${snap.pages} pages -> ${out}`);
}
