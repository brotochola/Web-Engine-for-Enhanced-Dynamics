/**
 * Shared measurement helpers: src snapshot, Playwright retry, load gate, metrics.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerLoadPct } from '../../src/util/workersUtils.js';
import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS, STEP_MS_FLOOR } from './benchmarkDefaults.mjs';
import { median, pctDelta, writeJson } from './featureTournamentLib.mjs';
import { applyWorkloadCounts } from './micro-opts-hyps/hypPatches.mjs';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const integratedRunner = path.join(repoRoot, 'tests/bench/runIntegratedWorkerBenchmark.mjs');

export const LOAD_CV_FAIL = 0.5;
export const LOAD_PCT_FAIL = 5;
export const SPEED_PCT = 3;
export { STEP_MS_FLOOR };

function isMsPrimaryMetric(key) {
  return typeof key === 'string' && /_MS$/i.test(key);
}

/**
 * Stress keep/drop only. Gameplay (`kind: 'gameplay'`, or a demo path) skips the 3 ms floor.
 * Campaigns that omit `kind` still count as stress when the path is under stressScenes.
 */
export function usesStressStepFloor(scene) {
  if (!scene) return false;
  if (scene.kind === 'gameplay') return false;
  if (scene.kind === 'stress') return true;
  const p = String(scene.path || '');
  if (p.includes('/demos/')) return false;
  return p.includes('/stressScenes/') || scene.headed === false;
}

function stepMsFloorHits(summary, primaryKeys) {
  const hits = [];
  for (const key of primaryKeys || []) {
    if (!isMsPrimaryMetric(key)) continue;
    const med = summary?.[key]?.median;
    if (!Number.isFinite(med)) continue;
    if (med < STEP_MS_FLOOR) hits.push({ key, median: med });
  }
  return hits;
}

export function explainStepMsFloor(hits) {
  if (!hits?.length) return '';
  const bits = hits.map((h) => `${h.side} ${h.key}=${h.median.toFixed(3)} ms`);
  return (
    `step floor: primaria de estrés bajo ${STEP_MS_FLOOR} ms (${bits.join('; ')}). ` +
    'Subí la perilla de esa escena (más partículas, balas, decorations, cuerpos, stamps, mapa o rays). ' +
    'El delta no cuenta como keep/drop.'
  );
}

/** Both sides must have every ms primary ≥ STEP_MS_FLOOR or the pair is not comparable. */
export function stepMsFloorOk(baseSum, hypSum, primaryKeys) {
  const baseHits = stepMsFloorHits(baseSum, primaryKeys).map((h) => ({ ...h, side: 'baseline' }));
  const hypHits = stepMsFloorHits(hypSum, primaryKeys).map((h) => ({ ...h, side: 'hyp' }));
  const hits = [...baseHits, ...hypHits];
  return { ok: hits.length === 0, hits, reason: explainStepMsFloor(hits) };
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

export function snapshotSrcTree() {
  const files = new Map();
  const srcRoot = path.join(repoRoot, 'src');
  for (const abs of walkFiles(srcRoot)) {
    files.set(path.relative(repoRoot, abs).replace(/\\/g, '/'), fs.readFileSync(abs));
  }
  return files;
}

export function snapshotFiles(relPaths) {
  const files = new Map();
  for (const rel of relPaths) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) files.set(rel.replace(/\\/g, '/'), fs.readFileSync(abs));
  }
  return files;
}

export function restoreSnapshot(files) {
  for (const [rel, buf] of files) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
}

export function restoreSrcTree(files) {
  const srcRoot = path.join(repoRoot, 'src');
  const want = new Set(files.keys());
  for (const abs of walkFiles(srcRoot)) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    if (!want.has(rel)) fs.unlinkSync(abs);
  }
  restoreSnapshot(files);
}

