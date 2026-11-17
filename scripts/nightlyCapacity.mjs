#!/usr/bin/env node
/**
 * Nightly capacity: the reference scenes' capacity (tests/bench/runCapacity.mjs: the most entities each holds at
 * 60 fps with every worker's p99 inside 16.7 ms), one JSON line a scene appended to a history file, and a table
 * against the previous night. Meant to run unattended through the bench lock, on AC power, with the screen on (the
 * runs are headed Chrome windows).
 *
 *   node scripts/nightlyCapacity.mjs                      main's tip in ../weed-ab/pool-capacity, the reference set
 *   node scripts/nightlyCapacity.mjs --set predator,boids --rev HEAD --no-pool
 *   node scripts/nightlyCapacity.mjs --show [--last 10]   the history as a table, nothing run
 *
 * Options: --rev <rev> (main) is measured whole (its src, scenes and runner) in a worktree: the fixed pool tree
 * --pool <name> (capacity), or with --no-pool one made for the run and removed after it; --here measures this tree
 * as it is instead. --set <keys> (runCapacity --list shows them; default the reference set). --history <file>
 * (tests/results/capacity-history.jsonl). --cold starts each search from the scene's catalog start instead of the
 * last capacity on record (a seeded search starts there and steps by --seed-growth, 1.15: about 5 runs a scene).
 * --start <load> (with one scene in --set), --resolution, --confirm, --max-trials, --tail p95|p99, --warmup-ms,
 * --duration-ms as runCapacity. --allow-battery runs on battery (the lines say so;
 * by default a night on battery writes a skipped line a scene and runs nothing).
 *
 * tests/results is git-ignored and tests/bench/pruneTestResults.mjs removes what is not touched for 7 days: the
 * history file is touched every night, but a week without a night loses it. Point --history elsewhere to keep it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPACITY_SCENES,
  DEFAULT_RULE,
  REFERENCE_SET,
  fmtLoad,
  formatCapacity,
  localStamp,
  measureCapacity,
  treeRevision,
} from '../tests/bench/runCapacity.mjs';
import { isCli, parseArgs } from '../tests/bench/microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_HISTORY = path.join(repoRoot, 'tests', 'results', 'capacity-history.jsonl');

/** 'ac', 'battery' or 'none' (no battery: a desktop) from Win32_Battery's BatteryStatus; 'unknown' when unread. */
export function powerFromBatteryStatus(text) {
  const m = /BatteryStatus=(\d+)/.exec(String(text || ''));
  if (!m) return String(text || '').trim() === '' ? 'none' : 'unknown';
  const code = Number(m[1]);
  // 1 discharging, 4 low, 5 critical: on battery. 2 on AC, 3 full, 6 to 9 charging, 11 partly charged: plugged in.
  if (code === 1 || code === 4 || code === 5) return 'battery';
  if (code === 2 || code === 3 || (code >= 6 && code <= 9) || code === 11) return 'ac';
  return 'unknown';
}

/** The machine's power now. wmic is a plain exe (no CLR start, unlike PowerShell). */
export function readPower() {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const out = execFileSync('wmic', ['path', 'Win32_Battery', 'get', 'BatteryStatus', '/format:list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    return powerFromBatteryStatus(out.replace(/\r/g, ''));
  } catch {
    return 'unknown';
  }
}

/** The history's lines, oldest first; a line that does not parse is skipped. */
export function readHistory(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash.
    }
  }
  return out;
}

/** Same scene, knob, fixed query and rule: two lines whose capacities compare. */
export function sameMeasure(a, b) {
  return (
    a.scene === b.scene &&
    a.knob === b.knob &&
    (a.query || '') === (b.query || '') &&
    a.rule?.tail === b.rule?.tail &&
    a.rule?.budgetMs === b.rule?.budgetMs &&
    a.rule?.fpsMin === b.rule?.fpsMin
  );
}

/** The last measured line comparable with `probe` (a capacity found, not skipped), or null. */
export function lastComparable(history, probe) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.capacity != null && !h.skipped && sameMeasure(h, probe)) return h;
  }
  return null;
}

/** Where a seeded search starts: the last capacity, inside the scene's range; null without one. */
export function seedStart(history, def, rule) {
  const last = lastComparable(history, { scene: def.key, knob: def.knob, query: def.query || '', rule });
  if (!last) return null;
  return Math.min(def.max, Math.max(def.min, last.capacity));
}

