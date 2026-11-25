#!/usr/bin/env node
/**
 * The measures kept (DX-MEASURES): every measure:all of a release or of a merged performance commit, as it came, against
 * nothing. docs/internal/measures/<date>-<name>.json holds both sides' raw values by VM: each kernel case's rounds, each
 * scene worker's pairs with the frames behind them, the VM's CPU and the ruler's rates on it (tests/bench/ci/ruler.mjs), and
 * the exact numbers (bytes, lines, tests). Anything is compared later.
 *
 *   node scripts/measures.mjs save <name> [--date 2026-11-25] [--from <dir with ci-out>]   a fetched measure:all kept
 *   node scripts/measures.mjs list
 *   node scripts/measures.mjs compare <measure>[:a|:b] <measure>[:a|:b] [--bar 5] [--all]
 *
 * compare: two sides, of the same measure (the same VMs: read it as measure:all's page) or of two. Across measures a case is
 * compared on each CPU model both saw, its rate divided by the ruler's there when both have it: a difference under 10 % is
 * then the machines', not the engine's, and the table says which CPUs it has.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MEASURES_DIR = path.join(root, 'docs/internal/measures');

const median = (v) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};
const short = (x) => (typeof x === 'number' ? Number(x.toPrecision(4)) : x);
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** A measure from a fetched CI result: `dir` holds its ci-out, `numbers` what measure:all wrote beside its page. */
export function measureOf(name, date, dir, numbers) {
  const out = { name, date, a: numbers?.a ?? null, b: numbers?.b ?? null, exact: numbers ? { a: numbers.factsA, b: numbers.factsB } : null, vms: {}, kernels: {}, scenes: {} };
  for (const id of fs.readdirSync(dir).sort()) {
    const job = read(path.join(dir, id, 'job.json'));
    const result = read(path.join(dir, id, 'result.json'));
    if (!job || !result || (result.kind !== 'sweep' && result.kind !== 'sceneAb')) continue;
    const m = job.machine ?? {};
    out.vms[id] = { machine: job.machineKey, cpu: m.cpu, threads: m.threads, node: m.node, v8: m.v8, started: job.started, ruler: job.ruler ?? null };
    if (result.kind === 'sweep') {
      for (const row of result.rows) {
        if (row.type !== 'revs' || row.error) continue;
        const k = (out.kernels[row.label] ??= { kernel: row.kernel, cases: {} });
        for (const [name2, metric] of Object.entries(row.metrics)) {
          const c = (k.cases[name2] ??= { higher: metric.higher, vms: {} });
          c.vms[id] = { a: metric.a.map(short), b: metric.b.map(short) };
        }
      }
    } else {
      out.mode = result.mode ?? 'shell';
      for (const row of result.rows) {
        if (row.error) continue;
        const s = (out.scenes[row.scene] ??= { query: row.query ?? '', changed: row.changed ?? null, workers: {} });
        for (const worker of new Set([...row.a, ...row.b].flatMap((x) => Object.keys(x.ms)))) {
          const w = (s.workers[worker] ??= {});
          const of = (list, key) => list.map((x) => short(x[key]?.[worker] ?? null));
          w[id] = { a: of(row.a, 'ms'), b: of(row.b, 'ms'), framesA: of(row.a, 'frames'), framesB: of(row.b, 'frames') };
        }
      }
    }
  }
  return out;
}

/** One line a VM's values, so the files' diffs stay small; keys sorted by how they came. */
function textOf(m) {
  const lines = (o, pad) => Object.entries(o).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const kernels = Object.entries(m.kernels).map(([k, v]) => `  ${JSON.stringify(k)}: {"kernel": ${JSON.stringify(v.kernel)}, "cases": {\n${lines(v.cases, '   ')}\n  }}`).join(',\n');
  const scenes = Object.entries(m.scenes).map(([k, v]) => `  ${JSON.stringify(k)}: {"query": ${JSON.stringify(v.query)}, "changed": ${JSON.stringify(v.changed)}, "workers": {\n${lines(v.workers, '   ')}\n  }}`).join(',\n');
  const head = { name: m.name, date: m.date, a: m.a, b: m.b, mode: m.mode ?? null, exact: m.exact };
  return `{\n${lines(head, ' ')},\n "vms": {\n${lines(m.vms, '  ')}\n },\n "kernels": {\n${kernels}\n },\n "scenes": {\n${scenes}\n }\n}\n`;
}

export function listMeasures(dir = MEASURES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, ...read(path.join(dir, f)) }));
}

/** A side's value of a case on a VM: the rounds' median, as a rate (more is better) over the ruler's mean rate there. */
function sideValue(measure, c, vm, side) {
  const v = median(c.vms[vm][side]);
  if (!(v > 0)) return null;
  const rate = c.higher ? v : 1 / v;
  const ruler = measure.vms[vm]?.ruler;
  if (!ruler) return { rate, ruled: null };
  const at = (k) => (ruler.start[k] + (ruler.end?.[k] ?? ruler.start[k])) / 2;
  return { rate, ruled: rate / Math.cbrt(at('float') * at('memory') * at('branch')) };
}

