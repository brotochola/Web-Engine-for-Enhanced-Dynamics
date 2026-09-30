#!/usr/bin/env node
/**
 * Kernel A/B for a hypothesis variant that lives in the bench file.
 * Alternates processes (base, v1, …, base, v1, …) so drift lands on both
 * sides, then compares medians per case. A variant whose checksum differs
 * from base is rejected before any ops/s is read.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/contactsMicrobench.mjs --variants base,myvariant
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/audioSlotMicrobench.mjs --variants base,l3 --rounds 4
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { median, pctDelta, writeJson } from './featureTournamentLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { repoRoot, SPEED_PCT } from './measureLib.mjs';

export function runKernelVariants({ script, variants, rounds = 3, outDir, extraArgs = [] }) {
  fs.mkdirSync(outDir, { recursive: true });
  const runs = Object.fromEntries(variants.map((v) => [v, []]));
  for (let r = 0; r < rounds; r++) {
    for (const v of variants) {
      const out = path.join(outDir, `${v}-r${r}.json`);
      execFileSync(process.execPath, [path.join(repoRoot, script), '--variant', v, '--output', out, ...extraArgs], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      runs[v].push(JSON.parse(fs.readFileSync(out, 'utf8')));
    }
  }
  const base = variants[0];
  const baseChecksum = runs[base][0].checksum;
  const caseNames = Object.keys(runs[base][0].cases);
  const summary = { script, rounds, variants: {} };
  for (const v of variants) {
    const checksums = [...new Set(runs[v].map((j) => j.checksum))];
    const row = { checksums, checksumOk: checksums.length === 1 && checksums[0] === baseChecksum, cases: {} };
    for (const c of caseNames) {
      const ops = runs[v].map((j) => j.cases[c]?.opsPerSec).filter(Number.isFinite);
      const med = median(ops);
      const baseMed = median(runs[base].map((j) => j.cases[c]?.opsPerSec).filter(Number.isFinite));
      const d = pctDelta(med, baseMed);
      row.cases[c] = {
        opsPerSec: med,
        samples: ops,
        deltaPct: v === base ? 0 : d,
        verdict: v === base ? 'BASE' : !row.checksumOk ? 'REJECTED (checksum)' : d >= SPEED_PCT ? 'WIN' : d <= -SPEED_PCT ? 'LOSS' : 'TIE',
      };
    }
    summary.variants[v] = row;
  }
  return summary;
}

function main() {
  const args = parseArgs();
  const script = String(args.script);
  const variants = String(args.variants || 'base').split(',').map((s) => s.trim()).filter(Boolean);
  const rounds = Number(args.rounds ?? 3);
  const name = path.basename(script, '.mjs');
  const outDir = path.join(repoRoot, 'tests/results/kernel-variants', name);
  const summary = runKernelVariants({ script, variants, rounds, outDir });
  writeJson(path.join(outDir, 'summary.json'), summary);
  console.log(`\n======== ${name} (${rounds} alternating rounds) ========`);
  for (const [v, row] of Object.entries(summary.variants)) {
    for (const [c, r] of Object.entries(row.cases)) {
      const d = r.deltaPct == null ? 'n/a' : `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`;
      console.log(`${v.padEnd(8)} ${c.padEnd(14)} ${r.opsPerSec.toFixed(1).padStart(12)} ops/s  ${d.padStart(8)}  ${r.verdict}${row.checksumOk ? '' : ` checksums ${row.checksums.join(',')}`}`);
    }
  }
}

if (isCli(import.meta.url)) main();
