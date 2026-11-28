#!/usr/bin/env node
/**
 * measure:all: two revisions of the engine (two releases, a branch against main) measured against each other on GitHub's
 * machines, in one page (docs/internal/CI_MEASURE.md).
 *
 *   npm run measure:all -- --a v0.14.0 --b v0.15.0
 *   npm run measure:all -- --a v0.15.0 --b HEAD            (with the health of HEAD: tests, races, demos)
 *   node scripts/measureAll.mjs --a … --b … --name measure-x --report      (the page again, from results already here)
 *
 * What is in it:
 *   exact    the bundles' and the WASM modules' bytes (raw and gzipped), the lines of code, the test cases: from git, here
 *   kernels  every Node kernel of tests/bench (shipped variants), src/ of a against src/ of b in the same VM, alternating:
 *            VMs differ from each other by 40 %, so a number is only ever a difference inside one
 *   scenes   nine scenes of each revision in Chromium without drawing (sceneAb.mjs), each worker's own time a frame, from its sources and again from its production bundle
 *   health   when b is the commit checked out: the suites, the thread races and the demos in Chromium
 *
 * --vms 4 (a machine), --machines linux,linuxArm,win, --rounds 5, --shards 4 (jobs a VM's work is split over), --only a,b
 * (kernels whose names start so), --no-health, --no-kernels, --no-scenes, --no-bundle (the scenes from each side's production bundle too, by default), --minutes 240 (to wait). The page and its numbers go to tests/results/measure-all/<name>/ (git-ignored):
 * a release's table goes where the release's notes are, by hand.
 *
 * A kernel is a piece of the engine's work in a loop, not a frame: a page of them says what moved and by how much, and the
 * scenes on a real GPU (npm run bench:scoreboard) say what a game gets.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { readJobs, sceneTable } from '../tests/bench/ci/collect.mjs';
import { areaOf } from '../tests/bench/ci/shipped.mjs';
import { countLines } from './codeSize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLES = ['weed.prod.bundle.esm.min.js', 'weed.prod.bundle.min.js', 'weed.bundle.esm.min.js'];
const WASM = ['src/wasm/engine.wasm', 'src/box2d/box2dWasm.wasm'];
/** Generated or vendored: not the engine's own lines (codeSize.mjs). */
const GENERATED = new Set(['src/box2d/box2dWasm.js', 'src/wasm/engine.js', 'src/vendor/pixi.min.js', 'src/version.js']);
const MACHINE_NAMES = { linux: 'Linux x64', linuxArm: 'Linux ARM', win: 'Windows x64', winArm: 'Windows ARM', mac: 'macOS M1', macIntel: 'macOS Intel' };
/** A kernel moved on a machine: 3 % or more, past that machine's detection limit. */
const BAR_PCT = 3;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 << 20, ...opts });
}

function parse(argv) {
  const out = { vms: 4, machines: 'linux,linuxArm,win', rounds: 5, shards: 4, minutes: 240, health: true, kernels: true, scenes: true, bundle: true, report: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'no-health') out.health = false;
    else if (key === 'no-kernels') out.kernels = false;
    else if (key === 'no-scenes') out.scenes = false;
    else if (key === 'no-bundle') out.bundle = false;
    else if (key === 'report') out.report = true;
    else if (['a', 'b', 'name', 'machines', 'only'].includes(key)) out[key] = argv[++i];
    else if (['vms', 'rounds', 'shards', 'minutes'].includes(key)) out[key] = Number(argv[++i]);
    else throw new Error(`measureAll: unknown argument ${argv[i]}`);
  }
  if (!out.a || !out.b) throw new Error('measureAll: --a <rev> and --b <rev>');
  return out;
}

/** A revision's files under `paths`, in a directory of their own. */
function extract(rev, paths, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, 'x.tar');
  git(['archive', '--format=tar', '-o', tar, rev, '--', ...paths]);
  const x = spawnSync('tar', ['-xf', 'x.tar'], { cwd: dir, encoding: 'utf8' });
  if (x.status !== 0) throw new Error(x.stderr);
  fs.rmSync(tar);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** What is exact of a revision: bytes, lines, test cases. */
