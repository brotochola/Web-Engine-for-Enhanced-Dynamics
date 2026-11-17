#!/usr/bin/env node
/**
 * E-223: the frame's critical path. Which worker gates each frame, read from the frame clock's per-frame slots that
 * runFramePhase records (samples.json: at the end of each main-thread frame, every worker's last generation, start and
 * end).
 *
 * Every worker starts a generation when the frame's bell rings; the frame's work is done when the last of them ends. Per
 * generation: each worker's finish (its end minus the generation's earliest start), the gate (the worker that finished
 * last) and the critical path (that finish). A worker with no slot for a generation the others ran was still busy with
 * an earlier one: it skipped that frame, which is how an over-budget worker shows. The table answers "which worker do I
 * make cheaper to hold more entities at 60 fps": the one that gates most frames, and by how much it is past the next.
 *
 *   node tests/bench/criticalPath.mjs <samples.json> [--budget-ms 16.7] [--json out.json]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Durations past this are torn reads (a slot whose end is from an older run), not frames. */
const MAX_SLOT_MS = 200;
/** A worker woken by the bell can stamp its start this much before main's own t0 (seen: 0.01 ms). */
const START_SLACK_MS = 1;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * @param {Array<{ mainGen: number, mainT0: number, slots: Array<{ name: string, gen: number, start: number, end: number }> }>} samples
 * @param {{ budgetMs?: number, skip?: string[] }} [opts] skip: slot names left out (the main thread's own slot).
 */
export function criticalPathSummary(samples, opts = {}) {
  const budgetMs = opts.budgetMs ?? 1000 / 60;
  const skip = new Set(opts.skip ?? ['main']);
  const list = Array.isArray(samples) ? samples : [];
  // The frames: each main-thread generation and the time its bell rang (mainT0).
  const t0Of = new Map();
  for (const sample of list) if (sample.mainGen > 0 && sample.mainT0 > 0 && !t0Of.has(sample.mainGen)) t0Of.set(sample.mainGen, sample.mainT0);
  const frameGens = [...t0Of.keys()].sort((a, b) => a - b);
  const frameT0 = frameGens.map((g) => t0Of.get(g));
  // A step belongs to the frame whose bell came last before it started (stampStep writes the generation seen when the
  // step ended, which for a step longer than a frame is a later one). A worker wakes on the bell, so its start can read
  // a hair before main's own t0: START_SLACK_MS.
  const frameOf = (start) => {
    let lo = 0;
    let hi = frameT0.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frameT0[mid] <= start + START_SLACK_MS) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at;
  };
  const byFrame = new Map(); // frame index -> Map(worker -> { start, end })
  const workers = new Set();
  for (const sample of list) {
    for (const slot of sample.slots || []) {
      if (skip.has(slot.name)) continue;
      const dur = slot.end - slot.start;
      if (!(dur > 0) || dur > MAX_SLOT_MS) continue;
      const f = frameOf(slot.start);
      if (f < 0) continue;
      workers.add(slot.name);
      let frame = byFrame.get(f);
      if (!frame) byFrame.set(f, (frame = new Map()));
      if (!frame.has(slot.name)) frame.set(slot.name, { start: slot.start, end: slot.end });
    }
  }
  const names = [...workers].sort();
  // The frames between the first and the last one any step started in; a frame where no worker started counts too
  // (every worker was still busy), with no gate.
  const indices = [...byFrame.keys()].sort((a, b) => a - b);
  const per = Object.fromEntries(names.map((n) => [n, { finishes: [], gates: 0, skipped: 0, overBudget: 0, leadMs: [] }]));
  const critical = [];
  let frames = 0;
  for (let f = indices[0] ?? 0; indices.length && f <= indices[indices.length - 1]; f++) {
    const slots = byFrame.get(f) || new Map();
    frames++;
    const t0 = frameT0[f];
    let gate = null;
    let worst = -Infinity;
    let second = -Infinity;
    for (const n of names) {
      const s = slots.get(n);
      if (!s) { per[n].skipped++; continue; }
      const finish = s.end - t0;
      per[n].finishes.push(finish);
      if (finish > budgetMs) per[n].overBudget++;
      if (finish > worst) { second = worst; worst = finish; gate = n; } else if (finish > second) second = finish;
    }
    if (gate === null) continue;
    per[gate].gates++;
    if (second > -Infinity) per[gate].leadMs.push(worst - second);
    critical.push(worst);
  }
  critical.sort((a, b) => a - b);
  const rows = names.map((n) => {
    const p = per[n];
    const f = [...p.finishes].sort((a, b) => a - b);
    const lead = [...p.leadMs].sort((a, b) => a - b);
    return {
      worker: n,
      ran: f.length,
      skipped: p.skipped,
      gates: p.gates,
      gateShare: frames ? p.gates / frames : 0,
      overBudget: p.overBudget,
      finishP50Ms: quantile(f, 0.5),
      finishP95Ms: quantile(f, 0.95),
      finishP99Ms: quantile(f, 0.99),
      leadP50Ms: quantile(lead, 0.5),
    };
  }).sort((a, b) => b.gates - a.gates || b.skipped - a.skipped);
  return {
    frames,
    budgetMs,
    criticalP50Ms: quantile(critical, 0.5),
    criticalP95Ms: quantile(critical, 0.95),
    criticalP99Ms: quantile(critical, 0.99),
    framesOverBudget: critical.filter((c) => c > budgetMs).length,
    workers: rows,
  };
}

const f2 = (v) => (v == null ? '-' : v.toFixed(2));

/** The summary as a table, one line per worker, the gate of most frames first. */
export function formatCriticalPath(s) {
  const out = [];
  out.push(`critical path over ${s.frames} frames: p50 ${f2(s.criticalP50Ms)}  p95 ${f2(s.criticalP95Ms)}  p99 ${f2(s.criticalP99Ms)} ms; ` +
    `${s.framesOverBudget} over ${f2(s.budgetMs)} ms`);
  out.push('worker        gates  share  lead p50   finish p50   p95     p99   over budget  skipped');
  for (const r of s.workers) {
    out.push(`${r.worker.padEnd(12)} ${String(r.gates).padStart(6)} ${(100 * r.gateShare).toFixed(0).padStart(5)} % ${f2(r.leadP50Ms).padStart(8)}` +
      `   ${f2(r.finishP50Ms).padStart(9)} ${f2(r.finishP95Ms).padStart(7)} ${f2(r.finishP99Ms).padStart(7)} ${String(r.overBudget).padStart(12)} ${String(r.skipped).padStart(8)}`);
  }
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  if (!file) {
    console.error('usage: node tests/bench/criticalPath.mjs <samples.json> [--budget-ms 16.7] [--json out.json]');
    process.exit(2);
  }
  const s = criticalPathSummary(JSON.parse(fs.readFileSync(file, 'utf8')), { budgetMs: Number(opt('budget-ms', 1000 / 60)) });
  console.log(formatCriticalPath(s));
  const json = opt('json', null);
  if (json) fs.writeFileSync(json, JSON.stringify(s, null, 2) + '\n');
}
