#!/usr/bin/env node
/**
 * The engine's wasm kernels under AddressSanitizer, in one command:
 *
 *   node tests/asan/runAsan.mjs                       every kernel, the working tree's sources
 *   node tests/asan/runAsan.mjs shadowStamp gpuPack   those kernels
 *   node tests/asan/runAsan.mjs gpuPack@opt/sunframes-wasm
 *                                                     a revision's kernel: its C source, and its clients, test helpers
 *                                                     and shipped engine.wasm (from git, under tests/results/asan/)
 *   node tests/asan/runAsan.mjs --rev <rev> [kernel ...]   every named kernel at that revision
 *   --quick      fewer frames a group
 *   --verbose    every case's label as it runs
 *   --list       the kernels and their groups, nothing run
 *
 * Each kernel's C source is built with emcc and -fsanitize=address into a module of its own (tests/asan/asanBuild.mjs;
 * the first build also builds Emscripten's ASan runtime and libc, a few minutes, cached under tests/results/asan/).
 * Its cases (tests/asan/kernels/<kernel>.mjs) malloc every array the kernel takes, each with ASan's redzones around it,
 * call the kernel through the product's own client, then call the shipped kernel (engine.wasm, which the same client
 * binds on the same shared memory) on the same arrays and compare what the two wrote. A group passes when no call made
 * ASan report and every call wrote what the shipped kernel wrote. ASan's reports are symbolized from the build's DWARF
 * (llvm-symbolizer, inlined frames too) and name the array the access fell past; the full text goes to
 * tests/results/asan/<kernel>.log. Exit code 1 when any group failed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { asanResults, buildAsanKernel, repoRoot, revHash } from './asanBuild.mjs';
import { describeReport, reportKey, AsanSession } from './asanSession.mjs';
import { importerFor, revisionRoot } from './asanCases.mjs';

const KERNELS = ['shadowStamp', 'gpuPack', 'preRenderCollect', 'preRenderEmit'];

function parseArgs(argv) {
  const out = { kernels: [], rev: null, quick: false, verbose: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rev' && argv[i + 1]) out.rev = argv[++i];
    else if (a === '--quick') out.quick = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--list') out.list = true;
    else if (a.startsWith('--')) throw new Error(`runAsan: unknown option ${a}`);
    else out.kernels.push(a);
  }
  if (!out.kernels.length) out.kernels = [...KERNELS];
  // The self-check first, whatever was asked (canary.mjs): a blind harness passes everything.
  out.kernels = ['canary', ...out.kernels.filter((k) => k !== 'canary')];
  return out.kernels.map((k) => {
    const at = k.indexOf('@');
    const name = at >= 0 ? k.slice(0, at) : k;
    if (name !== 'canary' && !KERNELS.includes(name)) throw new Error(`runAsan: no kernel ${name} (${KERNELS.join(', ')})`);
    return { ...out, name, rev: at >= 0 ? k.slice(at + 1) : out.rev };
  });
}

async function loadKernel(name) {
  const file = path.join(repoRoot, 'tests', 'asan', 'kernels', `${name}.mjs`);
  if (!fs.existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)).default;
}

const fmtCount = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** One kernel: build, then every group's cases; returns whether every group passed. */
async function runKernel(spec, log) {
  const kernel = await loadKernel(spec.name);
  const at = spec.rev ? `@${spec.rev} (${revHash(spec.rev)})` : ' (working tree)';
  if (!kernel) {
    console.log(`\n${spec.name}${at}: no cases yet (tests/asan/kernels/${spec.name}.mjs)`);
    return true;
  }
  const rev = kernel.workingTree ? null : spec.rev;
  const root = rev ? revisionRoot(rev) : repoRoot;
  const build = buildAsanKernel({ name: kernel.name, sources: kernel.sources, exports: kernel.exports, rev, log: (s) => console.log(`  ${s}`) });
  console.log(`\n${kernel.name}${kernel.workingTree ? '' : at}: ${kernel.sources.join(', ')} with ASan${build.built ? ' (built now)' : ''}`);
  const session = new AsanSession(build);
  await session.start();
  const ctx = { session, root, harnessRoot: repoRoot, rev, quick: spec.quick, importRepo: importerFor(root) };
  const groups = await kernel.groups(ctx);
  if (spec.list) {
    for (const g of groups) console.log(`  ${g.label}: ${fmtCount(g.cases.length, 'case')}`);
    return true;
  }
  let allPassed = true;
  for (const g of groups) {
    const t0 = performance.now();
    const findings = new Map();
    const mismatches = [];
    const errors = [];
    let calls = 0;
    let rows = 0;
    for (const c of g.cases) {
      if (spec.verbose) console.log(`    ${c.label}`);
      let result = null;
      try {
        result = await c.run(ctx);
      } catch (err) {
        errors.push({ label: c.label, error: err });
      }
      const reports = session.takeReports();
      if (result) {
        calls += result.calls | 0;
        rows += result.rows | 0;
        if (result.mismatch) mismatches.push({ label: c.label, text: result.mismatch });
      }
      if (reports) {
        for (const rep of reports) {
          const key = reportKey(build, rep);
          let f = findings.get(key);
          if (!f) findings.set(key, (f = { report: rep, cases: [], count: 0 }));
          f.count++;
          if (f.cases.length < 3) f.cases.push(c.label);
          log.push(`--- ${kernel.name}${at} / ${g.label} / ${c.label}`, ...rep.raw);
        }
      }
      if (reports && reports.some((rep) => rep.access?.op !== 'READ')) {
        // What the kernel wrote into a redzone may have broken the allocator's records (it keeps them there): a fresh
        // module. A bad read changed nothing.
        await session.reset();
      } else if (!g.resetAfter) {
        session.checkGrowth();
        session.freeAll();
      }
    }
    if (g.resetAfter) await session.reset();
    const ms = (performance.now() - t0).toFixed(0);
    const ok = !findings.size && !mismatches.length && !errors.length;
    allPassed &&= ok;
    const stats = `${fmtCount(g.cases.length, 'case')}, ${fmtCount(calls, 'call')}${rows ? `, ${rows} rows` : ''}, ${ms} ms`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${g.label} (${stats})`);
    for (const f of findings.values()) {
      const lines = describeReport(build, f.report);
      console.log(`        ASan ${lines[0]}`);
      for (const l of lines.slice(1)) console.log(`        ${l}`);
      console.log(`          ${fmtCount(f.count, 'report')}; first in: ${f.cases.join(' | ')}`);
    }
    for (const m of mismatches.slice(0, 5)) console.log(`        differs from the shipped kernel: ${m.label}: ${m.text}`);
    if (mismatches.length > 5) console.log(`        ... and ${mismatches.length - 5} more cases that differ`);
    for (const e of errors.slice(0, 5)) console.log(`        error in ${e.label}: ${e.error?.stack?.split('\n').slice(0, 3).join(' | ') ?? e.error}`);
    if (errors.length > 5) console.log(`        ... and ${errors.length - 5} more errors`);
    if (errors.length) {
      // A case that threw may have left its arrays allocated.
      session.freeAll();
    }
  }
  if (session.instances > 1) console.log(`  (${session.instances} module instances: a fresh one after a call that wrote into a redzone)`);
  return allPassed;
}

async function main() {
  const specs = parseArgs(process.argv.slice(2));
  fs.mkdirSync(asanResults, { recursive: true });
  let ok = true;
  for (const spec of specs) {
    const log = [];
    try {
      ok = (await runKernel(spec, log)) && ok;
    } catch (err) {
      ok = false;
      console.log(`\n${spec.name}: ${err?.stack ?? err}`);
    }
    const file = path.join(asanResults, `${spec.name}${spec.rev && spec.name !== 'canary' ? `@${revHash(spec.rev)}` : ''}.log`);
    if (log.length && spec.name !== 'canary') {
      fs.writeFileSync(file, `${log.join('\n')}\n`);
      console.log(`  ASan's full reports: ${path.relative(repoRoot, file)}`);
    } else if (fs.existsSync(file)) {
      fs.rmSync(file);
    }
  }
  console.log(ok ? '\nASan: every group passed' : '\nASan: some groups FAILED');
  process.exitCode = ok ? 0 : 1;
}

// The collector runs between module instances (asanSession.mjs reset): this script runs itself with --expose-gc.
if (typeof globalThis.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} else {
  main();
}
