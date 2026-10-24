#!/usr/bin/env node
/**
 * Product gate for one hypothesis: Predator headed, A B A B …, A = baseline
 * worktree (working tree with the hypothesis files swapped back), B = working
 * tree. Every worker kind is watched, not only the one the change touched.
 *
 *   node tests/bench/runPredatorAbab.mjs --name L1 \
 *     --override src/workers/logicWorker.js=tests/results/hyp-baselines/L1.logicWorker.js
 *   node tests/bench/runPredatorAbab.mjs --name X1 --override ... --pairs 4 --owner pixi
 *   node tests/bench/runPredatorAbab.mjs --name branch-vs-main --vs main --pairs 8
 *   node tests/bench/runPredatorAbab.mjs --name X2 --vs 1cbc02b1 --hyp-rev HEAD --owner preRender
 *
 * --owner <LOAD_KEY> (FLOWFIELDS_COMPUTED, say): the claim is a throughput, higher is better, as with
 * `--owner presented`: KEPT when it rises ≥ 3 % in ≥ 75 % of the pairs, REGRESSION when it falls as much; it
 * is the claim, so it is left out of the load-drift check (a deadline-bound worker's STEP_MS cannot fall).
 *
 * --hyp-rev <rev>: B is src/ from that revision in a worktree of its own, not the working tree, so
 * edits in the main folder while the sitting runs (another session's, an agent's) cannot reach it;
 * `--vs X --hyp-rev X` is an A/A of two directories.
 *
 * --query-a <q>, --query-b <q>: scene parameters for one side only, on top of --query (a key the side names
 * replaces the shared one). Without --hyp-rev, both sides then run the --vs worktree: one build, one
 * directory, the runtime switch the only difference (`--vs HEAD --query-a wasmOff=gpuPack` times the pack's
 * JavaScript path against its kernel).
 *
 * Verdict per kind: median of the paired deltas (B−A)/A. REGRESSION if any
 * kind is ≥ +3 % and its cv is ≤ 10 % (or it is the owner kind), if the frames
 * the page presents (main-thread FPS) drop ≥ 3 % in ≥ 75 % of the pairs, or a
 * load key drifts more than 5 %. KEPT (product) if the owner kind is ≤ −3 %, or
 * with `--owner presented` if the presented frames rise ≥ 3 %.
 * Otherwise NEUTRAL: with a kernel win that is `kept (kernel, product-neutral)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { DEFAULT_DURATION_MS, DEFAULT_WARMUP_MS } from './benchmarkDefaults.mjs';
import { median, pctDelta, writeJson } from './featureTournamentLib.mjs';
import { cv, repoRoot, runIntegratedWithRetry } from './measureLib.mjs';
import { isCli, parseArgs } from './microbenchHelpers.mjs';
import { ensureOverlayWorktree, ensureRevWorktree } from './revWorktree.mjs';

export const PREDATOR_SCENE = {
  key: 'predator',
  path: '/demos/predatorScene/predatorScene.js',
  exportName: 'PredatorScene',
  headed: true,
  kind: 'gameplay',
};

/**
 * The gate was written for Predator only, and that was fine while every
 * hypothesis was about Predator. H-14 is not: its home is `spawnStormScene`,
 * because `spawnStorm` is the row that actually exercises the spawn list and
 * Predator barely spawns. Hardcoding one scene would have meant either measuring
 * H-14 in the wrong scene or writing a second, worse sitting harness.
 *
 * So the scene is a flag now. The gate, the decision rule and the counterbalanced
 * ordering are unchanged - only the scene moves.
 */
/**
 * The population the scene was asked to run.
 *
 * Read from BOTH `--query` and any query left on the scene path. With `--query`
 * - which is the form that actually works, see F-07 - the parameters live in
 * `args.query` and `scene.path` is bare, so reading the path alone would report
 * 0 and silently degrade every probe to presence-only. That is the same class of
 * bug as the original one: a check that cannot fail is worse than no check.
 */
