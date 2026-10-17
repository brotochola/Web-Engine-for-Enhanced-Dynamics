import { packTextureRows } from '../src/render/sharedTextureUpload.js';
import { checksumInts, timeIt } from '../tests/bench/microbenchHelpers.mjs';

const WIDTH = 4096;
const ROWS = 32;
const X = 0;
const W = 128;
const bytes = new Uint8Array(WIDTH * ROWS);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i + 1) & 255;

let scratch = null;
const res = timeIt('current', (n) => {
  for (let i = 0; i < n; i++) {
    const out = packTextureRows(bytes, WIDTH, 1, X, 0, W, ROWS, scratch);
    scratch = out.buffer;
  }
}, { iterations: 1000 });
console.log('Current:', res.opsPerSec);
const check = packTextureRows(bytes, WIDTH, 1, X, 0, W, ROWS, null);
console.log('Checksum:', checksumInts(check.packed, check.packed.length));
