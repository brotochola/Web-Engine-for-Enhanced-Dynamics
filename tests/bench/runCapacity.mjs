#!/usr/bin/env node
/**
 * Capacity: how many entities a scene holds at 60 fps with every worker's frame tail inside the vsync budget.
 *
 * A change used to be judged by one worker's mean STEP_MS in one scene. What the engine is for is "the most entities
 * on the web at 60 fps, smooth": so for a scene with a load knob, this ramps the knob and finds the largest load where,
 * over a measured window after warm-up,
 *   - the page presents ≥ 59 fps (main thread, exact frames over the window) and the renderer draws ≥ 59 frames a
 *     second (its exact frames: in a GPU-bound scene main can read 60 while far fewer are drawn), and
 *   - every worker's own work a frame (frameTotals: STEP_MS − WAIT_MS, every frame of the window) has p99 ≤ 16.7 ms
 *     (`--tail p95` judges p95 instead; both are always reported).
 * The frame's critical path is read as the max over workers (the slowest worker sets the frame), and the worker that
 * breaks the rule at the first load above the capacity is the limiting one.
 *
 * The search (searchCapacity): grow (or shrink) the knob geometrically from `start` until a pass and a fail bracket
 * the edge, bisect in log space to `--resolution` (5 %), then run the edge again (`--confirm`, once): the capacity is
 * the largest load that passed every run it had, at least two. An edge that fails its retest is noise: the search
 * resumes below it. A run that errors counts as a fail.
 *
 * Each run is one runIntegratedWorkerBenchmark (headed, --src, detailed stats off, warm-up 9 s, window 10 s by
 * default) and its JSON; a scene's search is about 6 to 9 runs, 4 to 6 minutes. Run it through the bench lock.
 *
 *   node tests/bench/runCapacity.mjs --scene predator
 *   node tests/bench/runCapacity.mjs --scene bunnyMark --rev main [--pool capacity] [--tail p95]
 *   node tests/bench/runCapacity.mjs --scene boids --start 60000 --growth 1.15 --json D:\out\boids.json
 *   node tests/bench/runCapacity.mjs --scene-path /tests/bench/stressScenes/x.js --scene-export X --knob n \
 *       --min 1000 --max 500000 [--step 1000] [--query "a=1&b=2"]
 *   node tests/bench/runCapacity.mjs --list
 *
 * Options: --rev <rev> measures that revision whole (its src, scenes and runner) in a worktree of its own
 * (revWorktree.mjs; --pool <name> reuses ../weed-ab/pool-<name> instead of making and removing one); without it, this
 * tree. --warmup-ms, --duration-ms; --budget-ms (16.7), --fps-min (59), --tail p99|p95; --start, --min, --max, --step,
 * --growth (2), --resolution (0.05), --confirm (1), --max-trials (16); --json <file> (default
 * tests/results/capacity-runs/<stamp>/<scene>.json, beside each run's own JSON; raw results are not kept).
 * scripts/nightlyCapacity.mjs runs the reference set and keeps one line a scene in a history file.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_ENTITIES_U32 } from '../../src/util/entityIdWidth.js';
import { repoRoot, runIntegratedWithRetry } from './measureLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

/** The vsync budget at 60 Hz, the presented-frame floor and the tail the search judges. */
export const DEFAULT_RULE = Object.freeze({ budgetMs: 16.7, fpsMin: 59, tail: 'p99' });
export const DEFAULT_WARMUP_MS = 9000;
export const DEFAULT_DURATION_MS = 10000;

/**
 * The reference scenes and their load knobs. `entities(load)` is the population the knob spawns (the count the
 * capacity is quoted in); `query` is the fixed part of the page query; `start` is a cold search's first load.
 */
