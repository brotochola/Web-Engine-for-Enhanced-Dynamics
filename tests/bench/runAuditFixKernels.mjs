// Five alternating processes: HEAD src versus the working tree.
// The bench file is the working tree's. Only src/ comes from HEAD on the baseline.
//
//   node tests/bench/runAuditFixKernels.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ensureRevWorktree } from './revWorktree.mjs';
import { repoRoot } from './measureLib.mjs';

const script = 'tests/bench/auditFixMicrobench.mjs';
const outDir = path.join(repoRoot, 'tests/results/audit-fixes');
const rounds = 5;

function run(root, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(process.execPath, [path.join(root, script), '--output', file], {
    cwd: root,
    stdio: 'inherit',
  });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const baseInfo = ensureRevWorktree('HEAD');
const baseRoot = baseInfo.root;
const hypRoot = repoRoot;
fs.mkdirSync(outDir, { recursive: true });

const baseRounds = [];
const hypRounds = [];
for (let r = 0; r < rounds; r++) {
  const first = r % 2 === 0 ? 'base' : 'hyp';
  const second = first === 'base' ? 'hyp' : 'base';
  for (const side of [first, second]) {
    const root = side === 'base' ? baseRoot : hypRoot;
    const file = path.join(outDir, `${side}-${r}.json`);
    console.log(`\n[round ${r} ${side}]`);
    const json = run(root, file);
    (side === 'base' ? baseRounds : hypRounds).push(json);
  }
}

const names = Object.keys(baseRounds[0].cases);
const cases = {};
for (const name of names) {
  const base = baseRounds.map((j) => j.cases[name].opsPerSec).sort((a, b) => a - b);
  const hyp = hypRounds.map((j) => j.cases[name].opsPerSec).sort((a, b) => a - b);
  const baseMed = base[(base.length / 2) | 0];
  const hypMed = hyp[(hyp.length / 2) | 0];
  let wins = 0;
  for (const h of hyp) for (const b of base) if (h > b) wins++;
  const baseSum = baseRounds[0].cases[name].checksum;
  const hypSum = hypRounds[0].cases[name].checksum;
  const same = baseRounds.every((j) => j.cases[name].checksum === baseSum)
    && hypRounds.every((j) => j.cases[name].checksum === hypSum);
  cases[name] = {
    baseOps: base,
    hypOps: hyp,
    baseMedian: baseMed,
    hypMedian: hypMed,
    deltaPct: ((hypMed - baseMed) / baseMed) * 100,
    roundsWon: wins,
    rounds: base.length * hyp.length,
    baseChecksum: baseSum,
    hypChecksum: hypSum,
    checksumStable: same,
    checksumMatch: baseSum === hypSum,
  };
}

const report = {
  baseRoot,
  headSha: baseInfo.sha,
  rounds,
  cases,
};
fs.writeFileSync(path.join(outDir, 'compare.json'), JSON.stringify(report, null, 2));
for (const name of names) {
  const c = cases[name];
  const flag = c.checksumMatch ? '' : ' CHECKSUM';
  console.log(
    `${name}: ${Math.round(c.baseMedian)} -> ${Math.round(c.hypMedian)} (${c.deltaPct.toFixed(1)}%) ${c.roundsWon}/${c.rounds}${flag}`,
  );
}
