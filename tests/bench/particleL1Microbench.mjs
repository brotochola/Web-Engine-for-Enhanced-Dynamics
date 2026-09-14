#!/usr/bin/env node
// Combined L1 runner for the particle hyp tournament: runs particle-emit-microbench.mjs
// and particle-integrate-microbench.mjs as child processes, merges their `cases` into one
// report (emit_* / integrate_* prefixes to avoid key collisions) so feature-tournament-lib's
// single-microRunner contract (see decal/ray tournaments) still applies with two L1 sources.
//
// Usage:
//   node tests/bench/particle-l1-microbench.mjs --output tests/results/particle-l1.json
//   node tests/bench/particle-l1-microbench.mjs --particles 4096 --bursts 2000 --steps 3000 --output out.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OUTPUT = args.output ? String(args.output) : null;

const passthroughByFlag = {
  particles: args.particles,
  bursts: args.bursts,
  'burst-size': args['burst-size'],
  steps: args.steps,
  seed: args.seed,
};

function buildArgs(allowedFlags) {
  const out = [];
  for (const flag of allowedFlags) {
    const v = passthroughByFlag[flag];
    if (v !== undefined) out.push(`--${flag}`, String(v));
  }
  return out;
}

function runMicro(scriptName, allowedFlags) {
  const tmpOut = path.join(os.tmpdir(), `particle-l1-${scriptName}-${process.pid}-${Date.now()}.json`);
  const scriptPath = path.join(here, scriptName);
  try {
    execFileSync(
      process.execPath,
      [scriptPath, ...buildArgs(allowedFlags), '--output', tmpOut],
      { stdio: 'inherit' }
    );
    const report = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    return report;
  } finally {
    fs.rmSync(tmpOut, { force: true });
  }
}

const emitReport = runMicro('particle-emit-microbench.mjs', ['particles', 'bursts', 'burst-size', 'seed']);
const integrateReport = runMicro('particle-integrate-microbench.mjs', ['particles', 'steps', 'seed']);

const cases = {};
for (const [key, val] of Object.entries(emitReport.cases || {})) {
  cases[`emit_${key}`] = val;
}
for (const [key, val] of Object.entries(integrateReport.cases || {})) {
  cases[`integrate_${key}`] = val;
}

const combined = {
  feature: 'particle-l1',
  layer: 'L1',
  sources: {
    emit: { feature: emitReport.feature, maxParticles: emitReport.maxParticles, burstSize: emitReport.burstSize, bursts: emitReport.bursts },
    integrate: { feature: integrateReport.feature, maxParticles: integrateReport.maxParticles, particlesPerCase: integrateReport.particlesPerCase, steps: integrateReport.steps },
  },
  cases,
};

console.log(`particle-l1-microbench: merged ${Object.keys(emitReport.cases || {}).length} emit cases + ${Object.keys(integrateReport.cases || {}).length} integrate cases`);

if (OUTPUT) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(combined, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT}`);
}