export const CAPACITY_SCENES = Object.freeze({
  predator: {
    key: 'predator',
    label: 'Predator',
    covers: 'physics (Box2D), spatial, logic: gameplay',
    path: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    knob: 'crowd',
    // The pools hold crowd 2.5 at most (57 600 entities in 16-bit ids, predatorScene.js); the camera pinned as the
    // Predator sittings pin it.
    min: 0.25,
    max: 2.5,
    start: 1.5,
    step: 0.05,
    query: 'zoom=0.216',
    entities: (crowd) => Math.round(10000 * crowd) + Math.round(6000 * crowd),
    entitiesNote: 'civilians and soldiers',
  },
  predatorNight: {
    key: 'predatorNight',
    label: 'Predator by night (light3d)',
    covers: 'physics, spatial, logic, pre-render lamps',
    path: '/demos/predatorScene/predatorScene.js',
    exportName: 'PredatorScene',
    knob: 'crowd',
    min: 0.25,
    max: 2.5,
    start: 1.5,
    step: 0.05,
    query: 'zoom=0.216&light3d=1&hour=22',
    entities: (crowd) => Math.round(10000 * crowd) + Math.round(6000 * crowd),
    entitiesNote: 'civilians and soldiers',
  },
  boids: {
    key: 'boids',
    label: 'Boids',
    covers: 'spatial (2 workers), logic (4 workers)',
    path: '/demos/boidsScene/boidsScene.js',
    exportName: 'BoidsScene',
    knob: 'boids',
    // N-253: physics scenes take up to 1 048 575 entities (Box2D's tables sized from the scene), and `?boids=` past
    // 65 000 grows the scene's pool and Box2D's memory; 65 000 held 60 fps with every p99 under 12.4 ms on 2026-11-16.
    min: 5000,
    max: 400000,
    start: 40000,
    step: 1000,
    query: '',
    entities: (n) => n,
    entitiesNote: 'boids',
  },
  bunnyMark: {
    key: 'bunnyMark',
    label: 'BunnyMark',
    covers: 'render (pre-render, Pixi, GPU), logic',
    path: '/demos/bunnyMarkScene/bunnyMarkScene.js',
    exportName: 'BunnyMarkScene',
    knob: 'bunnies',
    // The engine's ceiling is 1 048 575 entities (32-bit ids, src/util/entityIdWidth.js MAX_ENTITIES_U32; 500 000 until
    // DX-ENT1M), and the spawner is one of them. 499 999 held (R-1240), so the search starts at 500 000.
    min: 10000,
    max: MAX_ENTITIES_U32 - 1,
    start: 500000,
    step: 5000,
    query: '',
    entities: (n) => n,
    entitiesNote: 'bunnies',
  },
  keyedPack: {
    key: 'keyedPack',
    label: 'Keyed pack stress',
    covers: "Pixi's keyed pack, logic",
    path: '/tests/bench/stressScenes/keyedPackStressScene.js',
    exportName: 'KeyedPackStressScene',
    knob: 'n',
    // The scene's cap, 1 048 573 (the engine's 1 048 575 less two entities a mix can add: DX-ENT1M).
    min: 10000,
    max: 1048573,
    start: 150000,
    step: 5000,
    query: '',
    entities: (n) => n,
    entitiesNote: 'sprites',
  },
});

/** The set scripts/nightlyCapacity.mjs runs: physics (Predator), spatial and logic (boids), render (bunnyMark: the GPU
 * path; keyedPack: pre-render and Pixi's keyed pack). */
export const REFERENCE_SET = Object.freeze(['predator', 'boids', 'bunnyMark', 'keyedPack']);

/** `x` rounded to the knob's step and clamped to [min, max]. */
export function snapLoad(x, { min, max, step = 0 }) {
  let v = x;
  if (step > 0) {
    v = Math.round(x / step) * step;
    if (step < 1) v = Number(v.toFixed(Math.ceil(-Math.log10(step)) + 1));
  }
  return Math.min(max, Math.max(min, v));
}

/** The page query of one run: the scene's fixed part, then the knob. */
export function sceneQuery(def, load) {
  const parts = [];
  if (def.query) parts.push(String(def.query).replace(/^\?/, ''));
  parts.push(`${def.knob}=${load}`);
  return parts.join('&');
}

