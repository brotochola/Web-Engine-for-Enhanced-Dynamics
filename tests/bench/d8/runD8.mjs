#!/usr/bin/env node
/**
 * The machine code V8 makes of a kernel, in d8 (Chrome's V8; a release Chrome has no disassembler): fetches d8 for this
 * machine, bundles each kernel for it (build.mjs), runs it with --print-opt-code and summarizes what TurboFan and
 * Maglev made of each function (asmD8.mjs).
 *
 *   node tests/bench/d8/runD8.mjs --kernels tests/bench/astarKernel.mjs,tests/bench/x.mjs [--filter regex] [--release]
 *        [--out dir] [--output result.json]
 *
 * --filter: the functions whose code is kept in <out>/<kernel>/asm.txt (all of it is summarized; the dump is large).
 * --release: no machine code, the kernel's own report with --output left out: d8's timing (V8 16 against Node's 12).
 * Debug builds (the ones with a disassembler) exist for linux x64, mac and win x64, and for mac arm64: ARM's code comes
 * from a Mac. linux arm64 has the release build alone.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs } from '../microbenchHelpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const BUCKET = 'https://storage.googleapis.com/chromium-v8/official/canary';
const PLATFORM = {
  'linux-x64': 'linux64', 'linux-arm64': 'linux-arm64', 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac64', 'win32-x64': 'win64',
};
const RUN_TIMEOUT_MS = 20 * 60000;

/** d8 for this machine, downloaded once: { exe, version }. $WEED_D8 (or $WEED_D8_DEBUG) names one already here. */
async function ensureD8(release) {
  const own = release ? process.env.WEED_D8 : process.env.WEED_D8_DEBUG;
  if (own) return { exe: own, version: 'local' };
  const platform = PLATFORM[`${os.platform()}-${os.arch()}`];
  if (!platform) throw new Error(`no d8 build for ${os.platform()} ${os.arch()}`);
  const name = `v8-${platform}-${release ? 'rel' : 'dbg'}`;
  const latest = await fetch(`${BUCKET}/${name}-latest.json`);
  if (!latest.ok) throw new Error(`${name}: ${latest.status}`);
  const { version } = await latest.json();
  const dir = path.join(os.tmpdir(), `${name}-${version}`);
  const exe = path.join(dir, os.platform() === 'win32' ? 'd8.exe' : 'd8');
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'd8.zip');
    const r = await fetch(`${BUCKET}/${name}-${version}.zip`);
    if (!r.ok) throw new Error(`${name}-${version}.zip: ${r.status}`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    // bsdtar (Windows, macOS) reads zip files; Linux has unzip.
    if (os.platform() === 'linux') execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
    else execFileSync('tar', ['-xf', zip, '-C', dir]);
    fs.rmSync(zip);
    if (os.platform() !== 'win32') fs.chmodSync(exe, 0o755);
  }
  return { exe, version };
}

/** The optimized code objects of a dump whose function name matches. */
function keepMatching(text, re) {
  return text.split('--- Optimized code ---').slice(1)
    .filter((chunk) => re.test(/^name = (.*)$/m.exec(chunk)?.[1] || ''))
    .map((chunk) => `--- Optimized code ---${chunk.split('--- End code ---')[0]}--- End code ---\n`).join('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const release = Boolean(args.release);
  const { exe, version } = await ensureD8(release);
  const outDir = path.resolve(String(args.out ?? (args.output ? path.join(path.dirname(String(args.output)), 'd8') : 'tests/results/d8')));
  const filter = args.filter ? new RegExp(String(args.filter)) : null;
  const result = { kind: 'd8', version, release, arch: os.arch(), rows: [] };
  console.log(`d8 ${version} ${release ? 'release' : 'debug'} ${exe}`);
  for (const spec of String(args.kernels).split(',')) {
    const [kernel, ...kernelArgs] = spec.split('+');
    const name = path.basename(kernel, '.mjs');
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = path.join(dir, 'kernel.mjs');
    const built = spawnSync(process.execPath, [path.join(here, 'build.mjs'), kernel, bundle, ...kernelArgs], { cwd: root, encoding: 'utf8' });
    const row = { kernel, name };
    result.rows.push(row);
    if (built.status !== 0) {
      row.error = `build: ${(built.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`;
      console.log(`${name}: ${row.error}`);
      continue;
    }
    // N-235: without the first two flags d8 16 starved its background threads on the 4800H.
    const flags = ['--concurrent-maglev-high-priority-threads', '--single-threaded-gc',
      ...(release ? [] : ['--no-debug-code', '--print-opt-code', '--code-comments'])];
    const t0 = performance.now();
    const r = spawnSync(exe, [...flags, bundle], { cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 30 });
    row.seconds = +((performance.now() - t0) / 1000).toFixed(1);
    row.status = r.status ?? r.signal;
    const text = r.stdout || '';
    if (release) {
      row.output = text.slice(-4000);
    } else {
      const dump = path.join(dir, 'dump.txt');
      fs.writeFileSync(dump, text);
      const summary = spawnSync(process.execPath, [path.join(here, 'asmD8.mjs'), dump, '--min', '100', '--json', path.join(dir, 'summary.json')],
        { encoding: 'utf8', maxBuffer: 64 << 20 });
      fs.writeFileSync(path.join(dir, 'summary.txt'), summary.stdout || summary.stderr || '');
      if (filter) fs.writeFileSync(path.join(dir, 'asm.txt'), keepMatching(text, filter).slice(0, 4 << 20));
      row.functions = (summary.stdout || '').split('\n').filter((l) => l.startsWith('## ')).length;
      fs.rmSync(dump);
    }
    fs.rmSync(bundle);
    if (row.status !== 0) row.error = (r.stderr || text).trim().split('\n').slice(-5).join(' | ').slice(0, 600);
    console.log(`${name}: exit ${row.status}, ${row.seconds} s${row.functions ? `, ${row.functions} optimized functions` : ''}${row.error ? ` ${row.error}` : ''}`);
  }
  if (args.output) fs.writeFileSync(path.resolve(String(args.output)), `${JSON.stringify(result, null, 1)}\n`);
}

if (isCli(import.meta.url)) await main();
