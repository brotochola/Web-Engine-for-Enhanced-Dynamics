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
 *
 * Verdict per kind: median of the paired deltas (B−A)/A. REGRESSION if any
 * kind is ≥ +3 % and its cv is ≤ 10 % (or it is the owner kind), or a load key
 * drifts more than 5 %. KEPT (product) if the owner kind is ≤ −3 %.
 * Otherwise NEUTRAL: with a kernel win that is `kept (kernel, producto neutro)`.
 */
import fs from 'node:fs';
import path from 'node:path';

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
  'DECORATIONS_ACTIVE',
  // The key the particle worker actually publishes. The name above was written
  // from the sound of it and matches nothing; keeping it would have left the
  // H-10 probe unable to fire on any real run.
  'ACTIVE_DECORATIONS',
  'DECAL_TILES_DIRTY',
  'ACTIVE_AUDIO_SLOTS',
  // F-07 / the two-pack-sites finding. packSpriteLayer runs in preRender, and
  // RENDER_QUEUE_SIZE is what actually feeds it - measured equal to
  // VISIBLE_ENTITIES on spritePackStressScene but equal by coincidence, not by
  // contract. Probing the upstream key would break the day they diverge.
  'RENDER_QUEUE_SIZE',
];
// Predator emits ~100 particles: Poisson noise alone is ~10 %. Below this
// baseline the key is reported, not gated (it is not any worker's load).
const LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000 };

/** Max STEP_MS per worker kind plus the load keys. */
export function predatorMetrics(report) {
  const out = {};
  for (const kind of KINDS) out[`${kind}_STEP_MS`] = 0;
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
    const key = `${kind}_STEP_MS`;
    if (key in out && (avg.STEP_MS ?? 0) > out[key]) out[key] = avg.STEP_MS;
    for (const lk of LOAD_KEYS) {
      if (lk in avg) published[lk] = Math.max(published[lk] ?? 0, avg[lk]);
    }
  }
  for (const lk of LOAD_KEYS) if (lk in published) out[lk] = published[lk];
  return out;
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