/** A load for people: 1.85, 250 000. */
export function fmtLoad(load) {
  if (load == null) return '-';
  if (!Number.isInteger(load)) return String(Number(load.toFixed(3)));
  return load.toLocaleString('en-US').replace(/,/g, ' ');
}

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** One worker's window as a row: frames, frames a second, mean work, p50/p95/p99, longest, frames of 16 ms or more. */
function workerRow(id, type, ex, seconds) {
  return {
    id,
    type,
    frames: ex.frames,
    fps: seconds > 0 ? r2(ex.frames / seconds) : null,
    meanMs: r2(Number.isFinite(ex.workMs) ? ex.workMs : ex.stepMs - (ex.waitMs || 0)),
    stepMs: r2(ex.stepMs),
    waitMs: r2(ex.waitMs || 0),
    p50Ms: r2(ex.p50Ms),
    p95Ms: r2(ex.p95Ms),
    p99Ms: r2(ex.p99Ms),
    maxMs: r2(ex.maxMs),
    longFrames: ex.longFrames ?? null,
  };
}

/** Count keys of a worker's sampled stats (bodies, entities processed, queue size): evidence the load was there. */
function loadKeysOf(worker) {
  const avg = worker.statsSamplesAverage || {};
  const out = {};
  for (const [k, v] of Object.entries(avg)) {
    if (/(_COUNT|ENTITIES|PROCESSED|QUEUE_SIZE)$/.test(k) && Number(v) > 0) out[k] = Math.round(Number(v));
  }
  return out;
}

/**
 * Judge one runIntegratedWorkerBenchmark report against the rule. Pure.
 * @returns {{ pass: boolean, passP99: boolean, passP95: boolean, presentedFps: number|null, drawnFps: number|null,
 *   workers: object[], critical: object, reasons: object[], limiting: object|null, tightest: object|null,
 *   fatalError: string|null, loadKeys: object }}
 */
export function judgeRun(report, rule = DEFAULT_RULE) {
  const { budgetMs, fpsMin } = { ...DEFAULT_RULE, ...rule };
  const tail = rule.tail === 'p95' ? 'p95' : 'p99';
  const seconds = Number(report?.measurementDurationMs) / 1000;
  const mt = report?.mainThread || {};
  const presentedFps = Number(mt.exactFPS) > 0 ? mt.exactFPS : Number(mt.averageFPS) >= 0 ? Number(mt.averageFPS) : null;
  const workers = [];
  const noWindow = [];
  if (mt.exact && mt.exact.frames > 0) workers.push(workerRow('main', 'main', mt.exact, seconds));
  let drawnFps = null;
  const loadKeys = {};
  // With the totals on, every worker with a slot counts its frames; a second pre-render has none (frameClock.js).
  const exactWindow = report?.metadata?.exactWindow !== false;
  const stuck = [];
  for (const w of report?.workers || []) {
    const keys = loadKeysOf(w);
    if (Object.keys(keys).length) loadKeys[w.id] = keys;
    if (!w.exact || !(w.exact.frames > 0)) {
      noWindow.push(w.id);
      // A worker that published no frame in the window is stuck, and its tail cannot be read: a fail.
      if (exactWindow && !/^preRender[1-9]\d*$/.test(String(w.id))) stuck.push(w.id);
      if (w.type === 'renderer' && exactWindow) drawnFps = 0;
      continue;
    }
    const row = workerRow(w.id, w.type, w.exact, seconds);
    workers.push(row);
    if (w.type === 'renderer' && seconds > 0) drawnFps = w.exact.frames / seconds;
  }

  const fpsReasons = [];
  if (!(presentedFps >= fpsMin)) fpsReasons.push({ kind: 'fps', what: 'presented', value: r2(presentedFps), limit: fpsMin });
  if (drawnFps != null && drawnFps < fpsMin) fpsReasons.push({ kind: 'fps', what: 'drawn', value: r2(drawnFps), limit: fpsMin });
  const tailReasons = (key) =>
    workers
      .filter((w) => w[key] > budgetMs)
      .map((w) => ({ kind: 'tail', what: w.id, metric: key.replace('Ms', ''), value: w[key], limit: budgetMs }));
  const p99Reasons = tailReasons('p99Ms');
  const p95Reasons = tailReasons('p95Ms');
  const fatalError = report?.metadata?.fatalError || null;
  const otherReasons = [];
  if (fatalError) otherReasons.push({ kind: 'fatal', what: String(fatalError).slice(0, 200) });
  if (!workers.length) otherReasons.push({ kind: 'noWindow', what: 'no worker published an exact window (frameTotals)' });
  for (const id of stuck) otherReasons.push({ kind: 'noFrames', what: `${id} published no frame in the window` });

  const passP99 = !fpsReasons.length && !p99Reasons.length && !otherReasons.length;
  const passP95 = !fpsReasons.length && !p95Reasons.length && !otherReasons.length;
  const reasons = [...otherReasons, ...fpsReasons, ...(tail === 'p95' ? p95Reasons : p99Reasons)];

  const maxBy = (key) => {
    let best = null;
    for (const w of workers) if (w[key] != null && (!best || w[key] > best.ms)) best = { ms: w[key], worker: w.id };
    return best;
  };
  const critical = { meanMs: maxBy('meanMs'), p95Ms: maxBy('p95Ms'), p99Ms: maxBy('p99Ms'), maxMs: maxBy('maxMs') };

  // The reason furthest past its limit: a worker's tail over the budget, or the frames short of the floor.
  const severity = (r) => (r.kind === 'tail' ? r.value / r.limit : r.kind === 'fps' ? r.limit / Math.max(r.value, 1e-9) : Infinity);
  let limiting = null;
  for (const r of reasons) if (!limiting || severity(r) > severity(limiting)) limiting = r;
  const tightest = critical[`${tail}Ms`];

  return {
    pass: tail === 'p95' ? passP95 : passP99,
    passP99,
    passP95,
    tail,
    presentedFps: r2(presentedFps),
    drawnFps: r2(drawnFps),
    seconds: r2(seconds),
    workers,
    noWindow,
    critical,
    reasons,
    limiting,
    tightest,
    fatalError,
    loadKeys,
  };
}