export function factsOf(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-facts-'));
  try {
    extract(rev, ['src', 'dist', 'tests/node', 'demos/tests', 'package.json'], dir);
    const facts = { version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, bytes: {}, lines: {}, tests: {} };
    const size = (file) => {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) return null;
      const b = fs.readFileSync(p);
      return { raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length };
    };
    for (const f of BUNDLES) facts.bytes[f] = size(`dist/${f}`);
    for (const f of WASM) facts.bytes[path.basename(f)] = size(f);
    let code = 0;
    let comment = 0;
    let files = 0;
    for (const p of walk(path.join(dir, 'src'))) {
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (GENERATED.has(rel) || !/\.(m?js|glsl|wgsl|frag|vert)$/.test(rel)) continue;
      const n = countLines(fs.readFileSync(p, 'utf8'));
      code += n.code;
      comment += n.comment;
      files++;
    }
    facts.lines = { code, comment, files };
    for (const [name, d] of [['engine', 'tests/node'], ['demos', 'demos/tests']]) {
      const list = walk(path.join(dir, d)).filter((p) => p.endsWith('.test.js'));
      facts.tests[name] = list.reduce((n, p) => n + (fs.readFileSync(p, 'utf8').match(/^(?:test|it)\(/gm) || []).length, 0);
    }
    return facts;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requestOf(o, shaA, shaB, health) {
  const machines = o.machines.split(',');
  const jobs = [];
  if (o.kernels) {
    jobs.push({ task: 'sweep', label: 'kernels', machines, vms: o.vms, shards: o.shards,
      args: { plan: 'ci-request.json', rounds: o.rounds, ...(o.only ? { only: o.only } : {}) } });
  }
  if (o.scenes) {
    const real = machines.filter((m) => m !== 'mac' && m !== 'macIntel');
    jobs.push({ task: 'sceneAb', label: 'scenes', machines: real, vms: o.vms, args: { a: shaA, b: shaB, pairs: 3 } });
    // The same scenes from each revision's production bundle (N-172: the build is part of what ships).
    if (o.bundle) {
      jobs.push({ task: 'sceneAb', label: 'scenes-bundle', machines: real, vms: o.vms,
        args: { a: shaA, b: shaB, pairs: 3, bundle: 'weed.prod.bundle.esm.min.js' } });
    }
  }
  if (health) {
    jobs.push({ task: 'tests', machines: ['linux', 'linuxArm', 'win', 'winArm'] });
    jobs.push({ task: 'race', machines: ['linux', 'linuxArm', 'winArm'], args: { seconds: 15, rounds: 2 } });
    jobs.push({ task: 'scenes', machines: ['linux'], shards: 2, label: 'demos', args: { browser: 'chromium', set: 'demos', seconds: 4 } });
  }
  return { name: o.name, plan: { revs: { a: shaA, b: shaB } }, jobs };
}

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => (v.length < 2 ? NaN : Math.sqrt(v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1)));
const median = (v) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};
const pct = (log) => 100 * Math.expm1(log);

/**
 * The kernels of a fetched result: { [label]: { area, kernel, machines: { [machine]: { n, log, limit, checksums, cpus, worst,
 * best } } } }, and those that did not run. A VM's number is the mean, over a kernel's rates, of ln(median b / median a): its
 * cases' cost alike. `limit`: 2.5 sd / sqrt(VMs), in the same logarithm. `worst` and `best`: the case that lost and the one
 * that won most (the VMs' median), as { name, log }: a kernel's mean says nothing of one case ten times another.
 */