/**
 * Side y of one measure against side x of another, case by case and CPU model by CPU model:
 * [{ kernel, case, cpu, log, vms: [x, y], ruled }], log(y / x) of the rates (> 0 is faster). The same measure: by VM.
 */
export function compareKernels(mx, sx, my, sy) {
  const rows = [];
  const same = mx.file !== undefined && mx.file === my.file;
  for (const [label, kx] of Object.entries(mx.kernels)) {
    const ky = my.kernels[label];
    if (!ky) continue;
    for (const [name, cx] of Object.entries(kx.cases)) {
      const cy = ky.cases[name];
      if (!cy) continue;
      const groups = new Map();
      const add = (m, c, side, which) => {
        for (const vm of Object.keys(c.vms)) {
          const cpu = m.vms[vm]?.cpu ?? '?';
          const v = sideValue(m, c, vm, side);
          if (!v) continue;
          const key = same ? vm : cpu;
          const g = groups.get(key) ?? { cpu, x: [], y: [] };
          g[which].push(v);
          groups.set(key, g);
        }
      };
      add(mx, cx, sx, 'x');
      add(my, cy, sy, 'y');
      for (const g of groups.values()) {
        if (!g.x.length || !g.y.length) continue;
        const ruled = !same && [...g.x, ...g.y].every((v) => v.ruled !== null);
        const pick = (list) => median(list.map((v) => (ruled ? v.ruled : v.rate)));
        rows.push({ kernel: label, case: name, cpu: g.cpu, log: Math.log(pick(g.y) / pick(g.x)), vms: [g.x.length, g.y.length], ruled });
      }
    }
  }
  return rows;
}

function sideOf(text, all) {
  const [name, side = 'b'] = text.split(':');
  const hit = all.filter((m) => m.file === `${name}.json` || m.name === name || m.file.includes(name));
  if (hit.length !== 1) throw new Error(`measures: "${name}" names ${hit.length} measures (${all.map((m) => m.name).join(', ')})`);
  if (side !== 'a' && side !== 'b') throw new Error(`measures: side "${side}" is a or b`);
  return [hit[0], side];
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : null);
  if (cmd === 'save') {
    const name = rest[0];
    const from = opt('--from') ?? path.join(root, 'tests/results/ci', name, 'ci-out');
    const numbers = read(path.join(root, 'tests/results/measure-all', name, 'numbers.json')) ?? read(path.join(path.dirname(from), 'numbers.json'));
    const date = opt('--date') ?? new Date().toLocaleDateString('sv');
    const m = measureOf(name, date, from, numbers);
    fs.mkdirSync(MEASURES_DIR, { recursive: true });
    const file = path.join(MEASURES_DIR, `${date}-${name}.json`);
    fs.writeFileSync(file, textOf(m));
    console.log(`${file}: ${Object.keys(m.vms).length} VMs, ${Object.keys(m.kernels).length} kernels, ${Object.keys(m.scenes).length} scenes, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  } else if (cmd === 'list') {
    for (const m of listMeasures()) {
      console.log(`${m.file.padEnd(52)} ${(m.a ?? '').slice(0, 8)} ${(m.b ?? '').slice(0, 8)}  ${Object.keys(m.kernels).length} kernels, ${Object.keys(m.scenes).length} scenes, ${Object.keys(m.vms).length} VMs`);
    }
  } else if (cmd === 'compare') {
    const all = listMeasures();
    const [mx, sx] = sideOf(rest[0], all);
    const [my, sy] = sideOf(rest[1], all);
    const bar = Number(opt('--bar') ?? (mx.file === my.file ? 3 : 10));
    const rows = compareKernels(mx, sx, my, sy);
    const byCase = new Map();
    for (const r of rows) byCase.set(`${r.kernel} | ${r.case}`, [...(byCase.get(`${r.kernel} | ${r.case}`) ?? []), r]);
    const out = [...byCase].map(([key, list]) => ({ key, list, log: median(list.map((r) => r.log)) })).sort((p, q) => p.log - q.log);
    const pct = (log) => `${log >= 0 ? '+' : ''}${(100 * Math.expm1(log)).toFixed(1)} %`;
    console.log(`${my.name}:${sy} (${my[sy]?.slice(0, 8)}) against ${mx.name}:${sx} (${mx[sx]?.slice(0, 8)}): ${out.length} cases; + is faster`);
    for (const o of out) {
      if (!rest.includes('--all') && Math.abs(100 * Math.expm1(o.log)) < bar) continue;
      console.log(`${pct(o.log).padStart(9)}  ${o.key}  [${o.list.map((r) => `${pct(r.log)} ${r.cpu}${r.ruled || mx.file === my.file ? '' : ' unruled'}`).slice(0, 5).join('; ')}]`);
    }
  } else {
    console.log('usage: measures.mjs save <name> | list | compare <measure>[:a|:b] <measure>[:a|:b]');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
