// Print skip-work integrated-bench JSON metrics.
//   node tests/bench/skipWorkSummarize.mjs tests/results/skip-work-hyps/B0-balls.json

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tests/bench/skipWorkSummarize.mjs <bench.json>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const workers = data.workers || [];

function find(pred) {
  return workers.filter(pred);
}

function avg(w, key) {
  return w?.statsSamplesAverage?.[key] ?? 0;
}

function line(w) {
  if (!w) return '  (missing)';
  const a = w.statsSamplesAverage || {};
  const bits = [
    `${w.id} STEP ${Number(a.STEP_MS || 0).toFixed(3)}`,
    `FPS ${Number(w.averageFPS || 0).toFixed(1)}`,
  ];
  if (a.BOX2D_MS != null) bits.push(`BOX2D ${Number(a.BOX2D_MS).toFixed(3)}`);
  if (a.NEIGHBOR_MS != null) bits.push(`NEIGHBOR ${Number(a.NEIGHBOR_MS).toFixed(3)}`);
  if (a.BODY_COUNT != null) bits.push(`BODY ${Number(a.BODY_COUNT).toFixed(0)}`);
  if (a.AWAKE_COUNT != null) bits.push(`AWAKE ${Number(a.AWAKE_COUNT).toFixed(0)}`);
  return '  ' + bits.join(' | ');
}

console.log(`main FPS ${Number(data.mainThread?.averageFPS || 0).toFixed(2)}`);
for (const w of workers) console.log(line(w));

const spatial = find((w) => String(w.id || '').startsWith('spatial') || w.type === 'spatial');
if (spatial.length > 1) {
  const nsum = spatial.reduce((s, w) => s + avg(w, 'NEIGHBOR_MS'), 0);
  const ssum = spatial.reduce((s, w) => s + avg(w, 'STEP_MS'), 0);
  console.log(`  spatial SUM STEP ${ssum.toFixed(3)} | SUM NEIGHBOR ${nsum.toFixed(3)}`);
}
