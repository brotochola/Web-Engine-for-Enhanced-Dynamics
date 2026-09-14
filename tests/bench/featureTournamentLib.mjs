/**
 * Shared helpers for feature hyp tournaments (Ray / Decals / Particles / …).
 * Feature runners supply apply/restore + scene list + target metric maps.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { workerLoadPct } from '../../src/workers/workers-utils.js';

export function parseTournamentArgs(argv, defaults = {}) {
  const out = {
    round: 'all',
    runs: 2,
    warmupMs: 8000,
    durationMs: 10000,
    skipL3: false,
    dryApply: false,
    ...defaults,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--round' && argv[i + 1]) out.round = String(argv[++i]);
    else if (a === '--runs' && argv[i + 1]) out.runs = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--warmup-ms' && argv[i + 1]) out.warmupMs = parseInt(argv[++i], 10) || out.warmupMs;
    else if (a === '--duration-ms' && argv[i + 1]) out.durationMs = parseInt(argv[++i], 10) || out.durationMs;
    else if (a === '--skip-l3') out.skipL3 = true;
    else if (a === '--dry-apply') out.dryApply = true;
  }
  return out;
}

export function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function seriesStats(values) {
  return { median: median(values), samples: values };
}

export function pctDelta(hyp, base) {
  if (base == null || !(base > 0) || hyp == null) return null;
  return ((hyp - base) / base) * 100;
}

export function sortHypIds(ids, canonicalOrder) {
  const set = new Set(ids);
  return canonicalOrder.filter((id) => set.has(id));
}

export function tagFromIds(ids, canonicalOrder) {
  if (!ids.length) return 'BASE';
  return sortHypIds(ids, canonicalOrder).join('+');
}

export function pairsOf(ids, canonicalOrder) {
  const ordered = sortHypIds(ids, canonicalOrder);
  const out = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      out.push([ordered[i], ordered[j]]);
    }
  }
  return out;
}

export function workerFromReport(j, preferIds = ['logic0', 'particle', 'spatial0']) {
  const workers = j.workers || [];
  for (const id of preferIds) {
    const w = workers.find((x) => x.id === id || x.type === id);
    if (w) return w;
  }
  return workers[0] || null;
}

export function statsFromReport(j, workerPreferIds) {
  const w = workerFromReport(j, workerPreferIds);
  const avg = w?.statsSamplesAverage || {};
  return {
    id: w?.id,
    type: w?.type,
    STEP_MS: avg.STEP_MS ?? 0,
    RAYCAST_MS: avg.RAYCAST_MS ?? 0,
    DECAL_STAMP_MS: avg.DECAL_STAMP_MS ?? 0,
    PARTICLE_PHYSICS_MS: avg.PARTICLE_PHYSICS_MS ?? 0,
    BUILD_ACTIVE_VISIBLE_MS: avg.BUILD_ACTIVE_VISIBLE_MS ?? 0,
    PARTICLES_STAMPED: avg.PARTICLES_STAMPED ?? 0,
    ACTIVE_PARTICLES: avg.ACTIVE_PARTICLES ?? 0,
    NEIGHBOR_MS: avg.NEIGHBOR_MS ?? 0,
    REBUILD_MS: avg.REBUILD_MS ?? 0,
    VISIBILITY_MS: avg.VISIBILITY_MS ?? 0,
    loadPct: workerLoadPct(avg.STEP_MS ?? 0),
    averageFPS: w?.averageFPS ?? 0,
    raw: avg,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.integratedRunner
 * @param {string} opts.microRunner - path to L1 .mjs
 * @param {string[]} [opts.microArgs]
 * @param {string} opts.outDir
 * @param {string} opts.tag
 * @param {number} opts.runIndex
 * @param {Array<{key,scene,exportName}>} opts.scenes
 * @param {number} opts.warmupMs
 * @param {number} opts.durationMs
 * @param {string[]} opts.workerPreferIds
 * @param {() => void} opts.applyEntrant
 * @param {(microJson) => object} opts.summarizeL1Run - map micro JSON → flat metrics object
 */
