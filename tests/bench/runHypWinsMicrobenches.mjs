// Run all hyp-win L1 microbenches and write a summary JSON.
//
// Usage:
//   node tests/bench/run-hyp-wins-microbenches.mjs
//   pnpm bench:micro:hyp-wins

import { parseArgs, writeReport } from './microbench-helpers.mjs';
import { runLogPairMicrobench } from './log-pair-microbench.mjs';
import { runParCamMicrobench } from './par-cam-microbench.mjs';
import { runPreAnimMicrobench } from './pre-anim-microbench.mjs';
import { runPreHotMicrobench } from './pre-hot-microbench.mjs';

const args = parseArgs();
const outputPath = args.output
  ? String(args.output)
  : 'tests/results/hyp-wins-micro.json';

console.log('\n=== LOG-PAIR ===');
const logPair = runLogPairMicrobench({ ...args, output: undefined });

console.log('\n=== PAR-CAM ===');
const parCam = runParCamMicrobench({ ...args, output: undefined });

console.log('\n=== PRE-ANIM ===');
const preAnim = runPreAnimMicrobench({ ...args, output: undefined });

console.log('\n=== PRE-HOT ===');
const preHot = runPreHotMicrobench({ ...args, output: undefined });

function deltaPct(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return (1 - ratio) * 100;
}

const rows = [
  { hyp: 'LOG-PAIR', metric: 'setContact', ratio: logPair.ratios.setContact },
  { hyp: 'LOG-PAIR', metric: 'pack', ratio: logPair.ratios.pack },
  { hyp: 'LOG-PAIR', metric: 'unpack', ratio: logPair.ratios.unpack },
  { hyp: 'PAR-CAM', metric: 'overall', ratio: parCam.ratios.overall },
  { hyp: 'PRE-ANIM', metric: 'overall', ratio: preAnim.ratios.overall },
  { hyp: 'PRE-HOT', metric: 'overall', ratio: preHot.ratios.overall },
];

console.log('\n=== Summary (ratio opt/baseline; <1 = faster; Δ% = speedup) ===');
for (const row of rows) {
  const d = deltaPct(row.ratio);
  console.log(
    `${row.hyp.padEnd(10)} ${row.metric.padEnd(12)} ratio=${row.ratio.toFixed(3)}  Δ%=${d.toFixed(1)}`
  );
}

writeReport(outputPath, {
  name: 'hyp-wins-micro',
  benches: { logPair, parCam, preAnim, preHot },
  table: rows.map((r) => ({ ...r, deltaPct: deltaPct(r.ratio) })),
});
