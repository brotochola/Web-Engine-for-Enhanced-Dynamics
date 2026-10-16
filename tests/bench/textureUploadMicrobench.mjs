// Row pack for a shared picture. The shipped function is packTextureRows.
//
// Usage:
//   node tests/bench/textureUploadMicrobench.mjs
//   node tests/bench/textureUploadMicrobench.mjs --output tests/results/texture-upload-micro.json

import { packTextureRows } from '../../src/render/sharedTextureUpload.js';
import { checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const WIDTH = 4096;
const ROWS = 32;
const X = 0;
const W = 128;

export function runTextureUploadMicrobench(cliArgs = parseArgs()) {
  const seed = Number(cliArgs.seed ?? 1);
  const bytes = new Uint8Array(WIDTH * ROWS);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i + seed) & 255;
  let scratch = null;

  const packed = timeIt('pack dirty rows', (n) => {
    for (let i = 0; i < n; i++) {
      const out = packTextureRows(bytes, WIDTH, 1, X, 0, W, ROWS, scratch);
      scratch = out.buffer;
    }
  }, { iterations: 40, warmup: 4, reps: 5 });

  const check = packTextureRows(bytes, WIDTH, 1, X, 0, W, ROWS, null);
  const checksum = checksumInts(check.packed, check.packed.length);

  return {
    name: 'texture-upload-micro',
    seed,
    n: WIDTH * ROWS,
    checksum,
    cases: {
      pack: { opsPerSec: packed.opsPerSec, n: packed.iterations, checksum },
    },
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const result = runTextureUploadMicrobench(args);
  console.log(JSON.stringify({
    opsPerSec: Math.round(result.cases.pack.opsPerSec),
    checksum: result.checksum,
  }));
  if (args.output) writeReport(args.output, result);
}
