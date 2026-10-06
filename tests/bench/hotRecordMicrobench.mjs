/**
 * Pack-shaped reads: one column per field versus one interleaved record.
 * The copy into the record is not timed. If the record is not clearly
 * cheaper, emit does not grow a second layout.
 *
 *   node tests/bench/hotRecordMicrobench.mjs
 */
import { isCli, timeIt } from './microbenchHelpers.mjs';

const N = 16384;
const FIELDS = 8;

function build() {
  const cols = [];
  for (let f = 0; f < FIELDS; f++) {
    const col = new Float32Array(N);
    for (let i = 0; i < N; i++) col[i] = i + f;
    cols.push(col);
  }
  const rec = new Float32Array(N * FIELDS);
  for (let i = 0; i < N; i++) {
    for (let f = 0; f < FIELDS; f++) rec[i * FIELDS + f] = cols[f][i];
  }
  return { cols, rec };
}

function readSoa(cols) {
  let sink = 0;
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let f = 0; f < FIELDS; f++) s += cols[f][i];
    sink += s;
  }
  return sink;
}

function readAos(rec) {
  let sink = 0;
  for (let i = 0; i < N; i++) {
    const b = i * FIELDS;
    let s = 0;
    for (let f = 0; f < FIELDS; f++) s += rec[b + f];
    sink += s;
  }
  return sink;
}

function main() {
  const { cols, rec } = build();
  const a = readSoa(cols);
  const b = readAos(rec);
  if (a !== b) {
    console.error(`checksum soa ${a} aos ${b}`);
    process.exit(1);
  }
  const soaTime = timeIt('soa', () => readSoa(cols));
  const aosTime = timeIt('aos', () => readAos(rec));
  const delta = ((aosTime.opsPerSec - soaTime.opsPerSec) / soaTime.opsPerSec) * 100;
  console.log(`checksum ${a}`);
  console.log(`delta ${delta.toFixed(1)}% ops/s (interleaved vs columns)`);
}

if (isCli(import.meta.url)) main();