export function decideAbab(pairs, owner) {
  const kinds = {};
  for (const kind of KINDS) {
    const key = `${kind}_STEP_MS`;
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
      baseMedian,
      hypMedian: median(b),
      pairedDeltaPct,
      deltas,
      worseFraction: deltas.length ? deltas.filter((d) => d > 0).length / deltas.length : 0,
      cvBase: cv(a),
      cvHyp: cv(b),
      interpretable,
      belowFloorPct: interpretable ? null : ((baseMedian / STEP_MS_FLOOR) * 100).toFixed(1),
    };
  }
  const load = {};
  for (const key of LOAD_KEYS) {
    const a = median(pairs.map((p) => p.A[key] ?? 0));
    const b = median(pairs.map((p) => p.B[key] ?? 0));
    load[key] = { base: a, hyp: b, deltaPct: a > 0 ? pctDelta(b, a) : null };
  }
  const reasons = [];
  for (const [key, l] of Object.entries(load)) {
    l.gated = !(l.base < (LOAD_GATE_MIN[key] ?? 0));
    if (l.gated && l.deltaPct != null && Math.abs(l.deltaPct) > 5) reasons.push(`load ${key} ${l.deltaPct.toFixed(1)}%`);
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
      if (k.pairedDeltaPct !== 0) {
        belowFloor.push(
          `${kind} ${k.pairedDeltaPct.toFixed(1)}% on a ${k.baseMedian.toFixed(3)} ms base ` +
            `(${k.belowFloorPct}% of the ${STEP_MS_FLOOR} ms floor) - reported, not judged`,
        );
      }
      continue;
    }
    if (!(k.pairedDeltaPct >= 3)) continue;
    const quiet = Math.max(k.cvBase, k.cvHyp) <= 0.1;
    const consistent = k.worseFraction >= CONSISTENT;
    const tag = `${kind} +${k.pairedDeltaPct.toFixed(1)}% (${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length} pairs worse, cv ${(Math.max(k.cvBase, k.cvHyp) * 100).toFixed(0)}%)`;
    if (consistent && (quiet || kind === owner)) regress.push(tag);
    else noisy.push(`${tag}, not blocking`);
  }
  let verdict = 'NEUTRAL';
  const o = owner ? kinds[owner] : null;
  // An owner below the floor cannot earn a KEPT verdict. It is not that the
  // improvement is unmeasured - it is that the protocol forbids judging it, so
  // the honest verdict is NEUTRAL-with-reasons rather than a keep.
  const ownerJudged = o && o.interpretable;
  if (reasons.length) verdict = 'FAIL (load)';
  else if (!ownerJudged && o) verdict = 'NEUTRAL (below floor)';
  else if (regress.length) verdict = 'REGRESSION';
  else if (ownerJudged && o.pairedDeltaPct <= -3 && 1 - o.worseFraction >= CONSISTENT) {
    verdict = 'KEPT (product)';
  }
  return { verdict, owner, ownerJudged: Boolean(ownerJudged), kinds, load, reasons, regress, noisy, belowFloor };
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
    // before publishing RENDER_QUEUE_SIZE, COLLECT_MS, EMIT_MS and SPRITE_PACK_MS.
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
    prev.decision = decideAbab(prev.pairs, owner ?? prev.owner);
    writeJson(summaryPath, prev);
    printDecision(name, prev.decision);
    return;
  }
  // --vs <rev>: A = src/ from that revision, everything else from the working tree.
  const baseline = args.vs
    ? ensureRevWorktree(String(args.vs))
    : ensureOverlayWorktree(name, parseOverrides(rawOverrides));
  console.log(`baseline worktree ${baseline.root}`);
  // --append: add pairs to the previous sitting of the same hypothesis.
  const pairs = args.append && fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')).pairs : [];
  const first = pairs.length;
  for (let p = first; p < first + nPairs; p++) {
    const pair = {};
    // Counterbalanced: odd pairs run B first, so drift inside a pair
    // (heat, background) does not always land on the same side.
    const order = p % 2 === 0 ? [['A', baseline.root], ['B', repoRoot]] : [['B', repoRoot], ['A', baseline.root]];
    for (const [side, root] of order) {
      console.log(`\n======== ${name} pair ${p + 1}/${first + nPairs} side ${side} ========`);
      const res = runIntegratedWithRetry(scene, path.join(outDir, `${side}-p${p}.json`), { ...opts, root });
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

  const decision = decideAbab(pairs, owner);
  const summary = {
    name,
    owner,
    hyp,
    probe: probeVerdict,
    protocol: { ...opts, pairs: pairs.length, order: 'AB BA AB BA', seed: 123456 },
    vs: args.vs ? { rev: String(args.vs), sha: baseline.sha } : null,
    overrides: baseline.overrides ?? null,
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
    console.log(
      `${kind.padEnd(10)} ${k.baseMedian.toFixed(3)} → ${k.hypMedian.toFixed(3)} ms  paired ${k.pairedDeltaPct >= 0 ? '+' : ''}${k.pairedDeltaPct.toFixed(1)}%  worse ${Math.round(k.worseFraction * k.deltas.length)}/${k.deltas.length}  cv ${(k.cvBase * 100).toFixed(0)}/${(k.cvHyp * 100).toFixed(0)}%`
    );
  }
  for (const [key, l] of Object.entries(decision.load)) {
    console.log(`${key.padEnd(18)} ${l.base.toFixed(1)} → ${l.hyp.toFixed(1)} (${l.deltaPct == null ? 'n/a' : l.deltaPct.toFixed(1) + '%'})${l.gated ? '' : ' (reported, not gated)'}`);
  }
  for (const r of [...decision.reasons, ...decision.regress, ...decision.noisy]) console.log(`- ${r}`);
}

if (isCli(import.meta.url)) await main();
