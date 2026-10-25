#!/usr/bin/env node
/**
 * Profile many scenes the way E-76 Q1 profiled four, one scene at a time, in three passes:
 *
 *   cpu    one headed CPU trace per scene (source, detailed stats off), a warm-up, then a window
 *          summarized per thread by summarizeChromeCpuTrace.mjs (self time, GC ms)
 *   deopt  the same run with V8's deopt and IC logs, summarized by summarizeV8Deopt.mjs: deopts in
 *          steady state ranked by count × that function's self ms, megamorphic ICs
 *   heap   a sampling heap profile of every worker the page starts, the Box2D worker (box2dWasm.js)
 *          included (heapSampleWorkers.mjs): KB/s
 *          allocated per worker and the sites that allocate it
 *
 * For each scene, <out>/<name>/ gets the cpu pass's stress.json, cpu-summary.json, hot-lines.md and
 * summary.txt, <out>/<name>/deopt/deopt.json and <out>/<name>/heap/heap.json. <out>/inventory.md then
 * lists, per scene, every busy worker's ms/s, GC ms/s and hottest engine functions (src/ and the
 * engine's own wasm://), with game and bench code (demos/, tests/) added up apart since that code
 * stays in JS, and the engine's steady-state deopts and allocation rates when those passes ran.
 *
 *   node tests/bench/profileSceneSweep.mjs [--pass cpu|deopt|heap|boot] [--set demos|stress|all]
 *        [--only name,name] [--warmup-ms 6000] [--duration-ms 8000] [--out tests/results/wasm-q1b]
 *        [--inventory-only] [--keep-traces] [--browser firefox] [--dist]
 *
 * The boot pass only starts each scene and checks it ran (exit status, page errors), in --browser's browser; with
 * --dist on the dist/ bundle (weed.bundle.esm.min.js, which must be fresh), not the source.
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

/** Runner flags a scene needs to show its load. */
const SCENE_ARGS = {
  // 10 000 animated characters, all of them in view only at the minimum zoom (the owner's setting).
  adobeAnimateScene: ['--camera-zoom', 'min'],
};

/** Modules that export more than one scene: the one the sweep runs (the heaviest variant). */
const SCENE_EXPORTS = {
  bulletStormScene: 'BulletStormScene3W',
  painterMoveStressScene: 'PainterMoveReinsertScene',
  painterAdobeStressScene: 'PainterAdobe1WReinsertScene',
  decoChurnStressScene: 'DecoChurnStressScene3W',
  particleEmitStressScene: 'ParticleEmitStressScene3W',
};

const PASSES = ['cpu', 'deopt', 'heap', 'boot'];

/** The scene class a module exports: SCENE_EXPORTS's, or the first exported class named …Scene…. */
export function sceneExport(file) {
  const pinned = SCENE_EXPORTS[path.basename(file, '.js')];
  if (pinned) return pinned;
  const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const m = src.match(/export\s+class\s+(\w*Scene\w*)\s+extends\b/);
  if (!m) throw new Error(`${file}: no exported scene class`);
  return m[1];
}

const sceneName = (file) => path.basename(file, '.js');
const bench = (script) => path.join(repoRoot, 'tests/bench', script);

function spawn(args, opts) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

function failed(run) {
  return run.error ? run.error.message : `exit ${run.status}`;
}

/** The benchmark runner on one scene, with a CPU trace and any extra flags. */
function runScene(file, dir, opts, extra = []) {
  const name = sceneName(file);
  const run = spawn([
    bench('runIntegratedWorkerBenchmark.mjs'), '--src', '--headed', '--trace-cpu', '--no-collect-detailed-stats',
    '--scene', file, '--scene-export', sceneExport(file), '--warmup-ms', String(opts.warmupMs),
    '--duration-ms', String(opts.durationMs), '--output', path.join(dir, 'stress.json'),
    ...(SCENE_ARGS[name] || []), ...extra,
  ], opts);
  fs.writeFileSync(path.join(dir, 'run.log'), `${run.stdout || ''}\n${run.stderr || ''}`);
  return run;
}

