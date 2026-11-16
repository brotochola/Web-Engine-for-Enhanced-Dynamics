/**
 * The AddressSanitizer build of the engine's wasm kernels (tests/asan/runAsan.mjs builds through it).
 *
 * The shipped build (scripts/buildWasm.mjs) links every kernel into one freestanding module that runs against one
 * shared memory the JS lays out by hand, so an overflow from one region lands silently in the next. This build compiles
 * a kernel's C source with emcc, with libc and -fsanitize=address, together with tests/asan/asanDriver.c (ASan's
 * options), into a module of its own that the harness drives from Node: each array a kernel takes is malloc'd there,
 * with ASan's redzones around it. It is never shipped; its output goes to tests/results/asan/ (gitignored).
 *
 * The module is a pthread build (-pthread, no thread is ever started) for one reason: its memory is then shared, so the
 * product's own clients (bindShadowStamp, bindGpuPack, ...) bind the shipped engine.wasm on it as they bind it on the
 * render-queue memory, and the harness runs the shipped kernel and the ASan one on the same arrays, at the same
 * addresses, and compares what they wrote.
 *
 * The toolchain is the emsdk scripts/buildWasm.mjs uses (the sibling Box2D repo's emsdk, else %EMSDK%), its emcc this
 * time. Emscripten's cache (the ASan runtime and libc it builds once, a few minutes) is EM_CACHE when set, else
 * tests/results/asan/em-cache.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolchainCandidates } from '../../scripts/buildWasm.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const asanResults = path.join(repoRoot, 'tests', 'results', 'asan');
const driverPath = path.join(repoRoot, 'tests', 'asan', 'asanDriver.c');

/**
 * Compile flags. The shipped build's semantics (C11, SIMD, bulk memory, no FMA contraction) so the kernel computes what
 * it ships computing; -O1 -g for ASan's frames; recover mode, so a call reports every bad access, not only the first.
 */
export const ASAN_CFLAGS = [
  '-std=c11',
  '-O1',
  '-g',
  '-msimd128',
  '-mbulk-memory',
  '-ffp-contract=off',
  '-fsanitize=address',
  '-fsanitize-recover=address',
  '-pthread',
  '-Wall',
];

/**
 * Link flags. A shared memory big enough that nothing grows it during a run (a grown shared memory hands out a new
 * buffer, and the clients compare buffers): ASan's shadow (an eighth of the maximum) and quarantine sit in it too. Not
 * much bigger: the harness starts a fresh module after a call that wrote into a redzone, and each holds its memory
 * until the collector frees it.
 */
export const ASAN_LFLAGS = [
  '-sENVIRONMENT=node',
  '-sMODULARIZE',
  '-sEXPORT_ES6',
  '-sPTHREAD_POOL_SIZE=0',
  '-sINITIAL_MEMORY=320MB',
  '-sMAXIMUM_MEMORY=1GB',
  '-sALLOW_MEMORY_GROWTH',
  '-sEXPORTED_RUNTIME_METHODS=HEAPU8,wasmMemory',
  '-Wno-pthreads-mem-growth',
];

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** The emsdk: emcc, the Python its launcher runs on Windows, llvm-symbolizer. */
export function findEmsdk() {
  const roots = toolchainCandidates().map((bin) => path.resolve(bin, '..', '..'));
  for (const root of roots) {
    const em = path.join(root, 'upstream', 'emscripten');
    const names = process.platform === 'win32' ? ['emcc.exe', 'emcc.bat'] : ['emcc'];
    const emcc = names.map((n) => path.join(em, n)).find((p) => fs.existsSync(p));
    if (!emcc) continue;
    let python = process.env.EMSDK_PYTHON || null;
    const pyDir = path.join(root, 'python');
    if (!python && process.platform === 'win32' && fs.existsSync(pyDir)) {
      const found = fs.readdirSync(pyDir).map((d) => path.join(pyDir, d, 'python.exe')).find((p) => fs.existsSync(p));
      if (found) python = found;
    }
    return {
      root,
      emcc,
      python,
      symbolizer: path.join(root, 'upstream', 'bin', exe('llvm-symbolizer')),
    };
  }
  throw new Error(`asanBuild: no emcc in the emsdk at:\n  ${roots.join('\n  ')}\n`
    + 'Install emsdk in the sibling Box2d_3.2_C_-_liquidfun\\emsdk or set %EMSDK%.');
}

