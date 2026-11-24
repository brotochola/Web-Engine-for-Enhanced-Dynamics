#!/usr/bin/env node
/**
 * A request's jobs in one page: <dir>/<job>/{job.json, result.json} → <dir>/summary.json and <dir>/summary.md.
 * Runs at the end of the workflow, and here on a fetched result: node tests/bench/ci/collect.mjs <dir>
 *
 * kernelAb: each VM is one observation of a kernel, ln(median of side B / median of side A), so a VM's CPU cancels. Per
 * machine and kernel: the VMs' mean difference, its standard deviation and the detection limit (2.5 x sd / sqrt(VMs),
 * HOW_WE_MEASURE's rule), in percent.
 */
import fs from 'node:fs';
import path from 'node:path';

const median = (v) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => (v.length < 2 ? NaN : Math.sqrt(v.reduce((a, b) => a + (b - mean(v)) ** 2, 0) / (v.length - 1)));
/** A difference of logarithms (what the VMs are averaged in) as the percent it is. */
const pct = (log) => +(100 * Math.expm1(log)).toFixed(2);
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

export function readJobs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const job = readJson(path.join(dir, e.name, 'job.json')) || { id: e.name, status: 'no job.json' };
    return { ...job, result: readJson(path.join(dir, e.name, 'result.json')) };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Per machine, label and kernel: what the VMs read between the sides. */
export function kernelTable(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (job.result?.kind !== 'kernelAb') continue;
    const label = job.id.replace(/-[^-]+-\d+(-s\d+)?$/, '');
    for (const row of job.result.rows) {
      const key = `${label} ${job.machineKey} ${row.id}`;
      const g = groups.get(key) || { label, machine: job.machineKey, id: row.id, opsKey: row.opsKey, informational: row.informational,
        vms: [], runMs: [], errors: [], checksums: 0 };
      if (row.error) g.errors.push(row.error);
      const ok = row.a.length > 0 && row.a.length === row.b.length && !row.a.includes(null) && !row.b.includes(null);
      if (ok) {
        const d = Math.log(median(row.b) / median(row.a));
        g.vms.push({ d: row.higherBetter ? d : -d, cpu: job.machine?.cpu, ops: median([...row.a, ...row.b]) });
        g.runMs.push(row.runMs);
        if (row.aChecksum !== null && row.aChecksum !== row.bChecksum) g.checksums++;
      }
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => {
    const d = g.vms.map((v) => v.d);
    const n = d.length;
    const spread = sd(d);
    return {
      label: g.label, machine: g.machine, id: g.id, informational: g.informational, n,
      meanPct: n ? pct(mean(d)) : null,
      sdPct: n > 1 ? pct(spread) : null,
      limitPct: n > 1 ? pct(2.5 * spread / Math.sqrt(n)) : null,
      worstPct: n ? pct(Math.max(...d.map(Math.abs))) : null,
      better: d.filter((x) => x > 0).length,
      runMs: g.runMs.length ? Math.round(median(g.runMs)) : null,
      ...(g.checksums ? { checksums: g.checksums } : {}),
      ...(g.errors.length ? { errors: [...new Set(g.errors)].slice(0, 2) } : {}),
      byCpu: Object.fromEntries([...new Set(g.vms.map((v) => v.cpu))].map((cpu) => {
        const own = g.vms.filter((v) => v.cpu === cpu);
        return [cpu, { n: own.length, meanPct: pct(mean(own.map((v) => v.d))), ops: Math.round(median(own.map((v) => v.ops))) }];
      })),
    };
  });
}

/**
 * A sweep's comparisons: per machine, comparison and rate, what the VMs read between the sides (B faster is +), as
 * kernelTable does, with the VMs of each CPU apart.
 */
export function sweepTable(jobs) {
  const groups = new Map();
  const failed = new Map();
  for (const job of jobs) {
    if (job.result?.kind !== 'sweep') continue;
    for (const row of job.result.rows) {
      const name = `${job.machineKey}|${row.label}|${row.kernel}|${row.commit || ''}`;
      if (row.error) {
        failed.set(name, row.error);
        continue;
      }
      for (const [rate, m] of Object.entries(row.metrics)) {
        const key = `${name}|${rate}`;
        const g = groups.get(key) || { machine: job.machineKey, label: row.label, kernel: row.kernel, commit: row.commit || '', type: row.type, rate, vms: [], checksums: 0 };
        const d = Math.log(median(m.b) / median(m.a));
        g.vms.push({ d: m.higher ? d : -d, cpu: job.machine?.cpu, within: sd(m.a.map((v) => Math.log(v / median(m.a)))) });
        if (!row.checksumsAgree) g.checksums++;
        groups.set(key, g);
      }
    }
  }
  const rows = [...groups.values()].map((g) => {
    const d = g.vms.map((v) => v.d);
    const n = d.length;
    return {
      machine: g.machine, label: g.label, kernel: g.kernel, commit: g.commit, type: g.type, rate: g.rate, n,
      meanPct: pct(mean(d)),
      sdPct: n > 1 ? pct(sd(d)) : null,
      limitPct: n > 1 ? pct(2.5 * sd(d) / Math.sqrt(n)) : null,
      better: d.filter((x) => x > 0).length,
      ...(g.checksums ? { checksums: g.checksums } : {}),
      byCpu: Object.fromEntries([...new Set(g.vms.map((v) => v.cpu))].map((cpu) => {
        const own = g.vms.filter((v) => v.cpu === cpu).map((v) => v.d);
        return [cpu, { n: own.length, meanPct: pct(mean(own)) }];
      })),
    };
  });
  return { rows, failed: Object.fromEntries(failed) };
}

