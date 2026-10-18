// E-32: re-adjudicate a completed sitting against the current gate.
//
// A sitting is ~20 minutes of browser time. When the rule that converts its
// numbers into a verdict changes, re-running it is almost never necessary - the
// `pairs` array is written into summary.json, so the verdict can be recomputed
// from the recorded data in milliseconds.
//
// The precondition is that `decideAbab` is a pure function of (pairs, owner,
// metric). That is why the verdict logic lives in its own export and not inline in
// the runner. If this script ever prints a verdict that disagrees with a fresh run
// of the same sitting, that purity has broken and every A/B in the campaign is
// suspect.
//
// Usage:
//   node tests/bench/readjudicateAbab.mjs E05 E17
//   node tests/bench/readjudicateAbab.mjs --all
//
// E-32 in docs/internal/EXECUTION_PLAN.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAbab } from './runPredatorAbab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = path.join(ROOT, 'tests/results/predator-abab');

const args = process.argv.slice(2);
const all = args.includes('--all');
const names = args.filter((a) => !a.startsWith('--'));

const dirs = all
  ? fs.readdirSync(BASE).filter((d) => fs.existsSync(path.join(BASE, d, 'summary.json')))
  : names;

if (!dirs.length) {
  console.error('no sittings named. pass names, or --all.');
  process.exitCode = 1;
}

let changed = 0;
for (const name of dirs) {
  const file = path.join(BASE, name, 'summary.json');
  if (!fs.existsSync(file)) {
    console.log(`skip ${name}: no summary.json`);
    continue;
  }
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(s.pairs) || !s.pairs.length) {
    console.log(`skip ${name}: no recorded pairs`);
    continue;
  }
  const owner = s.protocol?.owner ?? s.decision?.owner ?? null;
  const metric = s.protocol?.metric ?? s.decision?.metric ?? null;
  const before = s.decision?.verdict ?? '(none)';
  const d = decideAbab(s.pairs, owner, metric);
  const flag = d.verdict === before ? '   ' : ' * ';
  if (d.verdict !== before) changed++;

  console.log(`${flag}${name.padEnd(20)} ${before}  ->  ${d.verdict}`);
  if (d.verdict !== before) {
    console.log(`     reasons before: ${JSON.stringify(s.decision?.reasons ?? [])}`);
    console.log(`     reasons after : ${JSON.stringify(d.reasons)}`);
  }
  const muted = d.muted ?? [];
  if (muted.length) {
    for (const m of muted) console.log(`     muted: ${m}`);
  }
  // The headline number never changes - only the gate that can veto it. Showing it
  // makes it obvious that a re-adjudication is not itself a new experiment.
  const o = d.owner ? d.kinds[d.owner] : null;
  if (o && o.interpretable) {
    console.log(
      `     owner ${d.owner}: ${o.baseMedian.toFixed(3)} -> ${o.hypMedian.toFixed(3)} ms  ` +
        `paired ${o.pairedDeltaPct >= 0 ? '+' : ''}${o.pairedDeltaPct.toFixed(1)}%  ` +
        `worse ${Math.round(o.worseFraction * o.deltas.length)}/${o.deltas.length}`,
    );
  }
  if (d.regress.length) for (const r of d.regress) console.log(`     regress: ${r}`);
  if (d.noisy.length) for (const r of d.noisy) console.log(`     noisy : ${r}`);
  if (d.belowFloor.length) for (const r of d.belowFloor) console.log(`     floor : ${r}`);
}

console.log(`\n${dirs.length} sittings re-adjudicated, ${changed} changed verdict.`);