/** A source's C text: the working tree's file, or `git show rev:path` for a revision. */
function sourceText(source, rev) {
  if (!rev) return fs.readFileSync(path.join(repoRoot, source), 'utf8');
  return execFileSync('git', ['-C', repoRoot, 'show', `${rev}:${source}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** A revision's short hash (the build directory's name). */
export function revHash(rev) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short=8', `${rev}^{commit}`], { encoding: 'utf8' }).trim();
}

/**
 * Build kernel `name` from `sources` (repo paths) at revision `rev` (null: the working tree) with ASan, unless the
 * build directory already holds a build of the same inputs.
 * @param {{ name: string, sources: string[], exports: string[], rev?: string | null, log?: (s: string) => void }} spec
 * @returns {{ name: string, dir: string, mjs: string, wasm: string, rev: string | null, srcDir: string, built: boolean,
 *   sources: Array<{ repoPath: string, file: string }> }}
 */
export function buildAsanKernel({ name, sources, exports, rev = null, log = () => {} }) {
  const tag = rev ? `${name}@${revHash(rev)}` : name;
  const dir = path.join(asanResults, tag);
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  // The sources are copied into the build directory (a revision's are not on disk at all), so ASan's frames name
  // files there: the report maps them back to their repo paths.
  const files = sources.map((repoPath) => {
    const file = path.join(srcDir, path.basename(repoPath));
    const text = sourceText(repoPath, rev);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    return { repoPath, file };
  });
  const tools = findEmsdk();
  // memalign: a region the product aligns to its cache line (a placed memory checks it) gets the same alignment here.
  const exported = ['_malloc', '_memalign', '_free', ...exports.map((e) => `_${e}`)];
  const args = [
    ...ASAN_CFLAGS,
    ...files.map((f) => f.file),
    driverPath,
    '-o', path.join(dir, `${name}.mjs`),
    ...ASAN_LFLAGS,
    `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  ];
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ args: args.map((a) => path.relative(dir, a)), emcc: tools.emcc }));
  for (const f of [...files.map((x) => x.file), driverPath]) hash.update(fs.readFileSync(f));
  const digest = hash.digest('hex');
  const stamp = path.join(dir, 'build.json');
  const mjs = path.join(dir, `${name}.mjs`);
  const wasm = path.join(dir, `${name}.wasm`);
  const out = { name, dir, mjs, wasm, rev, srcDir, sources: files, built: false };
  if (fs.existsSync(stamp) && fs.existsSync(mjs) && fs.existsSync(wasm)) {
    try {
      if (JSON.parse(fs.readFileSync(stamp, 'utf8')).digest === digest) return out;
    } catch { /* rebuild */ }
  }
  const env = { ...process.env };
  if (tools.python && !env.EMSDK_PYTHON) env.EMSDK_PYTHON = tools.python;
  if (!env.EM_CACHE) env.EM_CACHE = path.join(asanResults, 'em-cache');
  log(`building ${tag} with ASan (emcc ${path.relative(repoRoot, tools.emcc) || tools.emcc}; cache ${env.EM_CACHE})`);
  try {
    execFileSync(tools.emcc, args, { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new Error(`asanBuild: emcc failed for ${tag}:\n${text}`);
  }
  fs.writeFileSync(stamp, JSON.stringify({ digest, rev, sources }, null, 2));
  out.built = true;
  return out;
}