export function readKernels(dir) {
  const rows = new Map();
  const failed = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const read = (f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, e.name, f), 'utf8'));
      } catch {
        return null;
      }
    };
    const job = read('job.json');
    const result = read('result.json');
    if (result?.kind !== 'sweep') continue;
    for (const row of result.rows) {
      if (row.type !== 'revs') continue;
      if (row.error) {
        failed.set(row.label, row.error);
        continue;
      }
      const cases = Object.entries(row.metrics).map(([name, m]) => {
        const d = Math.log(median(m.b) / median(m.a));
        return [name, m.higher ? d : -d];
      });
      const logs = cases.map(([, d]) => d);
      if (logs.length === 0) {
        failed.set(row.label, 'no rate in its report');
        continue;
      }
      const kept = rows.get(row.label) || { label: row.label, kernel: row.kernel, area: areaOf(row.kernel), testsAt: row.testsAt, rates: logs.length, machines: {} };
      const m = (kept.machines[job.machineKey] ??= { vms: [], differ: 0, cpus: new Set(), cases: new Map() });
      m.vms.push(mean(logs));
      for (const [name, d] of cases) m.cases.set(name, [...(m.cases.get(name) ?? []), d]);
      m.cpus.add(job.machine?.cpu);
      if (!row.checksumsAgree) m.differ++;
      rows.set(row.label, kept);
    }
  }
  for (const label of rows.keys()) failed.delete(label);
  for (const row of rows.values()) {
    for (const m of Object.values(row.machines)) {
      m.n = m.vms.length;
      m.log = mean(m.vms);
      m.limit = m.n > 1 ? (2.5 * sd(m.vms)) / Math.sqrt(m.n) : NaN;
      m.cpus = [...m.cpus];
      const cases = [...m.cases].map(([name, d]) => ({ name, log: median(d) })).sort((x, y) => x.log - y.log);
      m.worst = cases[0];
      m.best = cases[cases.length - 1];
      delete m.cases;
    }
  }
  return { rows: [...rows.values()], failed };
}

/** 1 faster, -1 slower, 0 neither: on this machine, by the bar and past its limit. */
export function moved(m) {
  if (!m || !(Math.abs(pct(m.log)) >= BAR_PCT) || !(Math.abs(m.log) > m.limit)) return 0;
  return Math.sign(m.log);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const signed = (p, digits = 1) => `${p >= 0 ? '+' : ''}${p.toFixed(digits)} %`;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''].join('\n');

/** A kernel's worst and best case, on the machine where its worst lost most (named). */
function casesText(r, machines) {
  const own = machines.map((m) => r.machines[m]).filter((x) => x?.worst);
  if (!own.length) return '';
  const x = own.reduce((p, c) => (c.worst.log < p.worst.log ? c : p));
  const text = (c) => `${c.name.replace(/\.opsPerSec$/, '')} ${signed(pct(c.log))}`;
  const where = Object.entries(r.machines).find(([, m]) => m === x)?.[0];
  return `${MACHINE_NAMES[where] || where}: ${text(x.worst)}; ${text(x.best)}`;
}

