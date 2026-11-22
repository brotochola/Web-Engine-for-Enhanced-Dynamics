#!/usr/bin/env node
/**
 * DX-SCORELOAD: chooses, on the machine it runs on, each stress row's load for the scoreboard (scoreboardLoads.mjs).
 * For every row with a load knob (catalog scene.loadKnob) it runs the scoreboard's baseline side once, as the
 * scoreboard does (the --vs revision's src/ under this tree's scenes, headless, detailed stats off). A primary under
 * 1.25 x the stress floor raises the knob in a straight line toward --target-ms and runs again, up to --rounds runs or
 * the knob's cap. The values go to --out, which runScoreboard --loads reads.
 *
 *   node tests/bench/calibrateScoreboardLoads.mjs --vs v0.14.0 --out C:/weedlab/scoreboard-loads.json
 *     [--only ray,spatial] [--target-ms 9] [--rounds 3] [--full-rev] [--stress-warmup-ms 8000 --stress-duration-ms 10000]
 *
 * A row whose baseline already clears the margin keeps its default (written too, so the file says what was checked).
 * An --out file calibrated on the same baseline keeps the rows this run leaves out (--only one row again).
 * Each run takes about 20 s; seven rows with one or two raises take about 5 minutes. Run it on a quiet machine.
 */
import fs from 'node:fs';
import path from 'node:path';

import { filterFeatures } from './engineFeatureCatalog.mjs';
import { STEP_MS_FLOOR, measureSceneSide, parseMeasureArgs, repoRoot, usesStressStepFloor } from './measureLib.mjs';
import { isCli } from './microbenchHelpers.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';
import { nextLoad, primaryMs, sceneAtLoad } from './scoreboardLoads.mjs';

/** The floor's margin a calibrated baseline must clear: a 3 % keep still reads above the floor. */
export const CALIBRATION_MARGIN = 1.25;

function parseCli(argv) {
  const args = parseMeasureArgs(argv, { vs: 'v0.14.0' });
  args.out = null;
  args.targetMs = STEP_MS_FLOOR * 1.5;
  args.rounds = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--target-ms') args.targetMs = Number(argv[++i]);
    else if (a === '--rounds') args.rounds = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === '--stress-warmup-ms') args.stressWarmupMs = parseInt(argv[++i], 10) || args.stressWarmupMs;
    else if (a === '--stress-duration-ms') args.stressDurationMs = parseInt(argv[++i], 10) || args.stressDurationMs;
  }
  if (!args.out) throw new Error('calibrateScoreboardLoads: --out <loads.json> is required');
  if (!(args.targetMs > STEP_MS_FLOOR * CALIBRATION_MARGIN)) {
    throw new Error(`calibrateScoreboardLoads: --target-ms must clear ${STEP_MS_FLOOR * CALIBRATION_MARGIN} ms`);
  }
  return args;
}

function main() {
  const args = parseCli(process.argv.slice(2));
  const features = filterFeatures(args.only).filter(
    (f) => f.scene?.loadKnob && !f.protocolCeiling && usesStressStepFloor(f.scene),
  );
  if (features.length === 0) throw new Error('calibrateScoreboardLoads: no row with a load knob in --only');
  const baseline = ensureRevWorktree(args.vs, { srcOnly: !args.fullRev });
  console.log(`baseline ${args.vs} (${baseline.sha.slice(0, 8)}) at ${baseline.root}; target ${args.targetMs} ms`);
  const dir = path.join(repoRoot, 'tests/results/scoreboard-calibration');
  fs.mkdirSync(dir, { recursive: true });
  const oneRun = { ...args, runs: 1, stressRuns: 1 };
  const clear = STEP_MS_FLOOR * CALIBRATION_MARGIN;
  // An --out file of the same baseline keeps the rows this run does not calibrate (--only one row again).
  const kept = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : null;
  const rows = kept && kept.sha === baseline.sha && kept.rows ? { ...kept.rows } : {};
  for (const id of Object.keys(rows)) if (!filterFeatures([id])[0]?.scene?.loadKnob) delete rows[id];
  for (const feature of features) {
    const knob = feature.scene.loadKnob;
    let value = knob.base;
    const tries = [];
    for (let r = 0; r < args.rounds; r++) {
      const scene = sceneAtLoad(feature, { [feature.id]: { [knob.key]: value } });
      const res = measureSceneSide(`${feature.scene.key}-cal-${value}`, scene, oneRun, dir, feature.id, baseline.root);
      if (!res.ok) {
        tries.push({ value, error: String(res.error || 'failed') });
        break;
      }
      const ms = primaryMs(feature, res.summary);
      tries.push({ value, ms: Math.round(ms * 1000) / 1000 });
      console.log(`${feature.id}: ${knob.key}=${value} -> ${feature.primary.join('+')} ${ms.toFixed(3)} ms`);
      if (!(ms < clear) || (Number.isFinite(knob.max) && value >= knob.max)) break;
      value = nextLoad(knob, value, ms, args.targetMs);
    }
    const last = tries[tries.length - 1];
    if (last.error) {
      console.log(`${feature.id}: no load chosen (${last.error})`);
      rows[feature.id] = { error: last.error, tries };
      continue;
    }
    rows[feature.id] = { [knob.key]: last.value, baselineMs: last.ms, clears: last.ms >= clear, tries };
  }
  const out = {
    vs: args.vs,
    sha: baseline.sha,
    calibrated: new Date().toISOString(),
    targetMs: args.targetMs,
    floorMs: STEP_MS_FLOOR,
    rows,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nloads written to ${args.out}:`);
  for (const [id, row] of Object.entries(rows)) {
    const knob = filterFeatures([id])[0]?.scene?.loadKnob;
    if (!knob) {
      console.log(`  ${id.padEnd(12)} (kept from the file; the catalog has no knob for it now)`);
      continue;
    }
    console.log(row.error
      ? `  ${id.padEnd(12)} FAILED ${row.error.slice(0, 80)}`
      : `  ${id.padEnd(12)} ${knob.key}=${row[knob.key]} (default ${knob.base}): ${row.baselineMs} ms${row.clears ? '' : ' (still under the margin)'}`);
  }
}

if (isCli(import.meta.url)) main();