/** One line for a judged run: verdict, frames, the worst tail. */
export function describeJudgement(j) {
  if (!j) return 'no report';
  const worst = j.critical?.p99Ms;
  const p95 = j.critical?.p95Ms;
  let s = `${j.pass ? 'PASS' : 'FAIL'} presented ${j.presentedFps ?? '-'} drawn ${j.drawnFps ?? '-'} fps`;
  if (worst) s += ` | worst p99 ${worst.worker} ${worst.ms} ms`;
  if (p95) s += `, p95 ${p95.worker} ${p95.ms} ms`;
  if (!j.pass && j.limiting) s += ` | broke: ${describeReason(j.limiting)}`;
  return s;
}

export function describeReason(r) {
  if (!r) return '-';
  if (r.kind === 'tail') return `${r.what} ${r.metric} ${r.value} ms > ${r.limit}`;
  if (r.kind === 'fps') return `${r.what} ${r.value} fps < ${r.limit}`;
  if (r.kind === 'error') return `error: ${r.what}`;
  return `${r.kind}: ${r.what}`;
}

class TrialBudgetSpent extends Error {}

/**
 * The capacity search against an oracle (load → { pass }), pure apart from the oracle. A load is held when every
 * run of it passed; the capacity is the largest held load with at least 1 + `confirm` runs whose next tested load
 * above failed (or the knob's max). See the header.
 * @param {{ min: number, max: number, start?: number, step?: number, growth?: number, resolution?: number,
 *   confirm?: number, maxTrials?: number, oracle: (load: number, info: { index: number, purpose: string }) =>
 *   Promise<{ pass: boolean, error?: string }> | { pass: boolean, error?: string } }} opts
 * @returns {Promise<{ capacity: number|null, failAbove: number|null, capped: 'max'|'min'|null, confirmed: boolean,
 *   budgetSpent: boolean, trials: { load: number, pass: boolean, purpose: string, error?: string, result: object }[] }>}
 */
