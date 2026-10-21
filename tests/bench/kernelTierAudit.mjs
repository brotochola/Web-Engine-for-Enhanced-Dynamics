/**
 * Which tier does each kernel time? (review N-28)
 *
 * Runs kernels under `--trace-opt` and lists the shipped functions (defined in
 * src/) whose only TurboFan code was an OSR compile. Such a kernel times code
 * entered mid-loop, which a per-frame call never runs: OSR code does not fold
 * module-level consts and was 46 % slower on colliderFillPackMicrobench's
 * CLite case. A per-frame function should warm up through short calls so a
 * normal compile exists before the timed loop.
 *
 *   node tests/bench/kernelTierAudit.mjs                     # every *Microbench.mjs
 *   node tests/bench/kernelTierAudit.mjs angularSweep compoundSolid   # names containing these
 *   node tests/bench/kernelTierAudit.mjs --jobs 4 --output audit.json
 *
 * Reported: a function some src/ file defines, that the bench does not define
 * itself, whose TurboFan code was only ever OSR, and that no normally compiled
 * function inlined. A setup helper called once with a loop inside still shows
 * up (it is not timed); check the bench before changing it. Timings are
 * meaningless here: the traces print during the run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchDir, '../..');

const argv = process.argv.slice(2);
let jobs = 4;
let output = null;
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--jobs') jobs = Math.max(1, Number(argv[++i]) || 1);
  else if (argv[i] === '--output') output = argv[++i];
  else filters.push(argv[i]);
}

/** Names of functions and methods defined anywhere in src/. */
function srcFunctionNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'vendor') walk(p);
      } else if (e.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        for (const m of s.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
        for (const m of s.matchAll(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
          if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) names.add(m[1]);
        }
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  return names;
}

const COMPILE_RE = /\[compiling method [^<]*<JSFunction ([^ >]+)[^>]*> \(target (TURBOFAN|MAGLEV)\)( OSR)?/;
const INLINE_RE = /^Inlining .*<SharedFunctionInfo ([^>]+)>.* into .*<SharedFunctionInfo ([^>]+)>/;

/** Names the bench file defines itself: they shadow any src function of that name. */
function benchLocalNames(file) {
  const s = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of s.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

function auditOne(file) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `kernel-tier-${process.pid}-${path.basename(file)}.json`);
    const child = spawn(process.execPath, ['--trace-opt', '--trace-turbo-inlining', file, '--output', out], { cwd: repoRoot });
    const tiers = new Map();
    // Inlined into a normal (non-OSR) TurboFan compile: the timed code may well be that one.
    const inlinedNormal = new Set();
    let compiling = null;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const inl = line.match(INLINE_RE);
        if (inl) {
          if (compiling && !compiling.osr && compiling.name === inl[2]) inlinedNormal.add(inl[1]);
          continue;
        }
        const m = line.match(COMPILE_RE);
        if (!m) continue;
        compiling = { name: m[1], osr: Boolean(m[3]) };
        if (m[2] !== 'TURBOFAN') continue;
        const t = tiers.get(m[1]) || { normal: 0, osr: 0 };
        if (m[3]) t.osr++;
        else t.normal++;
        tiers.set(m[1], t);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(out, { force: true });
      resolve({ file, code, tiers, inlinedNormal });
    });
  });
}

const srcNames = srcFunctionNames();
const files = fs.readdirSync(benchDir)
  .filter((f) => f.endsWith('Microbench.mjs'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
  .map((f) => path.join(benchDir, f));

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const r = await auditOne(file);
    const local = benchLocalNames(r.file);
    const osrOnly = [...r.tiers]
      .filter(([name, t]) => t.osr > 0 && t.normal === 0 && srcNames.has(name) && !local.has(name) && !r.inlinedNormal.has(name))
      .map(([name]) => name)
      .sort();
    results.push({ bench: path.basename(r.file), exit: r.code, osrOnly });
    console.log(`${path.basename(r.file)}${r.code ? ` (exit ${r.code})` : ''}: ${osrOnly.length ? 'OSR only: ' + osrOnly.join(', ') : 'ok'}`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
results.sort((a, b) => a.bench.localeCompare(b.bench));
if (output) fs.writeFileSync(output, JSON.stringify(results, null, 2));
const flagged = results.filter((r) => r.osrOnly.length);
console.log(`\n${flagged.length} of ${results.length} kernels time a src function only through OSR code.`);
