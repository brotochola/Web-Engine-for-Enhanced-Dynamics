#!/usr/bin/env node
/**
 * Profile many scenes the way E-76 Q1 profiled four: one headed CPU trace per scene (source,
 * detailed stats off), a warm-up, then a window summarized per thread by summarizeChromeCpuTrace.mjs.
 * One scene at a time, in order. For each scene, <out>/<name>/ gets stress.json, engine_trace.json,
 * cpu-summary.json, hot-lines.md and summary.txt; <out>/inventory.md then lists, per scene, every
 * busy worker's ms/s and its hottest engine functions (src/), with game and bench code (demos/,
 * tests/) added up apart, since that code stays in JS.
 *
 *   node tests/bench/profileSceneSweep.mjs [--set demos|stress|all] [--only name,name]
 *        [--warmup-ms 6000] [--duration-ms 8000] [--out tests/results/wasm-q1b] [--inventory-only]
 *
 * A scene that fails or hangs (--timeout-ms, default 180 000) is recorded as failed; the sweep
 * goes on. CPU samples are not STEP_MS: this says where a worker spends its busy time.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { repoRoot } from './measureLib.mjs';

/** Demo scenes: every demos/<dir>/ with a scene class. */
const DEMOS = [
  'adobeAnimateScene/adobeAnimateScene.js', 'badPiggiesScene/badPiggiesScene.js', 'ballsScene/ballsScene.js',
  'bichosScene/bichosScene.js', 'boidsScene/boidsScene.js', 'box2dQueryAabbScene/box2dQueryAabbScene.js',
  'bunnyMarkScene/bunnyMarkScene.js', 'burningBoxesScene/burningBoxesScene.js', 'carScene/carScene.js',
  'constraintBoxScene/constraintBoxScene.js', 'constraintsTestScene/constraintsTestScene.js',
  'destructibleTerrainScene/destructibleTerrainScene.js', 'gearChainScene/gearChainScene.js',
  'liquidFunDemoScene/liquidFunDemoScene.js', 'liquidFunQueryScene/liquidFunQueryScene.js',
  'littleCity/littleCityScene.js', 'mamushkaDigScene/mamushkaDigScene.js', 'meshGalleryScene/meshGalleryScene.js',
  'orientedBoxScene/orientedBoxScene.js', 'particleLabScene/particleLabScene.js',
  'planetPhysicsScene/planetPhysicsScene.js', 'planetScene/planetScene.js',
  'platformerGameScene/platformerGameScene.js', 'predatorScene/predatorScene.js',
  'proceduralTreeScene/proceduralTreeScene.js', 'uChainScene/uChainScene.js',
  'waterAndBoxesScene/waterAndBoxesScene.js', 'weldBreakScene/weldBreakScene.js',
  'zenithalParticleTestScene/zenithalParticleTestScene.js',
].map((p) => `/demos/${p}`);

/** Stress scenes for engine processes Q1 did not profile (its gap list first). */
const STRESS = [
  'spawnStormScene', 'contactDrainStressScene', 'bulletStressScene', 'bulletStormScene', 'painterSortStressScene',
  'painterMoveStressScene', 'painterAdobeStressScene', 'decalStampStressScene', 'decalBlitStressScene',
  'meshApiStressScene', 'decorationSwayStressScene', 'decoChurnStressScene', 'liquidFunStressScene',
  'liquidFunManyShapesStressScene', 'tilemapStressScene', 'tilemapCullStressScene', 'navStressScene', 'rayStressScene',
  'queryAabbStressScene', 'renderQueueStressScene', 'spritePackStressScene', 'bunnyMarkStressScene',
  'ballsHeavyStressScene', 'tweenStressScene', 'audioStormScene', 'steadyCombatScene', 'textureUploadStressScene',
  'sceneryCamStressScene', 'particleEmitStressScene', 'movedBodiesMixedScene', 'computeStressScene',
  'cmdSamePoseStressScene',
].map((n) => `/tests/bench/stressScenes/${n}.js`);

/** The scene class a module exports: the first `export class …Scene`. */
export function sceneExport(file) {
  const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const m = src.match(/export\s+class\s+(\w+Scene)\b/);
  if (!m) throw new Error(`${file}: no exported scene class`);
  return m[1];
}

const sceneName = (file) => path.basename(file, '.js');