export async function searchCapacity({
  min,
  max,
  start,
  step = 0,
  growth = 2,
  resolution = 0.05,
  confirm = 1,
  maxTrials = 16,
  oracle,
}) {
  if (!(min > 0) || !(max >= min)) throw new Error(`searchCapacity: need 0 < min <= max (min ${min}, max ${max})`);
  if (!(growth > 1)) throw new Error(`searchCapacity: growth must be > 1 (${growth})`);
  if (typeof oracle !== 'function') throw new Error('searchCapacity: oracle must be a function');
  const snap = (x) => snapLoad(x, { min, max, step });
  const trials = [];
  const runsAt = new Map();
  const test = async (load, purpose) => {
    if (trials.length >= maxTrials) throw new TrialBudgetSpent();
    const r = (await oracle(load, { index: trials.length, purpose })) || {};
    const t = { load, pass: r.pass === true, purpose, ...(r.error ? { error: String(r.error) } : {}), result: r };
    trials.push(t);
    if (!runsAt.has(load)) runsAt.set(load, []);
    runsAt.get(load).push(t.pass);
    return t.pass;
  };
  const held = (load) => runsAt.has(load) && runsAt.get(load).every(Boolean);
  const closeEnough = (lo, hi) => hi <= lo * (1 + resolution) + 1e-9 || (step > 0 && hi - lo <= step + 1e-9);
  const up = (x) => snap(Math.max(x * growth, x + step));
  const down = (x) => snap(Math.min(x / growth, x - step));

  let lo = null;
  let hi = null;
  let budgetSpent = false;
  /** Shrink from a failed `hi` until a load passes (lo) or min fails too. */
  const bracketDown = async () => {
    while (lo === null && hi > min) {
      const next = down(hi);
      if (next >= hi) break;
      if (await test(next, 'bracket')) lo = next;
      else hi = next;
    }
  };

  try {
    const first = snap(start ?? Math.sqrt(min * max));
    if (await test(first, 'bracket')) {
      lo = first;
      while (hi === null && lo < max) {
        const next = up(lo);
        if (next <= lo) break;
        if (await test(next, 'bracket')) lo = next;
        else hi = next;
      }
    } else {
      hi = first;
      await bracketDown();
    }
    while (lo !== null) {
      while (hi !== null && !closeEnough(lo, hi)) {
        const mid = snap(Math.sqrt(lo * hi));
        if (mid <= lo || mid >= hi) break;
        if (await test(mid, 'bisect')) lo = mid;
        else hi = mid;
      }
      let ok = true;
      for (let n = runsAt.get(lo).length; ok && n < 1 + confirm; n++) ok = await test(lo, 'confirm');
      if (ok) break;
      // The edge failed its retest: it was noise. Resume from the largest load below it that held every run.
      hi = lo;
      lo = null;
      for (const [load] of runsAt) if (load < hi && held(load) && (lo === null || load > lo)) lo = load;
      if (lo === null) await bracketDown();
    }
  } catch (e) {
    if (!(e instanceof TrialBudgetSpent)) throw e;
    budgetSpent = true;
  }

  const capped = lo === null ? 'min' : hi === null && lo >= max ? 'max' : null;
  return {
    capacity: lo,
    failAbove: hi,
    capped,
    confirmed: lo !== null && held(lo) && runsAt.get(lo).length >= 1 + confirm,
    budgetSpent,
    trials,
  };
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The revision a tree runs: its HEAD, and whether it carries uncommitted changes. */
export function treeRevision(root) {
  const sha = git(['rev-parse', 'HEAD'], root);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root) !== '';
  return { sha, dirty };
}

/** YYYYMMDD-HHMMSS, local time. */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Run one scene's search for real: each load is one headed runIntegratedWorkerBenchmark from `root`.
 * @param {object} def a CAPACITY_SCENES entry (or one built from --scene-path)
 * @param {{ root?: string, runDir: string, rule?: object, warmupMs?: number, durationMs?: number, start?: number,
 *   growth?: number, resolution?: number, confirm?: number, maxTrials?: number, log?: (s: string) => void }} opts
 */
