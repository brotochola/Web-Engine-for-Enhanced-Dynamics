/**
 * H-13. Time the dirty-tile count in pixiWorker.updateDecalTiles.
 *
 * That loop is also the early-out (`dirtyN === 0` skips the upload scan), so
 * gating it on collectDetailedStats would delete the early-out. This kernel
 * asks whether one sweep, at the tile counts the plan named, is even above the
 * 3 ms floor. If it is not, a SAB counter is an unmeasurable change and does
 * not ship.
 *
 * Checksum: the dirty count for a scripted pattern (every 10th tile).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [1000, 16000, 64000];
const SEED = 0x13dec;

function scriptedDirty(n) {
  const flags = new Uint8Array(new SharedArrayBuffer(n));
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) {
      flags[i] = 1;
      count++;
    }
  }
  return { flags, count };
}

function countDirty(flags, n) {
  let dirtyN = 0;
  for (let i = 0; i < n; i++) {
    if (Atomics.load(flags, i)) dirtyN++;
  }
  return dirtyN;
}

export function main() {
  const args = parseArgs();
  const cases = {};
  const rows = [];
  let sink = 0;
  for (const n of SIZES) {
    const { flags, count } = scriptedDirty(n);
    const once = countDirty(flags, n);
    if (once !== count) {
      throw new Error(`checksum mismatch at n=${n}: sweep ${once}, scripted ${count}`);
    }
    const timed = timeIt(`decal-sweep n=${n}`, (iters) => {
      let acc = 0;
      for (let i = 0; i < iters; i++) acc += countDirty(flags, n);
      sink += acc;
    }, { iterations: 4 });
    const msPerSweep = timed.ms / timed.iterations;
    const row = {
      n,
      seed: SEED,
      checksum: checksumInts([count]),
      count,
      msPerSweep,
      opsPerSec: timed.opsPerSec,
      sampleMs: timed.ms,
      aboveFloor: msPerSweep >= 3,
    };
    rows.push(row);
    cases[n === 16000 ? 'count' : `n${n}`] = row;
    console.log(
      `n=${n}  ${msPerSweep.toFixed(4)} ms/sweep  checksum ${row.checksum}  ` +
        (row.aboveFloor ? 'ABOVE the 3 ms floor' : 'below the 3 ms floor'),
    );
  }
  if (sink === 0) throw new Error('sink collapsed');
  const payload = {
    cases,
    rows,
    n: 16000,
    seed: SEED,
    checksum: cases.count.checksum,
    sink,
  };
  if (args.output) writeReport(String(args.output), payload);
  else writeReport(path.join(HERE, '../results/h13-decal-sweep.json'), payload);
  return payload;
}

if (isCli(import.meta.url)) main();