function cpuPass(file, dir, opts) {
  const run = runScene(file, dir, opts);
  const trace = path.join(dir, 'engine_trace.json');
  if (run.status !== 0 || !fs.existsSync(trace)) return failed(run);
  const sum = spawn([bench('summarizeChromeCpuTrace.mjs'), trace, '--from-ms', String(opts.warmupMs)], opts);
  fs.writeFileSync(path.join(dir, 'summary.txt'), sum.stdout || sum.stderr || '');
  // The trace is large and the summary holds what the inventory reads.
  if (!opts.keepTraces) fs.rmSync(trace, { force: true });
  return sum.status === 0 ? '' : 'summary failed';
}

function deoptPass(file, dir, opts) {
  const logs = path.join(dir, 'v8');
  fs.rmSync(logs, { recursive: true, force: true });
  const run = runScene(file, dir, opts, ['--js-flags', '--log-deopt --log-ic', '--v8-log-dir', logs]);
  const trace = path.join(dir, 'engine_trace.json');
  if (run.status !== 0 || !fs.existsSync(logs)) return failed(run);
  const sum = spawn([bench('summarizeV8Deopt.mjs'), logs, '--warmup-ms', String(opts.warmupMs), '--trace', trace], opts);
  fs.writeFileSync(path.join(dir, 'deopt.txt'), sum.stdout || sum.stderr || '');
  const summary = path.join(logs, 'summary.json');
  if (sum.status !== 0 || !fs.existsSync(summary)) return 'summary failed';
  fs.copyFileSync(summary, path.join(dir, 'deopt.json'));
  // The logs run to hundreds of MB.
  if (!opts.keepTraces) {
    fs.rmSync(logs, { recursive: true, force: true });
    fs.rmSync(trace, { force: true });
  }
  return '';
}

function heapPass(file, dir, opts) {
  const name = sceneName(file);
  const run = spawn([
    bench('heapSampleWorkers.mjs'), '--scene', file, '--scene-export', sceneExport(file), '--workers', 'Worker,box2d',
    '--warmup-ms', String(opts.warmupMs), '--sample-ms', String(opts.durationMs), '--output', path.join(dir, 'heap.json'),
    ...(SCENE_ARGS[name] || []),
  ], opts);
  fs.writeFileSync(path.join(dir, 'run.log'), `${run.stdout || ''}\n${run.stderr || ''}`);
  return run.status === 0 && fs.existsSync(path.join(dir, 'heap.json')) ? '' : failed(run);
}

/**
 * boot: the scene runs a short window (no trace) in --browser's browser (Chrome by default, `firefox` for
 * the installed Firefox), and fails on a nonzero exit or a page error: the check that every scene still starts where
 * no JS fallback is left (WASM_HYPOTHESES L7).
 */
function bootPass(file, dir, opts) {
  const name = sceneName(file);
  const run = spawn([
    bench('runIntegratedWorkerBenchmark.mjs'), ...(opts.dist ? [] : ['--src']), '--headed', '--no-collect-detailed-stats',
    ...(opts.browser ? ['--browser', opts.browser] : []),
    '--scene', file, '--scene-export', sceneExport(file), '--warmup-ms', String(opts.warmupMs),
    '--duration-ms', String(opts.durationMs), '--output', path.join(dir, 'boot.json'),
    ...(SCENE_ARGS[name] || []),
  ], opts);
  const out = `${run.stdout || ''}\n${run.stderr || ''}`;
  fs.writeFileSync(path.join(dir, 'run.log'), out);
  const error = out.split('\n').find((l) => /\[(benchmark )?page error\]|Fatal engine error/.test(l));
  if (error) return error.trim().slice(0, 240);
  return run.status === 0 ? '' : failed(run);
}