export async function measureCapacity(def, opts) {
  const rule = { ...DEFAULT_RULE, ...(opts.rule || {}) };
  const root = opts.root || repoRoot;
  const warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS;
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const log = opts.log || ((s) => console.log(s));
  const t0 = Date.now();
  fs.mkdirSync(opts.runDir, { recursive: true });
  const stamp = () => new Date().toTimeString().slice(0, 8);
  log(`=== ${stamp()} capacity ${def.key}: ${def.knob} in [${fmtLoad(def.min)}, ${fmtLoad(def.max)}], ` +
    `${rule.tail} <= ${rule.budgetMs} ms, >= ${rule.fpsMin} fps; warm-up ${warmupMs} ms, window ${durationMs} ms`);

  const oracle = async (load, { index, purpose }) => {
    const query = sceneQuery(def, load);
    const out = path.join(opts.runDir, `${def.key}-t${String(index).padStart(2, '0')}-${def.knob}${load}.json`);
    log(`--- ${stamp()} ${def.key} run ${index} (${purpose}): ${query}`);
    const res = runIntegratedWithRetry({ path: def.path, exportName: def.exportName }, out, {
      root,
      warmupMs,
      durationMs,
      headed: true,
      detailedStats: false,
      query,
    });
    if (!res.ok) {
      log(`[capacity] ${def.key} ${def.knob}=${fmtLoad(load)}: FAIL (run error: ${res.error})`);
      return { pass: false, error: res.error, judgement: null };
    }
    const j = judgeRun(res.report, rule);
    log(`[capacity] ${def.key} ${def.knob}=${fmtLoad(load)} (${fmtLoad(def.entities(load))} ${def.entitiesNote}): ` +
      describeJudgement(j));
    return { pass: j.pass, judgement: j };
  };

  const s = await searchCapacity({
    min: def.min,
    max: def.max,
    start: opts.start ?? def.start,
    step: def.step,
    growth: opts.growth ?? 2,
    resolution: opts.resolution ?? 0.05,
    confirm: opts.confirm ?? 1,
    maxTrials: opts.maxTrials ?? 16,
    oracle,
  });
  return summarizeSearch(def, s, { rule, warmupMs, durationMs, minutes: (Date.now() - t0) / 60000 });
}

/** The search's outcome as the record nightlyCapacity keeps: capacity, who breaks first, the edge's workers. Pure. */
export function summarizeSearch(def, s, { rule = DEFAULT_RULE, warmupMs = null, durationMs = null, minutes = null } = {}) {
  const at = (load) => s.trials.filter((t) => t.load === load);
  const edgeRuns = s.capacity != null ? at(s.capacity) : [];
  const edge = edgeRuns.length ? edgeRuns[edgeRuns.length - 1].result?.judgement || null : null;
  const failRuns = s.failAbove != null ? at(s.failAbove).filter((t) => !t.pass) : [];
  const failRun = failRuns.length ? failRuns[failRuns.length - 1] : null;
  let limiting = null;
  if (failRun) {
    limiting = failRun.result?.judgement?.limiting || (failRun.error ? { kind: 'error', what: failRun.error.slice(0, 200) } : null);
  }
  // The p95 rule is looser than p99: the largest load where every run passed it, a lower bound of its capacity.
  let p95Held = null;
  const byLoad = new Map();
  for (const t of s.trials) {
    const ok = t.result?.judgement?.passP95 === true;
    byLoad.set(t.load, (byLoad.get(t.load) ?? true) && ok);
  }
  for (const [load, ok] of byLoad) if (ok && (p95Held === null || load > p95Held)) p95Held = load;
  return {
    scene: def.key,
    label: def.label,
    path: def.path,
    exportName: def.exportName,
    knob: def.knob,
    query: def.query || '',
    range: { min: def.min, max: def.max, step: def.step },
    rule: { budgetMs: rule.budgetMs, fpsMin: rule.fpsMin, tail: rule.tail },
    capacity: s.capacity,
    entities: s.capacity != null ? def.entities(s.capacity) : null,
    entitiesNote: def.entitiesNote,
    capped: s.capped,
    confirmed: s.confirmed,
    budgetSpent: s.budgetSpent,
    failAbove: s.failAbove,
    limiting,
    limitingText: s.capped === 'max' ? `none up to the knob's max (${fmtLoad(def.max)})` : describeReason(limiting),
    tightestAtCapacity: edge?.tightest || null,
    p95HeldUpTo: p95Held,
    atCapacity: edge
      ? {
          presentedFps: edge.presentedFps,
          drawnFps: edge.drawnFps,
          critical: edge.critical,
          workers: edge.workers,
          loadKeys: edge.loadKeys,
          runs: edgeRuns.length,
        }
      : null,
    trials: s.trials.map((t) => ({
      load: t.load,
      purpose: t.purpose,
      pass: t.pass,
      passP95: t.result?.judgement?.passP95 ?? null,
      presentedFps: t.result?.judgement?.presentedFps ?? null,
      drawnFps: t.result?.judgement?.drawnFps ?? null,
      worstP99: t.result?.judgement?.critical?.p99Ms ?? null,
      worstP95: t.result?.judgement?.critical?.p95Ms ?? null,
      broke: t.pass ? null : t.result?.judgement?.limiting ? describeReason(t.result.judgement.limiting) : t.error ? `error: ${t.error.slice(0, 200)}` : null,
    })),
    warmupMs,
    durationMs,
    runs: s.trials.length,
    minutes: minutes != null ? Math.round(minutes * 10) / 10 : null,
  };
}

