#!/usr/bin/env node
/**
 * E-09 premise. snapshotPrevPose copies x,y onto px,py for each live body.
 * The 2026-10-14 trace put that at 0.9% of physics busy time. This times the
 * copy itself, at Balls' awake count and at Predator's body count, so a sitting
 * is not spent on a copy that cannot clear 3% of a multi-millisecond step.
 *
 *   node tests/bench/e09PrevPosePremise.mjs
 */
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

function make(n) {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const list = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = i;
    y[i] = i * 0.5;
    list[i] = (i * 17) % n;
  }
  const run = () => {
    for (let d = 0; d < n; d++) {
      const i = list[d];
      px[i] = x[i];
      py[i] = y[i];
    }
    return px[n - 1];
  };
  return { run, px };
}

function main() {
  const args = parseArgs();
  const cases = {};
  let checksum = 0;
  for (const n of [9000, 17556]) {
    const { run, px } = make(n);
    checksum = (checksum + (run() | 0)) >>> 0;
    const result = timeIt(`e09 prev pose n=${n}`, run, { iterations: 200, warmup: 50 });
    cases[n] = {
      msPerCall: result.ms / result.iterations,
      opsPerSec: result.opsPerSec,
      sampleMs: result.ms,
      iterations: result.iterations,
      px0: px[0],
    };
  }
  const report = {
    feature: 'e09-prev-pose',
    note: 'dense-list copy, two float stores per live body, indirect through a shuffled index. Not a share of a scene step.',
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify({
    n9000ms: Number(cases[9000].msPerCall.toFixed(4)),
    n17556ms: Number(cases[17556].msPerCall.toFixed(4)),
  }, null, 2));
}

if (isCli(import.meta.url)) main();
