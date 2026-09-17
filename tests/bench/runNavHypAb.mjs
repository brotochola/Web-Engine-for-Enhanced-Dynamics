#!/usr/bin/env node
/**
 * Two conservative NavGrid hyps versus the current tree (not versus main).
 * Production Dijkstra lives in particleWorker.computeFlowfield; the catalog
 * kernel copies the algorithm and cannot see these patches.
 *
 *   node tests/bench/runNavHypAb.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { getFeature } from './engineFeatureCatalog.mjs';
import {
  parseMeasureArgs,
  pctDelta,
  measureSceneSide,
  repoRoot,
  restoreSrcTree,
  snapshotSrcTree,
  SPEED_PCT,
  workloadOk,
  writeJson,
  stepMsFloorOk,
} from './measureLib.mjs';

const outDir = path.join(repoRoot, 'tests/results/nav-hyps');
const particleRel = 'src/workers/particleWorker.js';
const particleAbs = path.join(repoRoot, particleRel);

const HYPS = [
  {
    id: 'N1_floor',
    claim: 'Integer cellY via |0 instead of Math.floor in computeFlowfield (and the matching cell decode).',
    apply(src) {
      const from = 'Math.floor(cell / gridWidth)';
      const to = '(cell / gridWidth) | 0';
      if (!src.includes(from)) throw new Error('N1: Math.floor(cell / gridWidth) missing');
      return src.split(from).join(to);
    },
  },
  {
    id: 'N2_gridHeight',
    claim: 'Hoist gridHeight next to gridWidth inside computeFlowfield so the inner bounds check is a local.',
    apply(src) {
      const lf = src.replace(/\r\n/g, '\n');
      const from = `    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const totalCells = this.totalCells;`;
      const to = `    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const totalCells = this.totalCells;`;
      if (!lf.includes(from)) throw new Error('N2: computeFlowfield locals missing');
      const withLocal = lf.replace(from, to);
      const marker = '  computeFlowfield(targetCell) {';
      const idx = withLocal.indexOf(marker);
      const end = withLocal.indexOf('    // Third pass: Smoothing', idx);
      if (idx < 0 || end < 0) throw new Error('N2: computeFlowfield markers missing');
      const mid = withLocal.slice(idx, end).replaceAll('ny >= this.gridHeight', 'ny >= gridHeight');
      if (mid === withLocal.slice(idx, end)) throw new Error('N2: no bounds check rewritten');
      const out = withLocal.slice(0, idx) + mid + withLocal.slice(end);
      return src.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
    },
  },
];

function decide(base, hyp, loadKeys) {
  const load = workloadOk(base.summary, hyp.summary, loadKeys);
  const metrics = ['particle_STEP_MS', 'logic0_STEP_MS'];
  const hits = metrics.map((metric) => {
    const b = base.summary[metric]?.median;
    const h = hyp.summary[metric]?.median;
    return { metric, base: b, hyp: h, deltaPct: pctDelta(h, b) };
  });
  if (!base.ok || !hyp.ok) return { verdict: 'FAIL', load, hits, error: base.error || hyp.error };
  if (!load.ok) return { verdict: 'FAIL', load, hits };
  const floor = stepMsFloorOk(base.summary, hyp.summary, ['particle_STEP_MS']);
  if (!floor.ok) return { verdict: 'FAIL', load, hits, floor };
  const particle = hits[0];
  if (particle.deltaPct >= SPEED_PCT) return { verdict: 'WORSE', load, hits };
  if (particle.deltaPct <= -SPEED_PCT) return { verdict: 'KEPT', load, hits };
  return { verdict: 'TIE', load, hits };
}

function main() {
  const feature = getFeature('nav');
  const args = parseMeasureArgs(['--headless']);
  const onlyIdx = process.argv.indexOf('--only');
  const argsOnly = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  fs.mkdirSync(outDir, { recursive: true });
  const snap = snapshotSrcTree();
  const rows = [];
  try {
    console.log('nav hyp A/B versus current tree; stress scene; particle_STEP_MS is the Dijkstra primary');
    const base = measureSceneSide('nav-CUR', feature.scene, args, outDir, 'nav');
    if (!base.ok) throw new Error(`baseline failed: ${base.error}`);
    writeJson(path.join(outDir, 'baseline.json'), base);

    const selected = argsOnly ? HYPS.filter((h) => h.id === argsOnly) : HYPS;
    if (!selected.length) throw new Error(`unknown hyp ${argsOnly}`);

    for (const hyp of selected) {
      restoreSrcTree(snap);
      const before = fs.readFileSync(particleAbs, 'utf8');
      fs.writeFileSync(particleAbs, hyp.apply(before));
      console.log(`\n######## ${hyp.id} ########`);
      const measured = measureSceneSide(`nav-${hyp.id}`, feature.scene, args, outDir, 'nav');
      restoreSrcTree(snap);
      const decision = decide(base, measured, feature.load);
      const row = { id: hyp.id, claim: hyp.claim, decision, base: base.summary, hyp: measured.summary };
      rows.push(row);
      writeJson(path.join(outDir, `${hyp.id}.json`), row);
      console.log(`${hyp.id} => ${decision.verdict}`);
      for (const hit of decision.hits) {
        console.log(`  ${hit.metric} ${hit.base?.toFixed?.(3)} -> ${hit.hyp?.toFixed?.(3)} (${hit.deltaPct?.toFixed?.(1)}%)`);
      }
    }
  } finally {
    restoreSrcTree(snap);
  }
  writeJson(path.join(outDir, 'summary.json'), { rows });
  const md = [
    '# NavGrid hyps versus current tree',
    '',
    'Hypothesis: two small changes in `particleWorker.computeFlowfield` make the particle step cheaper on `NavStressScene`. Compared to the current keep tree, not to `0695a8d`. Primary: `particle_STEP_MS` (Dijkstra runs on the particle worker). `logic0_STEP_MS` is `requestVector` sampling.',
    '',
    `Setup: stress, headless, ${args.stressRuns} × ${args.stressWarmupMs}/${args.stressDurationMs} ms. Load: ENTITIES_PROCESSED.`,
    '',
    ...rows.flatMap((r) => {
      const p = r.decision.hits[0];
      const l = r.decision.hits[1];
      return [
        `## ${r.id}`,
        '',
        r.claim,
        '',
        `**Veredicto: ${r.decision.verdict}.**`,
        '',
        `- particle_STEP_MS ${p.base?.toFixed?.(3)} → ${p.hyp?.toFixed?.(3)} ms (${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct?.toFixed?.(1)}%)`,
        `- logic0_STEP_MS ${l.base?.toFixed?.(3)} → ${l.hyp?.toFixed?.(3)} ms (${l.deltaPct >= 0 ? '+' : ''}${l.deltaPct?.toFixed?.(1)}%)`,
        `- carga: ${r.decision.load.ok ? 'OK' : 'NO'}`,
        ...(r.decision.floor && !r.decision.floor.ok ? [`- ${r.decision.floor.reason}`] : []),
        '',
      ];
    }),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  console.log(`Wrote ${path.join(outDir, 'report.md')}`);
}

main();