function expectedPopulation(scene, args) {
  const sources = [];
  if (args && typeof args.query === 'string' && args.query) sources.push(args.query);
  const p = scene?.path || '';
  if (p.includes('?')) sources.push(p.slice(p.indexOf('?')));
  for (const src of sources) {
    const params = new URLSearchParams(src);
    for (const key of ['sprites', 'decorations', 'entities']) {
      const raw = params.get(key);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

function resolveScene(args) {
  const scenePath = args.scene ? String(args.scene) : null;
  const exportName = args['scene-export']
    ? String(args['scene-export'])
    : scenePath
      ? String(scenePath).split('/').pop().replace(/\.js$/, '')
      : null;

  if (!scenePath && !args['scene-export']) return PREDATOR_SCENE;

  const key = String(scenePath || exportName).replace(/[^a-z0-9]+/gi, '-');
  return {
    key,
    path: scenePath ?? `/tests/bench/stressScenes/${exportName}.js`,
    exportName: exportName ?? key,
    // Stress scenes are catalogued `kind: 'stress'`, which is what puts the 3 ms
    // floor and the 8 ms campaign floor on any STEP_MS verdict.
    headed: true,
    kind: 'stress',
    explicit: true,
  };
}

import { checkProbe } from './hypothesisProbes.mjs';
// The denominator floor. Sourced from the harness rather than re-declared here,
// so the number in HOW_WE_MEASURE.md and the number in the gate cannot drift
// apart. This import was missing when the floor was first added - and nothing
// noticed, because the probe refusal path returns before decideAbab runs, so the
// broken branch had never been executed by a real sitting.
import { STEP_MS_FLOOR } from './benchmarkDefaults.mjs';

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];
const LOAD_KEYS = [
  'BODY_COUNT',
  'GPU_CASTERS',
  'GPU_SHADOW_LIGHTS',
  'ACTIVE_PARTICLES',
  // F-06. The probe keys. Without these the gate cannot tell whether a
  // hypothesis's own code path ran, and `spritePackStressScene` demonstrated
  // why that matters: it produced VISIBLE_ENTITIES of 734 and then 11 139 -
  // non-zero, plausible, and both wrong - while STEP_MS looked healthy.
  //
  // A probe that needs a key the gate never collected would silently never fire,
  // which is worse than having no probe at all.
  'VISIBLE_ENTITIES',
  'ENTITIES_PROCESSED',
  // The key the particle worker actually publishes. DECORATIONS_ACTIVE, written
  // from the sound of it, matched nothing and stayed listed beside this one
  // until review D3, looking gated and never gating.
  'ACTIVE_DECORATIONS',
  'DECAL_TILES_DIRTY',
  // ACTIVE_AUDIO_SLOTS was listed here too, but audio slots live in
  // SoundManager's metrics, which the bench report does not carry (review D3).
  // An audio hypothesis has to collect them before it can gate on them.
  // F-07 / the two-pack-sites finding. packSpriteLayer runs in preRender, and
  // RENDER_QUEUE_SIZE is what actually feeds it - measured equal to
  // VISIBLE_ENTITIES on spritePackStressScene but equal by coincidence, not by
  // contract. Probing the upstream key would break the day they diverge.
  'RENDER_QUEUE_SIZE',
  // E-37. Nav load. A nav hypothesis (E-11/E-12/E-14) changes only what the particle
  // worker does with flowfields; without these keys the gate cannot tell "my code ran"
  // from "the cache was warm and nothing happened", which is the same blind spot
  // VISIBLE_ENTITIES was added for.
  'FLOWFIELDS_COMPUTED',
  'FLOWFIELDS_SERVICED',
  'PATHS_COMPUTED',
];

/**
 * Per-worker sub-timers, extracted as `<kind>_<KEY>`.
 *
 * These are what a hypothesis's `metric` is resolved against. STEP_MS sums
 * collect + emit + sort + pack, and EMIT_MS is bimodal (a full emit or a
 * pose-only persistence shortcut, ~1.3 ms apart on an 8 ms base). At 4 pairs a
 * single unrelated bimodal term can decide a verdict on its own - which is how
 * H-02 came back REGRESSION while the sub-timer holding its change had moved
 * +3.3 % in 2 of 4 pairs.
 */
const SUB_TIMERS = [
  'COLLECT_MS',
  'EMIT_MS',
  'SPRITE_PACK_MS',
  // E-29. Sub-timers of the critical path, added once the phases had timers to
  // report. STAMP_LIGHTS_MS is contained in SHADOW_Q_MS - naming it as a metric is
  // fine, reading the two as additive is not.
  'STAMP_LIGHTS_MS',
  'VISIBLE_LIGHTS_MS',
  'SORT_MS',
  'SHADOW_Q_MS',
  'CUSTOM_LAYER_MS',
  'VISIBILITY_MS',
  'SPRITES_MS',
  'QUEUE_MS',
  'PRESENT_MS',
  'LIGHTS_MS',
  'SHADOWS_MS',
];
// Predator emits ~100 particles. DECAL_TILES_DIRTY sits near one tile. A 5%
// band on a count of ~1 is one tile of rounding. Mute only when BOTH medians
// are under the floor. One side at or above the floor is a normal 5% check,
// so 100 particles versus 5000 still fails.
// The nav keys (E-37) likewise: Predator computes a flow field about once per window, so in the
// E-78 sitting (2026-10-22) one flow field in one baseline run of twelve (0.03 a frame, median 0
// on both sides) read as a 245 % cv and failed a pair the change could not reach. A nav
// hypothesis runs NavStress, far above one a frame, where the band and the cv apply.
/**
 * Presented frames: the main thread's rAF rate, which runs at the rate the compositor
 * produces frames. E-82 is why it is judged: Pixi's step fell 76 % while the page
 * went from 55 to 44 frames a second, because a GPU-bound scene then got more frames
 * submitted than it could finish. No worker's STEP_MS shows that.
 */
const PRESENTED_KEY = 'MAIN_FPS';

const LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000, DECAL_TILES_DIRTY: 8, FLOWFIELDS_COMPUTED: 1, FLOWFIELDS_SERVICED: 1, PATHS_COMPUTED: 1 };
/**
 * A throughput owner's family: the keys that move with it when it does, muted from the load-drift check with
 * it. The serviced flowfields are the computed ones plus the cache hits (E-37): with every request a miss, as
 * in navStress, they are the same count.
 */
const THROUGHPUT_FAMILY = { FLOWFIELDS_COMPUTED: ['FLOWFIELDS_SERVICED'] };

// HOW_WE_MEASURE: a load key outside 5% fails the pair. A coefficient of
// variation at or above 50% fails the pair. The band does not widen with cv.
const LOAD_GATE_BAND_PCT = 5;
const LOAD_CV_FAIL = 0.5;

/**
 * A worker's primary over the window from its running totals (src/util/frameTotals.js): STEP_MS minus WAIT_MS,
 * plus QUERY_WAKE_MS on physics (sync queries answered between steps), HOW_WE_MEASURE "What counts as faster".
 */
function exactPrimary(kind, exact) {
  return exact.workMs + (kind === 'physics' ? exact.extraMs : 0);
}

/**
 * Max STEP_MS per worker kind plus the load keys.
 *
 * `<kind>_STEP_MS_EXACT` is the primary over every frame of the window, when every worker of that kind kept
 * running totals; `<kind>_STEP_MS_SAMPLED` is the mean of the 100 ms samples of STEP_MS, one frame in six.
 * `<kind>_STEP_MS` is the exact one when there is one. decideAbab reads exact only when every pair has it on
 * both sides (a baseline revision older than the totals has none).
 */
export function predatorMetrics(report) {
  const out = {};
  for (const kind of KINDS) {
    out[`${kind}_STEP_MS`] = 0;
    out[`${kind}_STEP_MS_SAMPLED`] = 0;
  }
  const exactWorst = {};
  const exactMissing = new Set();
  for (const w of report.workers || []) {
    const kind = w.type === 'pixi' ? 'renderer' : w.type;
    if (!KINDS.includes(kind)) continue;
    if (!w.exact) {
      exactMissing.add(kind);
      continue;
    }
    const primary = exactPrimary(kind, w.exact);
    if (!exactWorst[kind] || primary > exactWorst[kind].primary) exactWorst[kind] = { primary, exact: w.exact };
  }
  for (const [kind, worst] of Object.entries(exactWorst)) {
    if (exactMissing.has(kind)) continue;
    out[`${kind}_STEP_MS_EXACT`] = worst.primary;
    out[`${kind}_P95_MS`] = worst.exact.p95Ms;
    out[`${kind}_FRAMES`] = worst.exact.frames;
  }
  // Generic, not a hand-listed if-chain.
  //
  // The hand-listed version was a landmine: I added ACTIVE_DECORATIONS,
  // RENDER_QUEUE_SIZE and the other probe keys to LOAD_KEYS but not to the
  // extractor, so they read as undefined, became 0 through `?? 0`, and the H-10
  // probe refused the verdict with "ACTIVE_DECORATIONS is 0" - on a run whose own
  // output said `Scene parameters in effect: decorations=65000` and
  // `particle: STEP_MS 1.362`. The refusal machinery worked; the data feeding it
  // did not exist.
  //
  // Extracting every LOAD_KEYS entry from the worker's own average means a key
  // added to the list is collected on the next run, with no second edit to
  // forget. Keys the worker does not publish stay absent rather than becoming a
  // confident zero.
  const published = {};
  for (const w of report.workers || []) {
    const avg = w.statsSamplesAverage || {};
    const kind = w.type === 'pixi' ? 'renderer' : w.type;
    const key = `${kind}_STEP_MS_SAMPLED`;
    if (key in out && (avg.STEP_MS ?? 0) > out[key]) out[key] = avg.STEP_MS;
    for (const lk of LOAD_KEYS) {
      if (lk in avg) published[lk] = Math.max(published[lk] ?? 0, avg[lk]);
    }
  }
  for (const lk of LOAD_KEYS) if (lk in published) out[lk] = published[lk];
  for (const kind of KINDS) {
    const exact = out[`${kind}_STEP_MS_EXACT`];
    out[`${kind}_STEP_MS`] = Number.isFinite(exact) ? exact : out[`${kind}_STEP_MS_SAMPLED`];
  }
  // Presented frames: the main thread's frames over the window's length when counted, else the sampled mean.
  const mainFps = report.mainThread?.averageFPS;
  const mainFpsExact = report.mainThread?.exactFPS;
  if (Number.isFinite(mainFps)) out[`${PRESENTED_KEY}_SAMPLED`] = mainFps;
  if (Number.isFinite(mainFpsExact)) out[`${PRESENTED_KEY}_EXACT`] = mainFpsExact;
  if (Number.isFinite(mainFpsExact)) out[PRESENTED_KEY] = mainFpsExact;
  else if (Number.isFinite(mainFps)) out[PRESENTED_KEY] = mainFps;

  // Sub-timers, namespaced by worker kind so two workers can publish the same
  // one without colliding (`preRender_EMIT_MS` is not `renderer_EMIT_MS`).
  for (const w of report.workers || []) {
    const avg = w.statsSamplesAverage || {};
    const kind = w.type === 'pixi' ? 'renderer' : w.type;
    for (const t of SUB_TIMERS) {
      if (t in avg) out[`${kind}_${t}`] = avg[t];
    }
  }
  return out;
}

/** `--query` with one side's parameters on top: a key the side names replaces the shared one. */
export function sideQuery(shared, side) {
  const base = String(shared || '').replace(/^\?/, '');
  if (!side) return base;
  const out = new URLSearchParams(base);
  for (const [k, v] of new URLSearchParams(String(side).replace(/^\?/, ''))) out.set(k, v);
  // Lists stay readable (wasmOff=a,b); the page's URLSearchParams reads either form.
  return out.toString().replace(/%2C/gi, ',');
}

function parseOverrides(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = {};
  for (const item of list) {
    const eq = String(item).indexOf('=');
    if (eq < 0) throw new Error(`--override expects rel=path, got ${item}`);
    out[item.slice(0, eq)] = path.resolve(item.slice(eq + 1));
  }
  return out;
}

// Review M9. What a sitting's pairs were measured with. --append pools new
// pairs with old ones, which is only a median of one measurement when the
// metric set, scene, protocol, baseline and both trees are the same.
function sittingStamp(scene, opts, args, baseline, hypSide = null) {
  const git = (argv, encoding) => execFileSync('git', argv, { cwd: repoRoot, encoding, maxBuffer: 1 << 28 });
  return {
    schema: { kinds: KINDS, loadKeys: LOAD_KEYS, subTimers: SUB_TIMERS, presented: PRESENTED_KEY, primary: 'exact-or-sampled' },
    scene: { path: scene.path, exportName: scene.exportName },
    protocol: {
      headed: opts.headed,
      detailedStats: opts.detailedStats,
      warmupMs: opts.warmupMs,
      durationMs: opts.durationMs,
      query: opts.query,
      queryA: opts.queryA,
      queryB: opts.queryB,
      extraArgs: opts.extraArgs,
    },
    vs: args.vs ? { rev: String(args.vs), sha: baseline.sha } : null,
    hypRev: hypSide ? { rev: hypSide.rev, sha: hypSide.sha } : null,
    overrides: baseline.overrides ?? null,
    // B is the working tree, and A is built from its HEAD: both change with these.
    tree: {
      head: git(['rev-parse', 'HEAD'], 'utf8').trim(),
      diff: createHash('sha1').update(git(['diff', 'HEAD', '--binary'], 'buffer')).digest('hex'),
    },
  };
}

/**
 * Recompute a written sitting's verdict from its own recorded inputs: the
 * top-level owner and the probe's metric, as the runner writes them. One
 * function for --decide-only and readjudicateAbab, which used to read
 * protocol.owner / protocol.metric, fields nothing writes (review M9).
 */
export function redecide(summary, owner = null) {
  return decideAbab(
    summary.pairs,
    owner ?? summary.owner ?? summary.decision?.owner ?? null,
    summary.probe?.metric ?? summary.decision?.metric ?? null,
  );
}

/** The stamp fields where an earlier sitting differs; empty when its pairs may be pooled. */
export function appendMismatches(prev, stamp) {
  if (!prev || !prev.stamp) return ['stamp (the earlier sitting was written before --append checked one)'];
  const out = [];
  for (const k of Object.keys(stamp)) {
    if (JSON.stringify(prev.stamp[k] ?? null) !== JSON.stringify(stamp[k] ?? null)) out.push(k);
  }
  return out;
}

/**
 * Which of a pair's keys a sitting reads: `<base>_EXACT` when every side of every pair has it, else
 * `<base>_SAMPLED` when every side has that, else `<base>` (sittings written before the totals).
 */
export function sittingKey(pairs, base) {
  const all = (key) => pairs.length > 0 && pairs.every((p) => Number.isFinite(p.A?.[key]) && Number.isFinite(p.B?.[key]));
  if (all(`${base}_EXACT`)) return { key: `${base}_EXACT`, source: 'exact' };
  if (all(`${base}_SAMPLED`)) return { key: `${base}_SAMPLED`, source: 'sampled' };
  return { key: base, source: 'sampled' };
}

export function decideAbab(pairs, owner, metric = null) {
  const kinds = {};
  for (const kind of KINDS) {
    const { key, source } = sittingKey(pairs, `${kind}_STEP_MS`);
    const a = pairs.map((p) => p.A[key]);
    const b = pairs.map((p) => p.B[key]);
    const deltas = pairs.map((p) => pctDelta(p.B[key], p.A[key])).filter(Number.isFinite);
    const baseMedian = median(a);
    const pairedDeltaPct = median(deltas);
    // Denominator floor, from `docs/HOW_WE_MEASURE.md` line 79: "Below that,
    // 3 percent is timer noise: 3 percent of 0.3 ms is 9 us."
    //
    // This exists because of a real bad verdict, not a hypothetical one. The
    // H-14 sitting reported `spatial` at -21.0% on a baseMedian of 0.238 ms and
    // it read as a candidate win. But 21% of 0.238 ms is 0.05 ms: that worker
    // does 1.4% of a frame's worth of work, and the "win" is noise being
    // dressed as a result. A percentage on a sub-millisecond base has no
    // interpretation regardless of how many pairs agree.
    //
    // Below the floor a kind is still reported - the numbers are real and hiding
    // them would be worse - but it is `interpretable: false`, so it can neither
    // be counted as a regression nor earn a KEPT verdict. The owner is held to
    // the same rule: an idle owner cannot be shown to have been improved.
    const interpretable = baseMedian >= STEP_MS_FLOOR;
    kinds[kind] = {
      source,
      key,
      baseMedian,
      hypMedian: median(b),
      pairedDeltaPct,
      deltas,
      worseFraction: deltas.length ? deltas.filter((d) => d > 0).length / deltas.length : 0,
      cvBase: cv(a),
      cvHyp: cv(b),
      interpretable,
      belowFloorPct: interpretable ? null : ((baseMedian / STEP_MS_FLOOR) * 100).toFixed(1),
      againstOthers: null,
    };
  }
  // Each judged kind against the median of the other judged kinds in the same pair (HOW_WE_MEASURE's drift
  // rule, read per pair). The session's A/A of 2026-10-24 swung every worker 5–15 % together from run to run;
  // this reading cancels what a whole run shares. Reported beside the verdict, which it does not change. The
  // owner is left out of every other kind's reference: its own move is the change's, not the run's.
  const judged = KINDS.filter((k) => kinds[k].interpretable);
  for (const kind of judged) {
    const others = judged.filter((k) => k !== kind && k !== owner);
    if (others.length < 2) continue;
    const rel = [];
    for (const p of pairs) {
      const own = pctDelta(p.B[kinds[kind].key], p.A[kinds[kind].key]);
      const od = others.map((k) => pctDelta(p.B[kinds[k].key], p.A[kinds[k].key])).filter(Number.isFinite);
      if (Number.isFinite(own) && od.length >= 2) rel.push(own - median(od));
    }
    if (rel.length) {
      kinds[kind].againstOthers = {
        deltas: rel,
        medianPct: median(rel),
        lowerFraction: rel.filter((d) => d < 0).length / rel.length,
      };
    }
  }
  const load = {};
  const reasons = [];
  const muted = [];
  for (const key of LOAD_KEYS) {
    const av = [];
    const bv = [];
    for (const p of pairs) {
      if (p.A && Object.prototype.hasOwnProperty.call(p.A, key) && Number.isFinite(p.A[key])) av.push(p.A[key]);
      if (p.B && Object.prototype.hasOwnProperty.call(p.B, key) && Number.isFinite(p.B[key])) bv.push(p.B[key]);
    }
    if (av.length === 0 && bv.length === 0) continue;
    const a = av.length ? median(av) : null;
    const b = bv.length ? median(bv) : null;
    const cvA = av.length ? cv(av) : 0;
    const cvB = bv.length ? cv(bv) : 0;
    const noise = Math.max(Number.isFinite(cvA) ? cvA : 0, Number.isFinite(cvB) ? cvB : 0);
    const floor = LOAD_GATE_MIN[key] ?? 0;
    const bothPresent = av.length === pairs.length && bv.length === pairs.length;
    const belowFloor = bothPresent && a < floor && b < floor;
    const entry = {
      base: a,
      hyp: b,
      deltaPct: a > 0 ? pctDelta(b, a) : null,
      cvBase: Number.isFinite(cvA) ? cvA : 0,
      cvHyp: Number.isFinite(cvB) ? cvB : 0,
      noisePct: noise * 100,
      bandPct: LOAD_GATE_BAND_PCT,
      belowFloor,
      gated: !belowFloor,
      mutedBy: belowFloor ? 'floor' : null,
    };
    load[key] = entry;
    if (belowFloor) continue;
    // The owner's own key is the claim, not the load (see --owner <LOAD_KEY>), and so are the keys that move with it.
    if (key === owner || (THROUGHPUT_FAMILY[owner] || []).includes(key)) {
      entry.gated = false;
      entry.mutedBy = key === owner ? 'owner' : 'owner family';
      continue;
    }
    if (!bothPresent) {
      reasons.push(`load ${key} missing`);
      continue;
    }
    if (noise >= LOAD_CV_FAIL) reasons.push(`load ${key} cv ${(noise * 100).toFixed(1)}%`);
    if (a === 0 && b !== 0) reasons.push(`load ${key} 0 -> ${b}`);
    else if (entry.deltaPct != null && Math.abs(entry.deltaPct) > LOAD_GATE_BAND_PCT) {
      reasons.push(`load ${key} ${entry.deltaPct.toFixed(1)}%`);
    }
  }
  // A paired median of +3 % from 8 scattered pairs is not a regression by
  // itself: it also has to be consistent (≥ 75 % of the pairs worse).
  const CONSISTENT = 0.75;
  const regress = [];
  const noisy = [];
  const belowFloor = [];
  for (const [kind, k] of Object.entries(kinds)) {
    // The floor is checked before the delta, not after it.
    //
    // `docs/HOW_WE_MEASURE.md:79` is explicit: below the floor "the pair FAILS.
    // Do not keep, drop, or tie on the delta." A kind under the floor is reported
    // and excluded, whatever its percentage says. The H-14 sitting is the reason:
    // `spatial` at -21.0 % on a 0.238 ms base read as a candidate win, and 21 %
    // of 0.238 ms is 0.05 ms of work in a 16.7 ms frame - noise with a sign.
    if (!k.interpretable) {
      belowFloor.push(
        `${kind} ${k.baseMedian.toFixed(3)} ms base, below the ${STEP_MS_FLOOR} ms floor - reported, not judged`,
      );
      continue;
    }
    if (!(k.pairedDeltaPct >= 3)) continue;
    const quiet = Math.max(k.cvBase, k.cvHyp) <= 0.1;
    const consistent = k.worseFraction >= CONSISTENT;
    const tag = `${kind} +${k.pairedDeltaPct.toFixed(1)}% (${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length} pairs worse, cv ${(Math.max(k.cvBase, k.cvHyp) * 100).toFixed(0)}%)`;
    if (consistent && (quiet || kind === owner)) regress.push(tag);
    else noisy.push(`${tag}, not blocking`);
  }
  // Higher is better here. Judged only when every pair has it (sittings written
  // before it was collected are re-decided without it).
  let presented = null;
  const presentedKey = sittingKey(pairs, PRESENTED_KEY);
  const fa = pairs.map((p) => p.A?.[presentedKey.key]).filter(Number.isFinite);
  const fb = pairs.map((p) => p.B?.[presentedKey.key]).filter(Number.isFinite);
  if (pairs.length && fa.length === pairs.length && fb.length === pairs.length) {
    const deltas = pairs.map((p) => pctDelta(p.B[presentedKey.key], p.A[presentedKey.key]));
    presented = {
      source: presentedKey.source,
      baseMedian: median(fa),
      hypMedian: median(fb),
      pairedDeltaPct: median(deltas),
      deltas,
      lowerFraction: deltas.filter((d) => d < 0).length / deltas.length,
      higherFraction: deltas.filter((d) => d > 0).length / deltas.length,
      cvBase: cv(fa),
      cvHyp: cv(fb),
    };
    if (presented.pairedDeltaPct <= -3 && presented.lowerFraction >= CONSISTENT) {
      regress.push(
        `presented frames ${presented.pairedDeltaPct.toFixed(1)}% (${Math.round(presented.lowerFraction * deltas.length)}/${deltas.length} pairs fewer)`,
      );
    }
  }
  // --owner <LOAD_KEY>: a throughput, judged like the presented frames (higher is better).
  let throughput = null;
  if (owner && LOAD_KEYS.includes(owner) && load[owner] && !load[owner].belowFloor) {
    const deltas = pairs.map((p) => pctDelta(p.B[owner], p.A[owner])).filter(Number.isFinite);
    if (deltas.length === pairs.length && pairs.length > 0) {
      throughput = {
        key: owner,
        baseMedian: load[owner].base,
        hypMedian: load[owner].hyp,
        pairedDeltaPct: median(deltas),
        deltas,
        higherFraction: deltas.filter((d) => d > 0).length / deltas.length,
        lowerFraction: deltas.filter((d) => d < 0).length / deltas.length,
      };
      if (throughput.pairedDeltaPct <= -3 && throughput.lowerFraction >= CONSISTENT) {
        regress.push(`${owner} ${throughput.pairedDeltaPct.toFixed(1)}% (${Math.round(throughput.lowerFraction * deltas.length)}/${deltas.length} pairs lower)`);
      }
    }
  }
  let verdict = 'NEUTRAL';
  const o = owner && owner !== 'presented' ? kinds[owner] : null;
  // An owner below the floor cannot earn a KEPT verdict. It is not that the
  // improvement is unmeasured - it is that the protocol forbids judging it, so
  // the honest verdict is NEUTRAL-with-reasons rather than a keep.
  const ownerJudged = o && o.interpretable;
  if (reasons.length) verdict = 'FAIL (load)';
  else if (!ownerJudged && o) verdict = 'NEUTRAL (below floor)';
  else if (regress.length) verdict = 'REGRESSION';
  else if (ownerJudged && o.pairedDeltaPct <= -3 && 1 - o.worseFraction >= CONSISTENT) {
    verdict = 'KEPT (product)';
  } else if (owner === 'presented' && presented && presented.pairedDeltaPct >= 3
    && presented.higherFraction >= CONSISTENT) {
    verdict = 'KEPT (product)';
  } else if (throughput && throughput.pairedDeltaPct >= 3 && throughput.higherFraction >= CONSISTENT) {
    verdict = 'KEPT (product)';
  }

  // The attributed verdict, on the sub-timer the change actually lives in.
  //
  // Reported alongside, never instead of: STEP_MS stays the protocol's primary
  // and the only thing that can say REGRESSION. This answers a different
  // question - "did the loop I touched move?" - and the two disagreeing is
  // itself the finding, as H-02's did.
  let attributed = null;
  if (metric && owner) {
    const mk = `${owner}_${metric}`;
    const a = pairs.map((p) => p.A[mk]).filter(Number.isFinite);
    const b = pairs.map((p) => p.B[mk]).filter(Number.isFinite);
    if (a.length && b.length) {
      const paired = pairs
        .map((p) => pctDelta(p.B[mk], p.A[mk]))
        .filter(Number.isFinite);
      const base = median(a);
      attributed = {
        key: mk,
        baseMedian: base,
        hypMedian: median(b),
        pairedDeltaPct: median(paired),
        worseFraction: paired.length
          ? paired.filter((d) => d > 0).length / paired.length
          : 0,
        cvBase: cv(a),
        cvHyp: cv(b),
        interpretable: base >= STEP_MS_FLOOR,
        belowFloorPct: base >= STEP_MS_FLOOR ? null : ((base / STEP_MS_FLOOR) * 100).toFixed(1),
      };
    }
  }

  return { verdict, owner, ownerJudged, metric, attributed, kinds, presented, throughput, load, reasons, muted, regress, noisy, belowFloor };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawOverrides = process.argv.flatMap((a, i, all) => (a === '--override' && all[i + 1] ? [all[i + 1]] : []));
  const name = String(args.name || 'hyp');
  const owner = args.owner ? String(args.owner) : null;
  const nPairs = Number(args.pairs ?? 4);
  const opts = {
    headed: true,
    // Detailed stats are required whenever a hypothesis probe is in play.
    //
    // `preRenderWorker.reportFPS` ends with `if (!this.collectDetailedStats) return;`
    // before publishing COLLECT_MS, EMIT_MS and SPRITE_PACK_MS (RENDER_QUEUE_SIZE
    // was behind it too until review M1; it is published every frame now).
    // The gate used to pass `--no-collect-detailed-stats` unconditionally, which
    // made every preRender-keyed probe read a permanent zero and made the whole
    // depth breakdown disappear.
    //
    // The H-19 sitting refused with `RENDER_QUEUE_SIZE is 0` on a run whose own
    // `preRender: STEP_MS 6.375` matched a direct run of the same configuration
    // (6.863). The work was happening; the reporting was not. That is the harness
    // defeating its own check - and it would have produced a confident verdict
    // about an empty queue.
    //
    // H-10 escaped this only by luck: ACTIVE_DECORATIONS is published ABOVE the
    // gate in particleWorker, so it survived. One worker's layout, not a rule.
    detailedStats: Boolean(args.hyp),
    warmupMs: Number(args['warmup-ms'] ?? DEFAULT_WARMUP_MS),
    durationMs: Number(args['duration-ms'] ?? DEFAULT_DURATION_MS),
    query: typeof args.query === 'string' ? args.query : '',
    // The query each side runs with (--query plus --query-a or --query-b).
    queryA: sideQuery(typeof args.query === 'string' ? args.query : '', typeof args['query-a'] === 'string' ? args['query-a'] : ''),
    queryB: sideQuery(typeof args.query === 'string' ? args.query : '', typeof args['query-b'] === 'string' ? args['query-b'] : ''),
    // Canvas size, forwarded as extra args rather than as new options.
    //
    // `runIntegratedOnce` already accepts `extraArgs` and forwards them verbatim,
    // and `tests/bench/measureLib.mjs` is off-limits (it carries the Spanish
    // translation work), so the capability is added where it costs nothing
    // instead of in the shared library.
    //
    // This is not a convenience. The H-19 sitting ran at the 1920x1080 default
    // and the scene queued NOTHING - `RENDER_QUEUE_SIZE 0`, every sub-timer 0.000 -
    // while `preRender STEP_MS` still read 6.4-8.1 ms. At 3840x2160 the same
    // configuration queues 45 568. Without this flag the gate can only ever sit
    // against vehicles that happen to work at the default size, and a scene that
    // silently measures an empty queue is exactly what the probe is there to catch.
    extraArgs: [
      ...(args['canvas-width'] ? ['--canvas-width', String(Number(args['canvas-width']))] : []),
      ...(args['canvas-height'] ? ['--canvas-height', String(Number(args['canvas-height']))] : []),
      // The camera zoom the runner sets (min, or a number): adobeAnimateScene draws all 10 000
      // characters only at the minimum zoom, and saturates pre-render there.
      ...(args['camera-zoom'] ? ['--camera-zoom', String(args['camera-zoom'])] : []),
      // --browser firefox: both sides in Playwright's Firefox (PLAYWRIGHT_BROWSERS_PATH), not Chrome.
      ...(args.browser ? ['--browser', String(args.browser)] : []),
    ],
  };
  const scene = resolveScene(args);
if (scene.explicit) {
  console.log(
    `scene: ${scene.exportName} (${scene.path}) - kind ${scene.kind}, so the 3 ms sample ` +
      'floor and the 8 ms campaign floor both apply to any STEP_MS verdict',
  );
  // Say so on every run. A reader of the transcript cannot otherwise tell whether
  // a zero sub-timer means "the work did not happen" or "detailed stats were off".
  console.log(
    `detailed stats: ${opts.detailedStats ? 'ON' : 'off'}` +
      (opts.detailedStats
        ? ' (required by --hyp: preRender gates RENDER_QUEUE_SIZE and the sub-timers behind it)'
        : ' (no --hyp, so no probe depends on them)'),
  );
}
const outDir = path.join(repoRoot, 'tests/results/predator-abab', name);
  fs.mkdirSync(outDir, { recursive: true });
  const summaryPath = path.join(outDir, 'summary.json');
  if (args['decide-only']) {
    const prev = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    prev.decision = redecide(prev, owner);
    writeJson(summaryPath, prev);
    printDecision(name, prev.decision);
    return;
  }
  // --vs <rev>: A = src/ from that revision, everything else from the working tree.
  const baseline = args.vs
    ? ensureRevWorktree(String(args.vs))
    : ensureOverlayWorktree(name, parseOverrides(rawOverrides));
  console.log(`baseline worktree ${baseline.root}`);
  // --hyp-rev <rev>: B from its own worktree, apart from the main folder (see the header).
  const hypSide = args['hyp-rev'] ? ensureRevWorktree(String(args['hyp-rev']), { tag: 'b' }) : null;
  // Per-side queries without --hyp-rev: B runs A's worktree, so the two sides are one build.
  const perSide = opts.queryA !== opts.queryB;
  if (perSide && !hypSide && !args.vs) {
    throw new Error('--query-a/--query-b compare one build: pass --vs <rev> (both sides run its worktree), or --hyp-rev too.');
  }
  const hypRoot = hypSide ? hypSide.root : perSide ? baseline.root : repoRoot;
  if (hypSide) console.log(`hypothesis worktree ${hypSide.root}`);
  else if (perSide) console.log('one build: both sides run the baseline worktree');
  if (perSide) console.log(`side A query "${opts.queryA}", side B query "${opts.queryB}"`);
  // --append: add pairs to the previous sitting of the same hypothesis, only when
  // that sitting was measured the same way (review M9).
  const stamp = sittingStamp(scene, opts, args, baseline, hypSide);
  let pairs = [];
  if (args.append && fs.existsSync(summaryPath)) {
    const prev = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const differs = appendMismatches(prev, stamp);
    if (differs.length) {
      throw new Error(
        `--append refused: the earlier sitting differs in ${differs.join(', ')}. ` +
          'Its pairs measured something else; start a new sitting under another name.',
      );
    }
    pairs = prev.pairs;
  }
  const first = pairs.length;
  for (let p = first; p < first + nPairs; p++) {
    const pair = {};
    // Counterbalanced: odd pairs run B first, so drift inside a pair
    // (heat, background) does not always land on the same side.
    const order = p % 2 === 0 ? [['A', baseline.root], ['B', hypRoot]] : [['B', hypRoot], ['A', baseline.root]];
    for (const [side, root] of order) {
      console.log(`\n======== ${name} pair ${p + 1}/${first + nPairs} side ${side} ========`);
      const query = side === 'A' ? opts.queryA : opts.queryB;
      const res = runIntegratedWithRetry(scene, path.join(outDir, `${side}-p${p}.json`), { ...opts, root, query });
      if (!res.ok) throw new Error(`${side} p${p}: ${res.error}`);
      pair[side] = predatorMetrics(res.report);
    }
    pairs.push(pair);
  }
  // F-06. Refuse the verdict when the hypothesis's own probe says its code path did
  // not run, or ran on a self-cancelling subset.
  //
  // This is placed BEFORE decideAbab on purpose. A sitting on a scene that
  // measured nothing produces NEUTRAL with a plausible cv, and that is
  // indistinguishable from a real negative result once it is written down - which
  // is how H-02's sitting came to be reported as "rejected" when it may only have
  // been invalid.
  //
  // `--hyp` names the hypothesis so its probe can be applied. Without it there is
  // nothing to check against and the sitting proceeds, which is the pre-existing
  // behaviour.
  const hyp = args.hyp ? String(args.hyp) : null;
  let probeVerdict = null;
  if (hyp) {
    const sample = pairs[0]?.A ?? {};
    probeVerdict = checkProbe(hyp, sample, expectedPopulation(scene, args));
    if (!probeVerdict.ok) {
      writeJson(summaryPath, {
        name,
        owner,
        hyp,
        protocol: { ...opts, pairs: pairs.length, order: 'AB BA AB BA' },
        pairs,
        probe: probeVerdict,
        decision: {
          verdict: 'INVALID',
          reason: `probe failed: ${probeVerdict.code}`,
          detail: probeVerdict.detail,
        },
      });
      console.error(`\n  REFUSING THE VERDICT - ${probeVerdict.code}`);
      console.error(`  ${probeVerdict.detail}`);
      console.error(
        '\n  This sitting is INVALID, not negative. Log it as "the vehicle is broken",\n' +
          '  not as a result. Fix the scene or the probe, then re-run.',
      );
      printDecision(name, { verdict: 'INVALID', reason: probeVerdict.code, detail: probeVerdict.detail });
      process.exitCode = 2;
      return;
    }
    if (probeVerdict.weak) {
      console.warn(`\n  WEAK PROBE: ${probeVerdict.detail}`);
    } else {
      console.log(`  probe ok: ${probeVerdict.detail}`);
    }
  }

  const decision = decideAbab(pairs, owner, probeVerdict?.metric ?? null);
  const summary = {
    name,
    owner,
    hyp,
    probe: probeVerdict,
    protocol: { ...opts, pairs: pairs.length, order: 'AB BA AB BA', seed: 123456 },
    vs: args.vs ? { rev: String(args.vs), sha: baseline.sha } : null,
    hypRev: hypSide ? { rev: hypSide.rev, sha: hypSide.sha } : null,
    overrides: baseline.overrides ?? null,
    stamp,
    pairs,
    decision,
  };
  writeJson(summaryPath, summary);
  printDecision(name, decision);
}

function printDecision(name, decision) {
  console.log(`\n======== ${name}: ${decision.verdict} ========`);
  // A refusal carries no `kinds`: the whole point is that there is nothing to
  // tabulate. Iterating it unconditionally threw a TypeError *after* the
  // refusal had already been printed and the summary written, so the run ended
  // in a stack trace instead of a verdict. A guard that crashes on its own
  // failure path is a guard that trains you to distrust it.
  if (!decision.kinds) {
    if (decision.reason) console.log(`  reason: ${decision.reason}`);
    if (decision.detail) console.log(`  ${decision.detail}`);
    return;
  }
  for (const [kind, k] of Object.entries(decision.kinds)) {
    // A percentage on a base under the 3 ms floor is the H-14 spatial "-21%":
    // the milliseconds are real, the percent is not a result. Print the times
    // and withhold the percent.
    if (!k.interpretable) {
      console.log(
        `${kind.padEnd(10)} ${k.baseMedian.toFixed(3)} → ${k.hypMedian.toFixed(3)} ms  below the ${STEP_MS_FLOOR} ms floor, not judged`,
      );
      continue;
    }
    console.log(
      `${kind.padEnd(10)} ${k.baseMedian.toFixed(3)} → ${k.hypMedian.toFixed(3)} ms  paired ${k.pairedDeltaPct >= 0 ? '+' : ''}${k.pairedDeltaPct.toFixed(1)}%  worse ${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length}  cv ${(k.cvBase * 100).toFixed(0)}/${(k.cvHyp * 100).toFixed(0)}%` +
        (k.source === 'exact' ? '' : '  (sampled)') +
        (k.againstOthers
          ? `  vs the others ${k.againstOthers.medianPct >= 0 ? '+' : ''}${k.againstOthers.medianPct.toFixed(1)}% ` +
            `(lower ${Math.round(k.againstOthers.lowerFraction * k.againstOthers.deltas.length)}/${k.againstOthers.deltas.length})`
          : ''),
    );
  }
  if (decision.throughput) {
    const tp = decision.throughput;
    console.log(
      `owner ${tp.key} ${tp.baseMedian.toFixed(1)} → ${tp.hypMedian.toFixed(1)}  paired ${tp.pairedDeltaPct >= 0 ? '+' : ''}${tp.pairedDeltaPct.toFixed(1)}%  ` +
        `higher ${Math.round(tp.higherFraction * tp.deltas.length)}/${tp.deltas.length}`,
    );
  }
  if (decision.presented) {
    const pr = decision.presented;
    console.log(
      `${'presented'.padEnd(10)} ${pr.baseMedian.toFixed(1)} → ${pr.hypMedian.toFixed(1)} fps  ` +
        `paired ${pr.pairedDeltaPct >= 0 ? '+' : ''}${pr.pairedDeltaPct.toFixed(1)}%  ` +
        `fewer ${Math.round(pr.lowerFraction * pr.deltas.length)}/${pr.deltas.length}  ` +
        `cv ${(pr.cvBase * 100).toFixed(0)}/${(pr.cvHyp * 100).toFixed(0)}%`,
    );
  }
  // E-32. A muted key prints its numbers, its cv and the band it was measured
  // against. A key that moved but did not gate is the most confusing thing a
  // reader can encounter if it is not explained on the same line: the run says
  // the load matched, and the table says a key moved 25 %.
  for (const [key, l] of Object.entries(decision.load)) {
    let note = '';
    if (l.mutedBy === 'floor') note = ' (both sides below its floor, reported, not gated)';
    else if (!l.gated) note = ' (reported, not gated)';
    const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : 'missing');
    console.log(
      `${key.padEnd(18)} ${fmt(l.base)} → ${fmt(l.hyp)} ` +
        `(${l.deltaPct == null ? 'n/a' : l.deltaPct.toFixed(1) + '%'})` +
        `cv ${(l.cvBase * 100).toFixed(0)}/${(l.cvHyp * 100).toFixed(0)}%${note}`,
    );
  }
  for (const r of [...decision.reasons, ...decision.muted, ...decision.regress, ...decision.noisy]) console.log(`- ${r}`);
  if (decision.attributed) {
    const at = decision.attributed;
    const nPairs = Object.values(decision.kinds)[0]?.deltas?.length ?? 0;
    if (!at.interpretable) {
      console.log(
        `\n  attributed to ${at.key} (the sub-timer the change lives in):\n` +
          `    ${at.baseMedian.toFixed(3)} → ${at.hypMedian.toFixed(3)} ms  ` +
          `below the ${STEP_MS_FLOOR} ms floor, not judged`,
      );
    } else {
      console.log(
        `\n  attributed to ${at.key} (the sub-timer the change lives in):\n` +
          `    ${at.baseMedian.toFixed(3)} → ${at.hypMedian.toFixed(3)} ms  ` +
          `paired ${at.pairedDeltaPct >= 0 ? '+' : ''}${at.pairedDeltaPct.toFixed(1)}%  ` +
          `worse ${Math.round(at.worseFraction * nPairs)}/${nPairs}  ` +
          `cv ${(at.cvBase * 100).toFixed(0)}/${(at.cvHyp * 100).toFixed(0)}%`,
      );
    }
  } else if (decision.metric) {
    console.log(`\n  attributed metric ${decision.metric}: not present in the pairs`);
  }
}

if (isCli(import.meta.url)) await main();