export function measureEntrant(opts) {
  const {
    repoRoot,
    integratedRunner,
    microRunner,
    microArgs = [],
    outDir,
    tag,
    runs,
    scenes,
    warmupMs,
    durationMs,
    workerPreferIds,
    applyEntrant,
    summarizeL1Run,
  } = opts;

  console.log(`\n======== MEASURE ${tag} ========`);
  applyEntrant();

  const l1Runs = [];
  const sceneRuns = {};
  for (const s of scenes) sceneRuns[s.key] = [];

  for (let r = 0; r < runs; r++) {
    console.log(`\n--- ${tag} L1 run ${r + 1}/${runs} ---`);
    const l1Out = path.join(outDir, `${tag}-l1-r${r}.json`);
    try {
      execFileSync(process.execPath, [microRunner, ...microArgs, '--output', l1Out], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      const micro = JSON.parse(fs.readFileSync(l1Out, 'utf8'));
      l1Runs.push({ ok: true, ...summarizeL1Run(micro) });
    } catch (e) {
      console.error(`L1 FAILED for ${tag}:`, e.message);
      l1Runs.push({ ok: false, error: String(e.message || e) });
      break;
    }

    for (const scene of scenes) {
      console.log(`\n--- ${tag} ${scene.key} run ${r + 1}/${runs} ---`);
      const out = path.join(outDir, `${tag}-${scene.key}-r${r}.json`);
      execFileSync(
        process.execPath,
        [
          integratedRunner,
          '--scene',
          scene.scene,
          '--scene-export',
          scene.exportName,
          '--warmup-ms',
          String(warmupMs),
          '--duration-ms',
          String(durationMs),
          '--output',
          out,
        ],
        { cwd: repoRoot, stdio: 'inherit' }
      );
      const report = JSON.parse(fs.readFileSync(out, 'utf8'));
      sceneRuns[scene.key].push(statsFromReport(report, workerPreferIds));
    }
  }

  const okL1 = l1Runs.filter((x) => x.ok);
  const l1 = !okL1.length
    ? { ok: false, error: l1Runs[0]?.error }
    : {
        ok: true,
        ...Object.fromEntries(
          Object.keys(okL1[0])
            .filter((k) => k !== 'ok' && k !== 'error' && typeof okL1[0][k] === 'number')
            .map((k) => [k, seriesStats(okL1.map((x) => x[k]))])
        ),
      };

  const scenesSummary = {};
  for (const [key, rows] of Object.entries(sceneRuns)) {
    if (!rows.length) {
      scenesSummary[key] = null;
      continue;
    }
    const numKeys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number');
    scenesSummary[key] = Object.fromEntries(numKeys.map((k) => [k, seriesStats(rows.map((x) => x[k]))]));
  }

  return { id: tag, l1, scenes: scenesSummary, runs: { l1: l1Runs, scenes: sceneRuns } };
}

/**
 * Decide single vs BASE.
 * @param {object} result measureEntrant output
 * @param {object} base
 * @param {{ l1Higher?: string[], l1Lower?: string[], sceneKey: string, sceneLower?: string[], sceneHigher?: string[] }} targets
 *   l1Higher: ops/s style (higher better); sceneLower: ms style (lower better)
 */
export function decideSingle(result, base, targets) {
  const reasons = [];
  if (!result.l1?.ok) return { accept: false, reasons: ['L1 failed'], targetOk: false };
  if (!base?.l1?.ok) return { accept: false, reasons: ['BASE missing'], targetOk: false };

  let targetOk = false;
  for (const key of targets.l1Higher || []) {
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    if (d != null && d >= 3) targetOk = true;
  }
  for (const key of targets.l1Lower || []) {
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    if (d != null && d <= -3) targetOk = true;
  }

  const sceneKey = targets.sceneKey;
  const sceneRes = result.scenes?.[sceneKey];
  const sceneBase = base.scenes?.[sceneKey];
  if (sceneRes && sceneBase) {
    for (const key of targets.sceneLower || []) {
      const d = pctDelta(sceneRes[key]?.median, sceneBase[key]?.median);
      if (d != null && d <= -3) targetOk = true;
    }
    for (const key of targets.sceneHigher || []) {
      const d = pctDelta(sceneRes[key]?.median, sceneBase[key]?.median);
      if (d != null && d >= 3) targetOk = true;
    }
    if (targets.workloadKey) {
      const wk = targets.workloadKey;
      const d = pctDelta(sceneRes[wk]?.median, sceneBase[wk]?.median);
      if (d != null && Math.abs(d) > 5) reasons.push(`workload ${wk} drift ${d.toFixed(1)}%`);
    }
    const stepD = pctDelta(sceneRes.STEP_MS?.median, sceneBase.STEP_MS?.median);
    if (stepD != null && stepD > 5) reasons.push(`STEP_MS regress ${stepD.toFixed(1)}%`);
  }

  if (!targetOk) reasons.push('target metric did not improve ≥3%');

  // Non-target L1 regressions
  const allL1 = Object.keys(result.l1).filter((k) => k !== 'ok' && result.l1[k]?.median != null);
  const protectedKeys = new Set([...(targets.l1Higher || []), ...(targets.l1Lower || [])]);
  for (const key of allL1) {
    if (protectedKeys.has(key)) continue;
    if (targets.ignoreL1Noise?.includes(key)) continue;
    const d = pctDelta(result.l1[key]?.median, base.l1[key]?.median);
    // Assume higher is better for unnamed L1 keys (ops/s)
    if (d != null && d < -5) reasons.push(`non-target L1 ${key} regress ${d.toFixed(1)}%`);
  }

  return { accept: reasons.length === 0 && targetOk, reasons, targetOk };
}

export function decideCombo(result, base, parents, targets) {
  const reasons = [];
  if (!result.l1?.ok) return { accept: false, reasons: ['L1 failed'] };
  const sceneKey = targets.sceneKey;
  const primary = targets.comboPrimaryMs || 'STEP_MS';
  const sceneRes = result.scenes?.[sceneKey];
  const sceneBase = base.scenes?.[sceneKey];
  if (sceneRes && sceneBase) {
    const d = pctDelta(sceneRes[primary]?.median, sceneBase[primary]?.median);
    if (d == null || d > -1) reasons.push(`combo ${primary} not better than BASE (${d?.toFixed(1)}%)`);
  }
  if (parents.length && sceneRes) {
    const bestParent = Math.min(
      ...parents.map((p) => p.scenes?.[sceneKey]?.[primary]?.median ?? Infinity)
    );
    if (Number.isFinite(bestParent) && bestParent > 0) {
      const d = pctDelta(sceneRes[primary]?.median, bestParent);
      if (d != null && d > 3) reasons.push(`combo loses >3% vs best parent ${primary} (${d.toFixed(1)}%)`);
    }
  }
  return { accept: reasons.length === 0, reasons };
}

export function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}