export function page({ a, b, shaA, shaB, factsA, factsB, kernels, scenes = null, machines, health }) {
  const out = [`# ${a} against ${b}`, '', `${shaA.slice(0, 8)} (${factsA.version}) and ${shaB.slice(0, 8)} (${factsB.version}).`, '', '## Exact', ''];
  const delta = (x, y) => (x ? signed((100 * (y - x)) / x) : '');
  out.push(table(['', a, b, ''], [
    ...Object.keys(factsB.bytes).map((f) => {
      const [x, y] = [factsA.bytes[f], factsB.bytes[f]];
      return [f, x ? `${kb(x.raw)} (gzip ${kb(x.gzip)})` : '-', y ? `${kb(y.raw)} (gzip ${kb(y.gzip)})` : '-', x && y ? delta(x.raw, y.raw) : ''];
    }),
    ['lines of code in src/', factsA.lines.code, factsB.lines.code, delta(factsA.lines.code, factsB.lines.code)],
    ['lines of comment in src/', factsA.lines.comment, factsB.lines.comment, delta(factsA.lines.comment, factsB.lines.comment)],
    ['test cases, engine', factsA.tests.engine, factsB.tests.engine, delta(factsA.tests.engine, factsB.tests.engine)],
    ['test cases, demos', factsA.tests.demos, factsB.tests.demos, delta(factsA.tests.demos, factsB.tests.demos)],
  ]));
  if (kernels) {
    const { rows, failed } = kernels;
    const name = (m) => MACHINE_NAMES[m] || m;
    out.push('## Kernels', '', `Unit: operations a second (ops/s; a kernel that reports a time per call is read as its inverse). + is better: more operations a second; - is worse. `
      + `${rows.length} kernels run on both, each the mean of its cases, ${b} against ${a} in the same VM. `
      + `Moved: ${BAR_PCT} % or more, past the machine's detection limit. ${failed.size} do not run on both (the end of the page).`, '');
    out.push(table(['machine', 'VMs', 'CPUs', 'kernels', 'faster', 'slower', 'median of all, ops/s (+ better)'], machines.map((m) => {
      const own = rows.filter((r) => r.machines[m]);
      const cpus = [...new Set(own.flatMap((r) => r.machines[m].cpus))];
      return [name(m), own.length ? Math.max(...own.map((r) => r.machines[m].n)) : 0, cpus.join(', '), own.length,
        own.filter((r) => moved(r.machines[m]) > 0).length, own.filter((r) => moved(r.machines[m]) < 0).length,
        own.length ? signed(pct(median(own.map((r) => r.machines[m].log)))) : ''];
    })));
    const areas = [...new Set(rows.map((r) => r.area))];
    out.push('By part of the engine (the median of its kernels, ops/s, + is better):', '', table(['part', 'kernels', ...machines.map((m) => `${name(m)}, ops/s (+ better)`)], areas.map((area) => {
      const own = rows.filter((r) => r.area === area);
      return [area, own.length, ...machines.map((m) => {
        const v = own.filter((r) => r.machines[m]).map((r) => r.machines[m].log);
        return v.length ? signed(pct(median(v))) : '';
      })];
    })));
    const line = (r) => [r.label, r.area, ...machines.map((m) => {
      const x = r.machines[m];
      if (!x) return '';
      return `${moved(x) ? '**' : ''}${signed(pct(x.log))}${moved(x) ? '**' : ''}${Number.isFinite(x.limit) ? ` ± ${(100 * Math.expm1(x.limit)).toFixed(1)}` : ''}`;
    }), r.rates > 1 ? casesText(r, machines) : '', machines.some((m) => r.machines[m]?.differ) ? 'other results' : ''];
    const wide = (sign) => rows.filter((r) => machines.filter((m) => moved(r.machines[m]) === sign).length >= Math.min(2, machines.length))
      .sort((x, y) => sign * (mean(Object.values(y.machines).map((m) => m.log)) - mean(Object.values(x.machines).map((m) => m.log))));
    for (const [title, sign] of [['Faster on two machines or more', 1], ['Slower on two machines or more', -1]]) {
      const list = wide(sign);
      out.push(`### ${title} (${list.length})`, '', list.length ? table(['kernel', 'part', ...machines.map((m) => `${name(m)}, ops/s (+ better)`), 'its cases, worst and best (ops/s)', 'checksum'], list.map(line)) : 'None.\n');
    }
    out.push('"other results": the kernel computes something else on each side (its checksums differ), so its speed is read with that.', '');
    if (failed.size) {
      out.push('### Not comparable', '', ...[...failed].map(([label, error]) => `- ${label}: ${String(error).replace(/\s+/g, ' ').slice(0, 170)}`), '');
    }
  }
  if (scenes && scenes.rows.length) {
    const name = (m) => MACHINE_NAMES[m] || m;
    const ms = [...new Set(scenes.rows.map((r) => r.machine))];
    out.push('## Scenes', '', `Unit: STEP_MS less WAIT_MS, each worker's own ms a frame. - is better: less time a frame; + is worse. In Chromium without drawing, ${b} against ${a} in the same VM, the median of its pairs, then the VMs' mean (the ms shown are the VMs' median of each side, so a small change can read the other way in them). Bold: ${BAR_PCT} % or more, past the limit, of a worker that can be read. "few frames": it ran under 15 a second on a side (cold ones); "other frames": one side ran a quarter more than the other. A scene with a * is not the same on both sides (the list is below).`, '');
    const keys = [...new Set(scenes.rows.map((r) => `${r.scene}|${r.worker}`))];
    const changedOf = (scene) => scenes.rows.find((r) => r.scene === scene)?.changed ?? [];
    out.push(table(['scene', 'worker', ...ms.map((m) => `${name(m)}, STEP_MS (- better)`)], keys.map((key) => {
      const [scene, worker] = key.split('|');
      return [`${scene}${changedOf(scene).length ? ' *' : ''}`, worker, ...ms.map((m) => {
        const r = scenes.rows.find((x) => x.machine === m && x.scene === scene && x.worker === worker);
        if (!r) return '';
        const bold = !r.doubt && Math.abs(r.meanPct) >= BAR_PCT && Math.abs(r.log) > r.limit ? '**' : '';
        const frames = r.doubt ? ` (${r.doubt}: ${r.framesA} / ${r.framesB})` : '';
        return `${r.aMs} > ${r.bMs} ms, ${bold}${signed(r.meanPct)}${bold}${r.limitPct === null ? '' : ` ± ${r.limitPct.toFixed(1)}`}${frames}`;
      })];
    })));
    for (const scene of [...new Set(scenes.rows.map((r) => r.scene))]) {
      const changed = changedOf(scene);
      if (changed.length) out.push(`- ${scene} *: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` and ${changed.length - 6} more` : ''}`);
    }
    for (const [key, error] of Object.entries(scenes.failed)) out.push(`- ${key}: ${error.slice(0, 160)}`);
  }
  if (health) out.push(health);
  return out.join('\n');
}

