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
      meanPct: n ? +(100 * mean(d)).toFixed(2) : null,
      sdPct: n > 1 ? +(100 * spread).toFixed(2) : null,
      limitPct: n > 1 ? +(100 * 2.5 * spread / Math.sqrt(n)).toFixed(2) : null,
      worstPct: n ? +(100 * Math.max(...d.map(Math.abs))).toFixed(2) : null,
      better: d.filter((x) => x > 0).length,
      runMs: g.runMs.length ? Math.round(median(g.runMs)) : null,
      ...(g.checksums ? { checksums: g.checksums } : {}),
      ...(g.errors.length ? { errors: [...new Set(g.errors)].slice(0, 2) } : {}),
      byCpu: Object.fromEntries([...new Set(g.vms.map((v) => v.cpu))].map((cpu) => {
        const own = g.vms.filter((v) => v.cpu === cpu);
        return [cpu, { n: own.length, meanPct: +(100 * mean(own.map((v) => v.d))).toFixed(2), ops: Math.round(median(own.map((v) => v.ops))) }];
      })),
    };
  });
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
  return { jobs, kernels, md: md.join('\n') };
}

const dir = process.argv[2];
if (dir && process.argv[1]?.endsWith('collect.mjs')) {
  const s = summarize(dir);
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify({ jobs: s.jobs, kernels: s.kernels }, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, 'summary.md'), `${s.md}\n`);
  console.log(s.md.slice(0, 20000));
}