/** Percent change of the entities against the previous comparable line; null without one. */
export function deltaVsPrevious(history, line) {
  const prev = lastComparable(history, line);
  if (!prev || !(prev.entities > 0) || line.entities == null) return null;
  return ((line.entities - prev.entities) / prev.entities) * 100;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** The table of a night (or of the history): one row a line, with the change against the line before it. */
export function formatTable(lines, history = []) {
  const head = ['date', 'rev', 'scene', 'knob', 'capacity', 'entities', 'vs last', 'breaks first', 'tightest at capacity', 'runs', 'min'];
  const rows = [head];
  const seen = [...history];
  for (const l of lines) {
    const d = l.skipped ? null : deltaVsPrevious(seen, l);
    const tight = l.tightestAtCapacity ? `${l.tightestAtCapacity.worker} p99 ${l.tightestAtCapacity.ms}` : '-';
    rows.push([
      String(l.local || l.date || '').slice(0, 16),
      String(l.sha || '').slice(0, 8) + (l.dirty ? '+' : ''),
      l.scene,
      l.knob,
      l.skipped ? `skipped (${l.skipped})` : l.capacity == null ? `< ${fmtLoad(l.range?.min)}` : fmtLoad(l.capacity) +
        (l.capped === 'max' ? ' (max)' : '') + (l.confirmed === false ? ' (unconfirmed)' : ''),
      l.entities == null ? '-' : fmtLoad(l.entities),
      d == null ? '-' : `${d >= 0 ? '+' : ''}${d.toFixed(1)} %`,
      l.skipped ? '-' : l.limitingText || '-',
      tight,
      l.runs ?? '-',
      l.minutes ?? '-',
    ]);
    seen.push(l);
  }
  const widths = head.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r, i) => {
    const line = r.map((cell, c) => pad(cell, widths[c])).join(' | ');
    return i === 0 ? `${line}\n${widths.map((w) => '-'.repeat(w)).join('-|-')}` : line;
  }).join('\n');
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function localTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyFile = args.history ? path.resolve(String(args.history)) : DEFAULT_HISTORY;
  const history = readHistory(historyFile);

  if (args.show) {
    const last = Number(args.last) > 0 ? Number(args.last) : 30;
    const lines = history.slice(-last);
    console.log(`${historyFile}: ${history.length} line(s), the last ${lines.length}`);
    console.log(formatTable(lines, history.slice(0, history.length - lines.length)));
    return;
  }

  const keys = args.set ? String(args.set).split(',').map((s) => s.trim()).filter(Boolean) : [...REFERENCE_SET];
  for (const k of keys) if (!CAPACITY_SCENES[k]) throw new Error(`--set: unknown scene ${k} (${Object.keys(CAPACITY_SCENES).join(', ')})`);
  const rule = { ...DEFAULT_RULE, tail: args.tail === 'p95' ? 'p95' : 'p99' };
  const power = readPower();
  const started = new Date();
  console.log(`nightlyCapacity ${localTime(started)}: ${keys.join(', ')}; power ${power}; history ${historyFile}`);

  if (power === 'battery' && !args['allow-battery']) {
    const lines = keys.map((k) => ({
      kind: 'capacity',
      date: started.toISOString(),
      local: localTime(started),
      scene: k,
      knob: CAPACITY_SCENES[k].knob,
      query: CAPACITY_SCENES[k].query || '',
      rule,
      capacity: null,
      skipped: 'on battery',
      power: { before: power, after: power },
    }));
    for (const l of lines) appendLine(historyFile, l);
    console.log('On battery: nothing run (--allow-battery runs anyway). Skipped lines written.');
    process.exitCode = 2;
    return;
  }

  let tree;
  if (args.here) {
    tree = { root: repoRoot, ...treeRevision(repoRoot), rev: null };
  } else {
    const { ensureRevWorktree } = await import('../tests/bench/revWorktree.mjs');
    const rev = args.rev ? String(args.rev) : 'main';
    const pool = args['no-pool'] ? null : args.pool ? String(args.pool) : 'capacity';
    const wt = ensureRevWorktree(rev, { srcOnly: false, workloadCounts: false, ...(pool ? { pool } : { tag: 'capacity' }) });
    tree = { root: wt.root, sha: wt.sha, dirty: false, rev };
  }
  console.log(`runs from ${tree.root} at ${tree.sha.slice(0, 10)}${tree.rev ? ` (${tree.rev})` : ''}${tree.dirty ? ' with uncommitted changes' : ''}`);

  const batch = path.join(repoRoot, 'tests', 'results', 'capacity-runs', localStamp(started));
  const night = [];
  let failed = 0;
  for (const key of keys) {
    const def = CAPACITY_SCENES[key];
    const seeded = args.cold ? null : seedStart(history, def, rule);
    const before = readPower();
    let line;
    try {
      const sum = await measureCapacity(def, {
        root: tree.root,
        runDir: path.join(batch, key),
        rule,
        warmupMs: args['warmup-ms'] !== undefined ? Number(args['warmup-ms']) : undefined,
        durationMs: args['duration-ms'] !== undefined ? Number(args['duration-ms']) : undefined,
        start: keys.length === 1 && args.start !== undefined ? Number(args.start) : seeded ?? undefined,
        growth: seeded != null ? Number(args['seed-growth']) || 1.15 : Number(args.growth) || 2,
        resolution: args.resolution !== undefined ? Number(args.resolution) : undefined,
        confirm: args.confirm !== undefined ? Number(args.confirm) : undefined,
        maxTrials: args['max-trials'] !== undefined ? Number(args['max-trials']) : undefined,
      });
      line = {
        kind: 'capacity',
        date: new Date().toISOString(),
        local: localTime(),
        sha: tree.sha,
        rev: tree.rev,
        dirty: tree.dirty,
        seededFrom: seeded,
        power: { before, after: readPower() },
        ...sum,
      };
      console.log(formatCapacity(sum));
    } catch (e) {
      failed++;
      console.error(`nightlyCapacity: ${key} failed: ${e?.stack || e}`);
      line = {
        kind: 'capacity',
        date: new Date().toISOString(),
        local: localTime(),
        sha: tree.sha,
        rev: tree.rev,
        scene: key,
        knob: def.knob,
        query: def.query || '',
        rule,
        capacity: null,
        skipped: `error: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`,
        power: { before, after: readPower() },
      };
    }
    appendLine(historyFile, line);
    night.push(line);
  }

  console.log(`\n=== nightlyCapacity ${localTime(started)} to ${localTime()}, ${tree.sha.slice(0, 10)}: ` +
    `${rule.tail} <= ${rule.budgetMs} ms on every worker, >= ${rule.fpsMin} fps presented and drawn`);
  console.log(formatTable(night, history));
  console.log(`history: ${historyFile}`);
  if (failed) process.exitCode = 1;
}

if (isCli(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