/** The result's own page has the tests, races and scenes: that part of it. */
function healthOf(dir) {
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  const from = ['## Tests', '## Race stress', '## Scenes'].map((h) => md.indexOf(h)).filter((i) => i >= 0);
  if (!from.length) return '';
  const text = md.slice(Math.min(...from));
  const cut = ['## Kernels', '## Sweep'].map((h) => text.indexOf(h)).filter((i) => i >= 0);
  return `# Health of the second\n\n${cut.length ? text.slice(0, Math.min(...cut)) : text}`;
}

function ci(args) {
  const r = spawnSync(process.execPath, ['scripts/ciMeasure.mjs', ...args], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ciMeasure ${args[0]} failed`);
}

function main() {
  const o = parse(process.argv.slice(2));
  const shaA = git(['rev-parse', '--verify', `${o.a}^{commit}`]).trim();
  const shaB = git(['rev-parse', '--verify', `${o.b}^{commit}`]).trim();
  o.name ??= `measure-${`${o.a}-${o.b}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 40).replace(/-$/, '');
  const health = o.health && shaB === git(['rev-parse', 'HEAD']).trim();
  const outDir = path.join(root, 'tests/results/measure-all', o.name);
  fs.mkdirSync(outDir, { recursive: true });
  const ciDir = path.join(root, 'tests/results/ci', o.name, 'ci-out');
  if (!o.report && (o.kernels || o.scenes || health)) {
    const request = path.join(outDir, 'request.json');
    fs.writeFileSync(request, `${JSON.stringify(requestOf(o, shaA, shaB, health), null, 1)}\n`);
    ci(['submit', request]);
    ci(['wait', o.name, '--minutes', String(o.minutes)]);
  }
  const factsA = factsOf(shaA);
  const factsB = factsOf(shaB);
  const have = fs.existsSync(ciDir);
  const kernels = have && o.kernels ? readKernels(ciDir) : null;
  const scenes = have && o.scenes ? sceneTable(readJobs(ciDir)) : null;
  const machines = o.machines.split(',').filter((m) => !kernels || kernels.rows.some((r) => r.machines[m]));
  const text = page({ a: o.a, b: o.b, shaA, shaB, factsA, factsB, kernels, scenes, machines, health: have ? healthOf(ciDir) : '' });
  fs.writeFileSync(path.join(outDir, 'page.md'), `${text}\n`);
  fs.writeFileSync(path.join(outDir, 'numbers.json'), `${JSON.stringify({ a: shaA, b: shaB, factsA, factsB,
    kernels: kernels?.rows ?? null, scenes: scenes?.rows ?? null, failed: kernels ? Object.fromEntries(kernels.failed) : null }, null, 1)}\n`);
  console.log(path.join(outDir, 'page.md'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