function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`), ''].join('\n');
}

export function summarize(dir) {
  const jobs = readJobs(dir);
  const kernels = kernelTable(jobs);
  const md = ['# CI results', '', table(['job', 'machine', 'cpu', 'threads', 'status', 'min'],
    jobs.map((j) => [j.id, j.machine?.image || j.machine?.platform, j.machine?.cpu, j.machine?.threads, j.status, j.minutes]))];
  const tests = jobs.filter((j) => j.result?.kind === 'tests');
  if (tests.length) {
    md.push('## Tests', '', table(['job', 'suite', 'tests', 'pass', 'fail', 's'], tests.flatMap((j) => Object.entries(j.result.suites)
      .map(([name, s]) => [j.id, name, s.tests, s.pass, s.fail, s.seconds]))));
    for (const j of tests) {
      for (const [name, s] of Object.entries(j.result.suites)) {
        for (const f of s.failed) md.push(`- **${j.id}** ${name}: ${f.name} (${f.where}): ${f.error.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    }
    md.push('');
  }
  const race = jobs.filter((j) => Array.isArray(j.result?.rows) && j.result?.broken);
  if (race.length) {
    md.push('## Race stress (bad / accepted)', '');
    const names = [...new Set(race.flatMap((j) => j.result.rows.map((r) => r.name)))];
    const kind = new Map(race.flatMap((j) => j.result.rows.map((r) => [r.name, r.kind])));
    md.push(table(['case', 'kind', ...race.map((j) => j.id)], names.map((name) => [name, kind.get(name), ...race.map((j) => {
      const rows = j.result.rows.filter((r) => r.name === name);
      return `${rows.reduce((a, r) => a + r.bad, 0)} / ${rows.reduce((a, r) => a + r.accepted, 0)}`;
    })])));
  }
  const repeat = jobs.filter((j) => j.result?.kind === 'repeatTests');
  if (repeat.length) {
    md.push('## Repeated tests (failed / runs)', '');
    const files = [...new Set(repeat.flatMap((j) => j.result.rows.map((r) => r.file)))];
    md.push(table(['file', ...repeat.map((j) => j.id)], files.map((f) => [path.basename(f), ...repeat.map((j) => {
      const r = j.result.rows.find((x) => x.file === f);
      return r ? `${r.failed} / ${r.runs}` : '';
    })])));
  }
  const scenes = jobs.filter((j) => j.result?.kind === 'sceneSmoke');
  if (scenes.length) {
    md.push('## Scenes', '', table(['job', 'browser', 'WebGL', 'WebGPU', 'booted', 'with logs'], scenes.map((j) => [j.id,
      `${j.result.browser} ${j.result.version}`, j.result.gpu?.webgl, j.result.gpu?.webgpu,
      `${j.result.rows.filter((r) => r.booted).length}/${j.result.rows.length}`, j.result.rows.filter((r) => r.logs.length).length])));
    const names = [...new Set(scenes.flatMap((j) => j.result.rows.map((r) => r.scene)))];
    md.push('Renderer frames a second (dead: did not boot; *: logged something).', '');
    md.push(table(['scene', ...scenes.map((j) => j.id)], names.map((n) => [n, ...scenes.map((j) => {
      const r = j.result.rows.find((x) => x.scene === n);
      if (!r) return '';
      const fps = r.fps ? r.fps.renderer ?? r.fps.pixi ?? Object.values(r.fps)[0] : '?';
      return `${r.booted ? fps : 'dead'}${r.logs.length ? ' *' : ''}`;
    })])));
  }
  if (kernels.length) {
    md.push('## Kernels (B against A, percent, + is faster)', '', table(['label', 'machine', 'kernel', 'VMs', 'mean', 'sd', 'limit', 'worst', 'better', 'ms'],
      kernels.map((k) => [k.label, k.machine, k.id, k.n, k.meanPct, k.sdPct, k.limitPct, k.worstPct, k.n ? `${k.better}/${k.n}` : '',
        k.errors ? `FAILED ${k.errors[0].slice(0, 120)}` : k.runMs])));
  }
  const sweep = sweepTable(jobs);
  if (sweep.rows.length) {
    md.push('## Sweep', '', `${sweep.rows.length} rates of ${new Set(sweep.rows.map((r) => `${r.label}|${r.kernel}|${r.commit}`)).size} comparisons; ${Object.keys(sweep.failed).length} failed. All in summary.json.`, '');
  }
  return { jobs, kernels, sweep, md: md.join('\n') };
}

const dir = process.argv[2];
if (dir && process.argv[1]?.endsWith('collect.mjs')) {
  const s = summarize(dir);
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify({ jobs: s.jobs.map((j) => (j.result?.kind === 'sweep' ? { ...j, result: { kind: 'sweep', rows: j.result.rows.length } } : j)), kernels: s.kernels, sweep: s.sweep }, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, 'summary.md'), `${s.md}\n`);
  console.log(s.md.slice(0, 20000));
}