/** The search's outcome for people: the capacity, who breaks, the edge's worker table, every run. */
export function formatCapacity(sum) {
  const lines = [];
  const unit = `${sum.knob}`;
  lines.push(`=== Capacity of ${sum.label} (${sum.scene}): ${sum.rule.tail} <= ${sum.rule.budgetMs} ms on every worker, ` +
    `>= ${sum.rule.fpsMin} fps presented and drawn`);
  if (sum.capacity == null) {
    lines.push(`not even ${unit}=${fmtLoad(sum.range.min)} holds (${sum.limitingText})`);
  } else {
    lines.push(`capacity ${unit}=${fmtLoad(sum.capacity)}: ${fmtLoad(sum.entities)} ${sum.entitiesNote}` +
      (sum.capped === 'max' ? " (the knob's max: the scene holds more than it can ask for)" : '') +
      (sum.confirmed ? `, held in ${sum.atCapacity?.runs ?? 2} runs` : ', NOT confirmed (trial budget spent)'));
    if (sum.failAbove != null) {
      lines.push(`breaks first at ${unit}=${fmtLoad(sum.failAbove)}: ${sum.limitingText}`);
    }
    if (sum.p95HeldUpTo != null && sum.rule.tail !== 'p95') {
      lines.push(`p95 rule held every run up to ${unit}=${fmtLoad(sum.p95HeldUpTo)} (a lower bound: the search followed p99)`);
    }
  }
  const a = sum.atCapacity;
  if (a) {
    lines.push(`at the capacity (its last run): presented ${a.presentedFps} fps, drawn ${a.drawnFps ?? '-'} fps`);
    lines.push('| worker | frames | fps | mean work | p50 | p95 | p99 | longest | frames >= 16 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const w of a.workers) {
      lines.push(`| ${w.id} | ${w.frames} | ${w.fps} | ${w.meanMs} | ${w.p50Ms} | ${w.p95Ms} | ${w.p99Ms} | ${w.maxMs} | ${w.longFrames} |`);
    }
    const c = a.critical;
    lines.push(`critical path (max over workers): mean ${c.meanMs?.ms} (${c.meanMs?.worker}), p95 ${c.p95Ms?.ms} ` +
      `(${c.p95Ms?.worker}), p99 ${c.p99Ms?.ms} (${c.p99Ms?.worker})`);
  }
  lines.push('runs: ' + sum.trials.map((t) => `${fmtLoad(t.load)} ${t.pass ? 'pass' : 'FAIL'}${t.purpose === 'confirm' ? ' (again)' : ''}` +
    (t.broke ? ` [${t.broke}]` : '')).join(', '));
  lines.push(`${sum.runs} runs, ${sum.minutes} min`);
  return lines.join('\n');
}