function profileScene(file, opts) {
  const name = sceneName(file);
  const dir = path.join(opts.out, name);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const run = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs'), '--src', '--headed', '--trace-cpu',
      '--no-collect-detailed-stats', '--scene', file, '--scene-export', sceneExport(file),
      '--warmup-ms', String(opts.warmupMs), '--duration-ms', String(opts.durationMs),
      '--output', path.join(dir, 'stress.json'),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(dir, 'run.log'), `${run.stdout || ''}\n${run.stderr || ''}`);
  const trace = path.join(dir, 'engine_trace.json');
  if (run.status !== 0 || !fs.existsSync(trace)) {
    const why = run.error ? run.error.message : `exit ${run.status}`;
    return { name, file, ok: false, why, seconds: (Date.now() - t0) / 1000 };
  }
  const sum = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'tests/bench/summarizeChromeCpuTrace.mjs'), trace, '--from-ms', String(opts.warmupMs)],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(dir, 'summary.txt'), sum.stdout || sum.stderr || '');
  // The trace is large and the summary holds what the inventory reads.
  if (!opts.keepTraces) fs.rmSync(trace, { force: true });
  return { name, file, ok: sum.status === 0, why: sum.status === 0 ? '' : 'summary failed', seconds: (Date.now() - t0) / 1000 };
}

// Engine code: src/ (Pixi's vendor build apart) and the engine's own kernels, which load as wasm://.
const isEngine = (key) => (/\s\/src\//.test(key) && !/\/src\/vendor\//.test(key)) || /\swasm:\/\//.test(key);
const isGame = (key) => /\s\/(demos|tests)\//.test(key);

/** One scene's rows: busy workers, their top engine functions, and the game-code share. */
export function sceneInventory(summary, { minBusy = 50, minPct = 2, top = 8 } = {}) {
  const rows = [];
  for (const t of Object.values(summary.threads || {})) {
    if (!(t.busyMsPerS >= minBusy)) continue;
    const self = t.self || [];
    const engine = self.filter((f) => isEngine(f.key) && f.pct >= minPct).slice(0, top);
    const game = self.filter((f) => isGame(f.key)).reduce((s, f) => s + f.pct, 0);
    const vendor = self.filter((f) => /\/src\/vendor\//.test(f.key)).reduce((s, f) => s + f.pct, 0);
    rows.push({ label: t.label, kind: t.kind, busy: t.busyMsPerS, engine, game, vendor });
  }
  rows.sort((a, b) => b.busy - a.busy);
  return rows;
}

function writeInventory(out, results) {
  const lines = [
    '# Scene profile inventory (E-76 Q1b)',
    '',
    'Per scene, every worker busy at least 50 ms/s, its self time by function (engine code under',
    '`src/`, at least 2 % of that worker), and the share of game or bench code (`demos/`, `tests/`)',
    'and of Pixi\'s vendor code. Shares are of the worker\'s busy time in the window.',
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.name}`, '', `\`${r.file}\``, '');
    const file = path.join(out, r.name, 'cpu-summary.json');
    if (!r.ok || !fs.existsSync(file)) {
      lines.push(`Failed: ${r.why || 'no summary'}.`, '');
      continue;
    }
    const rows = sceneInventory(JSON.parse(fs.readFileSync(file, 'utf8')));
    lines.push('| worker | busy ms/s | engine functions (self %) | game | vendor |', '| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const fns = row.engine.map((f) => `${f.key.replace(/ \/src\//, ' ').replace(/^(\S+) (\S+?):\d+$/, '`$1` ($2)')} ${f.pct.toFixed(1)}`).join('; ');
      lines.push(`| ${row.label} | ${row.busy.toFixed(0)} | ${fns || '–'} | ${row.game.toFixed(1)} % | ${row.vendor.toFixed(1)} % |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(out, 'inventory.md'), lines.join('\n'));
}

function main() {
  const args = parseArgs();
  const set = String(args.set || 'all');
  let files = set === 'demos' ? DEMOS : set === 'stress' ? STRESS : [...DEMOS, ...STRESS];
  if (args.only) {
    const only = new Set(String(args.only).split(',').map((s) => s.trim()));
    files = files.filter((f) => only.has(sceneName(f)));
  }
  const opts = {
    out: path.resolve(repoRoot, String(args.out || 'tests/results/wasm-q1b')),
    warmupMs: Number(args['warmup-ms'] ?? 6000),
    durationMs: Number(args['duration-ms'] ?? 8000),
    timeoutMs: Number(args['timeout-ms'] ?? 180000),
    keepTraces: Boolean(args['keep-traces']),
  };
  fs.mkdirSync(opts.out, { recursive: true });
  const indexFile = path.join(opts.out, 'results.json');
  let results = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  if (!args['inventory-only']) {
    files.forEach((file, k) => {
      console.log(`[sweep] ${k + 1}/${files.length} ${sceneName(file)}`);
      const r = profileScene(file, opts);
      console.log(`[sweep]   ${r.ok ? 'ok' : `FAILED (${r.why})`} in ${r.seconds.toFixed(0)} s`);
      results = results.filter((x) => x.name !== r.name).concat(r);
      fs.writeFileSync(indexFile, JSON.stringify(results, null, 2));
    });
  }
  const order = [...DEMOS, ...STRESS];
  results.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
  writeInventory(opts.out, results);
  console.log(`[sweep] inventory: ${path.join(opts.out, 'inventory.md')}`);
}

if (isCli(import.meta.url)) main();