function profileScene(file, opts) {
  const name = sceneName(file);
  const dir = opts.pass === 'cpu' ? path.join(opts.out, name) : path.join(opts.out, name, opts.pass);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const why = opts.pass === 'deopt' ? deoptPass(file, dir, opts)
    : opts.pass === 'heap' ? heapPass(file, dir, opts)
    : opts.pass === 'boot' ? bootPass(file, dir, opts)
    : cpuPass(file, dir, opts);
  return { name, file, ok: !why, why, seconds: (Date.now() - t0) / 1000 };
}

// Engine code: src/ (Pixi's vendor build apart) and the engine's own kernels, which load as wasm://.
const isEngine = (key) => (/\s\/src\//.test(key) && !/\/src\/vendor\//.test(key)) || /\swasm:\/\//.test(key);
const isGame = (key) => /\s\/(demos|tests)\//.test(key);

/** One scene's rows: busy workers, their GC time, top engine functions, and the game-code share. */
export function sceneInventory(summary, { minBusy = 50, minPct = 2, top = 8 } = {}) {
  const rows = [];
  for (const t of Object.values(summary.threads || {})) {
    if (!(t.busyMsPerS >= minBusy)) continue;
    const self = t.self || [];
    const engine = self.filter((f) => isEngine(f.key) && f.pct >= minPct).slice(0, top);
    const game = self.filter((f) => isGame(f.key)).reduce((s, f) => s + f.pct, 0);
    const vendor = self.filter((f) => /\/src\/vendor\//.test(f.key)).reduce((s, f) => s + f.pct, 0);
    const gcPerS = t.windowMs > 0 ? (t.gcMs || 0) / (t.windowMs / 1000) : 0;
    rows.push({ label: t.label, kind: t.kind, busy: t.busyMsPerS, gcPerS, engine, game, vendor });
  }
  rows.sort((a, b) => b.busy - a.busy);
  return rows;
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const shortKey = (key) => key.replace(/ \/src\//, ' ').replace(/^(\S+) (\S+?):(\d+)$/, '`$1` ($2:$3)');

/** Steady-state engine deopts (count ≥ 10) and megamorphic engine ICs from a deopt pass. */
export function deoptRows(report, { minCount = 10, top = 6 } = {}) {
  const deopts = (report?.rankedSteadyDeopts || []).filter((r) => r.steadyCount >= minCount && /\/src\//.test(r.pair)).slice(0, top);
  const mega = Object.entries(report?.megaIc || {}).filter(([k]) => /\/src\//.test(k)).slice(0, top);
  return { deopts, mega };
}

/** Per worker, the KB/s it allocated and its top engine allocation sites from a heap pass. */
export function heapRows(report, { top = 4 } = {}) {
  return Object.entries(report || {})
    .map(([worker, r]) => ({ worker: worker.split(' ')[0], kbPerS: r.totalKbPerS, sites: (r.top || []).filter((s) => /^\S+ src\//.test(s.site)).slice(0, top) }))
    .filter((w) => w.kbPerS > 0)
    .sort((a, b) => b.kbPerS - a.kbPerS);
}

function writeInventory(out, results) {
  const lines = [
    '# Scene profile inventory (E-76 Q1b)',
    '',
    'Per scene, every worker busy at least 50 ms/s, its GC time, its self time by function (engine',
    'code under `src/` and the engine\'s own `wasm://` kernels, at least 2 % of that worker), and the',
    'share of game or bench code (`demos/`, `tests/`) and of Pixi\'s vendor code. Shares are of the',
    'worker\'s busy time in the window. Where the deopt and heap passes ran: engine deopts in steady',
    'state (at least 10), megamorphic engine ICs, and each worker\'s allocation rate with its top sites.',
    '',
  ];
  for (const r of results) {
    const extra = SCENE_ARGS[r.name] ? ` with \`${SCENE_ARGS[r.name].join(' ')}\`` : '';
    lines.push(`## ${r.name}`, '', `\`${r.file}\`${extra}`, '');
    const cpu = readJson(path.join(out, r.name, 'cpu-summary.json'));
    if (!r.ok || !cpu) {
      lines.push(`Failed: ${r.why || 'no summary'}.`, '');
      continue;
    }
    lines.push('| worker | busy ms/s | GC ms/s | engine functions (self %) | game | vendor |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of sceneInventory(cpu)) {
      const fns = row.engine.map((f) => `${shortKey(f.key)} ${f.pct.toFixed(1)}`).join('; ');
      lines.push(`| ${row.label} | ${row.busy.toFixed(0)} | ${row.gcPerS.toFixed(1)} | ${fns || '–'} | ${row.game.toFixed(1)} % | ${row.vendor.toFixed(1)} % |`);
    }
    lines.push('');
    const deopt = readJson(path.join(out, r.name, 'deopt', 'deopt.json'));
    if (deopt) {
      const { deopts, mega } = deoptRows(deopt);
      lines.push(`Steady-state engine deopts: ${deopts.length ? deopts.map((d) => `${d.pair.replace(/\S*\/src\//, '')} ×${d.steadyCount}`).join('; ') : 'none'}.`);
      lines.push(`Megamorphic engine ICs: ${mega.length ? mega.map(([k, n]) => `${k.replace(/\S*\/src\//, '')} ×${n}`).join('; ') : 'none'}.`, '');
    }
    const heap = readJson(path.join(out, r.name, 'heap', 'heap.json'));
    if (heap) {
      const rows = heapRows(heap);
      lines.push(`Allocation: ${rows.length ? rows.map((w) => `${w.worker} ${w.kbPerS} KB/s${w.sites.length ? ` (${w.sites.map((s) => `${s.site.replace(/ src\//, ' ')} ${s.kbPerS}`).join(', ')})` : ''}`).join('; ') : 'none sampled'}.`, '');
    }
  }
  fs.writeFileSync(path.join(out, 'inventory.md'), lines.join('\n'));
}

function main() {
  const args = parseArgs();
  const set = String(args.set || 'all');
  const pass = String(args.pass || 'cpu');
  if (!PASSES.includes(pass)) throw new Error(`unknown pass ${pass}`);
  let files = set === 'demos' ? DEMOS : set === 'stress' ? STRESS : [...DEMOS, ...STRESS];
  if (args.only) {
    const only = new Set(String(args.only).split(',').map((s) => s.trim()));
    files = files.filter((f) => only.has(sceneName(f)));
  }
  const opts = {
    pass,
    out: path.resolve(repoRoot, String(args.out || 'tests/results/wasm-q1b')),
    warmupMs: Number(args['warmup-ms'] ?? 6000),
    durationMs: Number(args['duration-ms'] ?? 8000),
    timeoutMs: Number(args['timeout-ms'] ?? 180000),
    keepTraces: Boolean(args['keep-traces']),
    browser: args.browser ? String(args.browser) : '',
    dist: Boolean(args.dist),
  };
  fs.mkdirSync(opts.out, { recursive: true });
  // The cpu pass's index is results.json; the others keep their own.
  const indexOf = (p) => path.join(opts.out, p === 'cpu' ? 'results.json' : `results-${p}.json`);
  let results = readJson(indexOf(pass)) || [];
  if (!args['inventory-only']) {
    files.forEach((file, k) => {
      console.log(`[sweep] ${pass} ${k + 1}/${files.length} ${sceneName(file)}`);
      let r;
      try {
        r = profileScene(file, opts);
      } catch (err) {
        r = { name: sceneName(file), file, ok: false, why: err.message, seconds: 0 };
      }
      console.log(`[sweep]   ${r.ok ? 'ok' : `FAILED (${r.why})`} in ${r.seconds.toFixed(0)} s`);
      results = results.filter((x) => x.name !== r.name).concat(r);
      fs.writeFileSync(indexOf(pass), JSON.stringify(results, null, 2));
    });
  }
  const cpuResults = readJson(indexOf('cpu')) || [];
  const order = [...DEMOS, ...STRESS];
  cpuResults.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
  writeInventory(opts.out, cpuResults);
  console.log(`[sweep] inventory: ${path.join(opts.out, 'inventory.md')}`);
}

if (isCli(import.meta.url)) main();