/** A scene definition from --scene or --scene-path; the range options override the catalog's. */
export function resolveCapacityScene(args) {
  let def;
  if (args['scene-path']) {
    const p = String(args['scene-path']);
    if (!args.knob) throw new Error('--scene-path needs --knob <query key>');
    def = {
      key: String(args['scene-export'] || path.basename(p, '.js')),
      label: String(args['scene-export'] || path.basename(p, '.js')),
      path: p,
      exportName: String(args['scene-export'] || path.basename(p, '.js')),
      knob: String(args.knob),
      min: 1,
      max: MAX_ENTITIES_U32,
      start: undefined,
      step: 0,
      query: '',
      entities: (n) => n,
      entitiesNote: String(args.knob),
    };
  } else {
    const key = String(args.scene || '');
    def = CAPACITY_SCENES[key];
    if (!def) throw new Error(`--scene ${key || '(none)'}: one of ${Object.keys(CAPACITY_SCENES).join(', ')}, or --scene-path`);
    def = { ...def };
  }
  for (const k of ['min', 'max', 'step']) if (args[k] !== undefined) def[k] = Number(args[k]);
  if (typeof args.query === 'string') def.query = args.query.replace(/^\?/, '');
  return def;
}

/** The tree the runs come from: --rev <rev> [--pool <name>] makes a worktree of that revision; else this tree. */
export async function resolveRunRoot(args) {
  if (!args.rev) return { root: repoRoot, ...treeRevision(repoRoot), rev: null, worktree: false };
  const { ensureRevWorktree } = await import('./revWorktree.mjs');
  const wt = ensureRevWorktree(String(args.rev), {
    srcOnly: false,
    workloadCounts: false,
    ...(args.pool ? { pool: String(args.pool) } : { tag: 'capacity' }),
  });
  return { root: wt.root, sha: wt.sha, dirty: false, rev: String(args.rev), worktree: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const d of Object.values(CAPACITY_SCENES)) {
      console.log(`${d.key.padEnd(14)} ${d.knob}=[${fmtLoad(d.min)}..${fmtLoad(d.max)}] start ${fmtLoad(d.start)} ` +
        `${d.query ? `+ ${d.query} ` : ''}| ${d.covers}${REFERENCE_SET.includes(d.key) ? ' (reference)' : ''}`);
    }
    return;
  }
  const def = resolveCapacityScene(args);
  const rule = {
    budgetMs: args['budget-ms'] !== undefined ? Number(args['budget-ms']) : DEFAULT_RULE.budgetMs,
    fpsMin: args['fps-min'] !== undefined ? Number(args['fps-min']) : DEFAULT_RULE.fpsMin,
    tail: args.tail === 'p95' ? 'p95' : 'p99',
  };
  const tree = await resolveRunRoot(args);
  const runDir = path.join(repoRoot, 'tests', 'results', 'capacity-runs', `${localStamp()}-${def.key}`);
  console.log(`capacity: runs from ${tree.root} at ${tree.sha.slice(0, 10)}${tree.dirty ? ' (uncommitted changes)' : ''}`);
  const sum = await measureCapacity(def, {
    root: tree.root,
    runDir,
    rule,
    warmupMs: args['warmup-ms'] !== undefined ? Number(args['warmup-ms']) : undefined,
    durationMs: args['duration-ms'] !== undefined ? Number(args['duration-ms']) : undefined,
    start: args.start !== undefined ? Number(args.start) : undefined,
    growth: args.growth !== undefined ? Number(args.growth) : undefined,
    resolution: args.resolution !== undefined ? Number(args.resolution) : undefined,
    confirm: args.confirm !== undefined ? Number(args.confirm) : undefined,
    maxTrials: args['max-trials'] !== undefined ? Number(args['max-trials']) : undefined,
  });
  const record = { date: new Date().toISOString(), sha: tree.sha, dirty: tree.dirty, rev: tree.rev, ...sum };
  const out = args.json ? path.resolve(String(args.json)) : path.join(runDir, `${def.key}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  console.log(formatCapacity(sum));
  console.log(`capacity record: ${out}`);
}

if (isCli(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