export function applySrcRev(rev) {
  const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', 'src'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const names = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const want = new Set(names);
  const srcRoot = path.join(repoRoot, 'src');
  for (const abs of walkFiles(srcRoot)) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    if (!want.has(rel)) fs.unlinkSync(abs);
  }
  for (const rel of names) {
    const body = execFileSync('git', ['show', `${rev}:${rel}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

export function applyBaselineRev(rev) {
  applySrcRev(rev);
  applyWorkloadCounts();
}

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stdevSample(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

export function cv(arr) {
  const m = mean(arr);
  return m > 0 ? stdevSample(arr) / m : 0;
}

export function seriesStats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return { median: median(nums), mean: mean(nums), cv: cv(nums), samples: nums };
}

export function summarizeRuns(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number');
  return Object.fromEntries(keys.map((k) => [k, seriesStats(rows.map((r) => r[k]))]));
}

export function workloadOk(baseSum, hypSum, keys) {
  const drifts = [];
  for (const key of keys) {
    const b = baseSum[key];
    const h = hypSum[key];
    if (key === 'BODY_COUNT' && !(b?.median > 0)) {
      drifts.push({ key, pct: null, reason: `baseline ${key} median is ${b?.median}` });
      continue;
    }
    if (key === 'ACTIVE_BULLETS' && !(b?.median > 0)) {
      drifts.push({ key, pct: null, reason: `baseline ${key} median is ${b?.median}` });
      continue;
    }
    if (key === 'ACTIVE_DECORATIONS' && !(b?.median > 0)) {
      drifts.push({ key, pct: null, reason: `baseline ${key} median is ${b?.median}` });
      continue;
    }
    if ((b?.cv ?? 0) >= LOAD_CV_FAIL || (h?.cv ?? 0) >= LOAD_CV_FAIL) {
      drifts.push({
        key,
        pct: null,
        reason: `cv too high (base ${((b?.cv ?? 0) * 100).toFixed(0)}% hyp ${((h?.cv ?? 0) * 100).toFixed(0)}%)`,
      });
      continue;
    }
    if (!(b?.median > 0)) continue;
    const d = pctDelta(h?.median, b.median);
    if (d == null) continue;
    if (Math.abs(d) > LOAD_PCT_FAIL) drifts.push({ key, pct: d });
  }
  return { ok: drifts.length === 0, drifts };
}

function avgOf(worker) {
  return worker?.statsSamplesAverage || {};
}

export function extractMetrics(report) {
  const workers = report.workers || [];
  const pick = (pred) => workers.find(pred);
  const physics = avgOf(pick((w) => w.id === 'physics' || w.type === 'physics'));
  const logic0 = avgOf(pick((w) => w.id === 'logic0'));
  const particle = avgOf(pick((w) => w.id === 'particle' || w.type === 'particle'));
  const preRender = avgOf(pick((w) => w.id === 'preRender' || w.type === 'preRender'));
  const pixi = avgOf(
    pick((w) => w.id === 'renderer' || w.type === 'pixi' || w.id === 'pixi' || w.type === 'renderer')
  );
  let spatialMax = null;
  for (const w of workers) {
    if (!String(w.id || '').startsWith('spatial')) continue;
    const step = avgOf(w).STEP_MS ?? 0;
    if (!spatialMax || step > spatialMax.STEP_MS) {
      spatialMax = { id: w.id, STEP_MS: step, NEIGHBOR_MS: avgOf(w).NEIGHBOR_MS ?? 0, NEIGHBORS_REUSED: avgOf(w).NEIGHBORS_REUSED ?? 0 };
    }
  }
  return {
    BODY_COUNT: physics.BODY_COUNT ?? 0,
    AWAKE_COUNT: physics.AWAKE_COUNT ?? 0,
    BODY_MOVED_COUNT: physics.BODY_MOVED_COUNT ?? 0,
    HEAP_USED_KB: physics.HEAP_USED_KB ?? 0,
    ACTIVE_PARTICLES: particle.ACTIVE_PARTICLES ?? 0,
    PARTICLES_STAMPED: particle.PARTICLES_STAMPED ?? 0,
    ACTIVE_BULLETS: particle.ACTIVE_BULLETS ?? 0,
    ACTIVE_DECORATIONS: particle.ACTIVE_DECORATIONS ?? 0,
    ENTITIES_PROCESSED: logic0.ENTITIES_PROCESSED ?? 0,
    NEIGHBORS_REUSED: spatialMax?.NEIGHBORS_REUSED ?? 0,
    physics_STEP_MS: physics.STEP_MS ?? 0,
    logic0_STEP_MS: logic0.STEP_MS ?? 0,
    logic0_RAYCAST_MS: logic0.RAYCAST_MS ?? 0,
    logic0_RAYCAST_COUNT: logic0.RAYCAST_COUNT ?? 0,
    particle_STEP_MS: particle.STEP_MS ?? 0,
    PARTICLE_PHYSICS_MS: particle.PARTICLE_PHYSICS_MS ?? 0,
    preRender_STEP_MS: preRender.STEP_MS ?? 0,
    VISIBILITY_MS: preRender.VISIBILITY_MS ?? 0,
    pixi_STEP_MS: pixi.STEP_MS ?? 0,
    DECAL_TILES_DIRTY: pixi.DECAL_TILES_DIRTY ?? 0,
    DECAL_TILES_UPLOADED: pixi.DECAL_TILES_UPLOADED ?? 0,
    SCENERY_COUNT: pixi.SCENERY_COUNT ?? 0,
    MESH_FILL_INSTANCES: pixi.MESH_FILL_INSTANCES ?? 0,
    MESH_RT_DRAWS: pixi.MESH_RT_DRAWS ?? 0,
    spatialMax_STEP_MS: spatialMax?.STEP_MS ?? 0,
    spatialMax_NEIGHBOR_MS: spatialMax?.NEIGHBOR_MS ?? 0,
    physics_loadPct: workerLoadPct(physics.STEP_MS ?? 0),
  };
}

export function runIntegratedOnce(scene, outPath, opts) {
  const args = [
    integratedRunner,
    '--src',
    '--scene',
    scene.path,
    '--scene-export',
    scene.exportName,
    '--warmup-ms',
    String(opts.warmupMs),
    '--duration-ms',
    String(opts.durationMs),
    '--output',
    outPath,
  ];
  if (opts.headed) args.push('--headed');
  if (!opts.detailedStats) args.push('--no-collect-detailed-stats');
  execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

export function runIntegratedWithRetry(scene, outPath, opts) {
  try {
    return { ok: true, report: runIntegratedOnce(scene, outPath, opts) };
  } catch (e) {
    console.warn(`Playwright fail; retry 1x (${e.message || e})`);
    try {
      return { ok: true, report: runIntegratedOnce(scene, outPath, opts), retried: true };
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2), retried: true };
    }
  }
}

/** Headed 5×25/18 only if the feature id is in --headed-only; else catalog scene.headed. */
export function sceneWantsHeaded(scene, args, featureId) {
  if (!scene) return false;
  if (args.headlessAll) return false;
  if (args.headedOnly) return args.headedOnly.includes(featureId);
  return Boolean(scene.headed);
}

export function measureSceneSide(label, scene, args, outDir, featureId) {
  const headed = sceneWantsHeaded(scene, args, featureId);
  const runs = headed ? args.runs : args.stressRuns;
  const warmupMs = headed ? args.warmupMs : args.stressWarmupMs;
  const durationMs = headed ? args.durationMs : args.stressDurationMs;
  const benchOpts = { warmupMs, durationMs, headed, detailedStats: Boolean(args.detailedStats) };
  const rows = [];
  for (let r = 0; r < runs; r++) {
    const out = path.join(outDir, `${label}-r${r}.json`);
    const res = runIntegratedWithRetry(scene, out, benchOpts);
    if (!res.ok) return { ok: false, error: res.error, rows };
    rows.push(extractMetrics(res.report));
  }
  return { ok: true, rows, summary: summarizeRuns(rows), headed, runs, warmupMs, durationMs };
}

function lookupPath(obj, dotted) {
  if (!dotted) return null;
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return typeof cur === 'number' ? cur : null;
}

export function pickOps(json) {
  if (!json) return null;
  const direct = lookupPath(json, 'cases.emitFlat_burst.opsPerSec');
  if (direct) return direct;
  const cases = json.cases || {};
  for (const c of Object.values(cases)) {
    if (c && typeof c.opsPerSec === 'number') return c.opsPerSec;
  }
  return null;
}

export function pickOpsWithKey(json, opsKey) {
  const named = lookupPath(json, opsKey);
  if (typeof named === 'number') return named;
  return pickOps(json);
}

export function runKernelScript(scriptRel, outPath) {
  const script = path.join(repoRoot, scriptRel);
  execFileSync(process.execPath, [script, '--output', outPath], { cwd: repoRoot, stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

export function parseMeasureArgs(argv, extras = {}) {
  const out = {
    runs: 5,
    stressRuns: 2,
    warmupMs: DEFAULT_WARMUP_MS,
    durationMs: DEFAULT_DURATION_MS,
    stressWarmupMs: 8000,
    stressDurationMs: 10000,
    vs: '0695a8d',
    only: null,
    skipKernels: false,
    skipScenes: false,
    skipLockstep: false,
    skipNode: false,
    headlessAll: false,
    headedOnly: null,
    detailedStats: false,
    smoke: false,
    ...extras,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--vs' && argv[i + 1]) out.vs = String(argv[++i]);
    else if (a === '--only' && argv[i + 1]) {
      out.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--headed-only' && argv[i + 1]) {
      out.headedOnly = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || out.warmupMs;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || out.durationMs;
    else if (a === '--skip-kernels') out.skipKernels = true;
    else if (a === '--skip-scenes') out.skipScenes = true;
    else if (a === '--skip-lockstep') out.skipLockstep = true;
    else if (a === '--skip-node') out.skipNode = true;
    else if (a === '--headless') out.headlessAll = true;
    else if (a === '--detailed-stats') out.detailedStats = true;
    else if (a === '--smoke') {
      out.smoke = true;
      out.runs = 1;
      out.stressRuns = 1;
      out.warmupMs = 5000;
      out.durationMs = 4000;
      out.stressWarmupMs = 4000;
      out.stressDurationMs = 4000;
    }
  }
  return out;
}

const COUNT_KEYS = new Set([
  'BODY_COUNT',
  'AWAKE_COUNT',
  'BODY_MOVED_COUNT',
  'ACTIVE_PARTICLES',
  'PARTICLES_STAMPED',
  'ACTIVE_BULLETS',
  'ACTIVE_DECORATIONS',
  'ENTITIES_PROCESSED',
  'NEIGHBORS_REUSED',
  'HEAP_USED_KB',
  'logic0_RAYCAST_COUNT',
]);

export function metricKind(key) {
  if (key === 'kernel' || key.endsWith('_ops') || /ops/i.test(key)) return 'ops';
  if (/loadPct/i.test(key)) return 'pct';
  if (COUNT_KEYS.has(key) || /_COUNT$/.test(key)) return 'count';
  return 'ms';
}

export function fmtStat(stat, kind = 'ms') {
  if (!stat || !Number.isFinite(stat.median)) return 'n/a';
  const cv = Number.isFinite(stat.cv) ? ` (cv ${(stat.cv * 100).toFixed(1)}%)` : '';
  if (kind === 'count') return `${stat.median.toFixed(1)}${cv}`;
  if (kind === 'ops') return `${stat.median.toFixed(0)} ops/s${cv}`;
  if (kind === 'pct') return `${stat.median.toFixed(1)}%${cv}`;
  return `${stat.median.toFixed(3)} ms${cv}`;
}

export function fmtDeltaPct(d) {
  if (d == null || !Number.isFinite(d)) return 'n/a';
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

export function explainHit(hit) {
  const d = hit.deltaPct;
  const dTxt = fmtDeltaPct(d);
  if (hit.higherBetter) {
    if (d == null) return `${hit.metric}: no hay ops comparables.`;
    if (d >= SPEED_PCT) {
      return `${hit.metric} subió ${dTxt} (más ops/s es más barato). Cruza el umbral de +3%.`;
    }
    if (d <= -SPEED_PCT) {
      return `${hit.metric} bajó ${dTxt} (menos ops/s es más caro). Cruza el umbral de −3%.`;
    }
    return `${hit.metric} ${dTxt}: dentro de 3%, empate.`;
  }
  const kind = metricKind(hit.metric);
  const unit = kind === 'count' ? '' : ' ms';
  const b = Number.isFinite(hit.base) ? hit.base.toFixed(3) + unit : 'n/a';
  const h = Number.isFinite(hit.hyp) ? hit.hyp.toFixed(3) + unit : 'n/a';
  if (d == null) return `${hit.metric}: no hay mediana comparable.`;
  if (d >= SPEED_PCT) {
    return `${hit.metric} pasó de ${b} a ${h} (${dTxt}). Más milisegundos es más caro. Cruza el umbral de +3%, así que la fila queda WORSE.`;
  }
  if (d <= -SPEED_PCT) {
    return `${hit.metric} pasó de ${b} a ${h} (${dTxt}). Menos milisegundos es más barato. Cruza el umbral de −3%, así que hay keep de velocidad.`;
  }
  return `${hit.metric} pasó de ${b} a ${h} (${dTxt}): dentro de 3%, empate.`;
}

export function renderCompareTable(base, hyp, keys) {
  const lines = ['| Métrica | baseline | árbol actual | delta |', '|---------|----------|--------------|-------|'];
  for (const key of keys) {
    const b = base?.[key];
    const h = hyp?.[key];
    if (!b && !h) continue;
    const kind = metricKind(key);
    const d = pctDelta(h?.median, b?.median);
    lines.push(`| ${key} | ${fmtStat(b, kind)} | ${fmtStat(h, kind)} | ${fmtDeltaPct(d)} |`);
  }
  return lines.join('\n');
}

export function sceneMetricKeys(feature, scenePair) {
  const extra = [
    'BODY_COUNT',
    'AWAKE_COUNT',
    'ACTIVE_PARTICLES',
    'PARTICLES_STAMPED',
    'ACTIVE_BULLETS',
    'ACTIVE_DECORATIONS',
    'ENTITIES_PROCESSED',
    'NEIGHBORS_REUSED',
    'HEAP_USED_KB',
    'physics_STEP_MS',
    'logic0_STEP_MS',
    'particle_STEP_MS',
    'spatialMax_STEP_MS',
    'preRender_STEP_MS',
    'VISIBILITY_MS',
    'pixi_STEP_MS',
    'DECAL_TILES_DIRTY',
    'DECAL_TILES_UPLOADED',
    'SCENERY_COUNT',
    'MESH_FILL_INSTANCES',
    'MESH_RT_DRAWS',
    'physics_loadPct',
  ];
  const want = [...(feature?.load || []), ...(feature?.primary || []), ...extra];
  const seen = new Set();
  const keys = [];
  for (const k of want) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (scenePair?.base?.[k] || scenePair?.hyp?.[k]) keys.push(k);
  }
  return keys;
}

export { writeJson, pctDelta, median, DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS };
