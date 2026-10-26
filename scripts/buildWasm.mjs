#!/usr/bin/env node
/**
 * Build the engine's WebAssembly kernels (E-76 T2), freestanding C to wasm32 with clang.
 *
 *   node scripts/buildWasm.mjs                  build every module into its `output` path
 *   node scripts/buildWasm.mjs --only <name>    one module
 *   node scripts/buildWasm.mjs --check          rebuild into tests/results/wasm-build/ and compare
 *                                               bytes with the committed binaries; exit 1 on any
 *                                               difference or kernel-rule problem
 *   node scripts/buildWasm.mjs --llvm-bin <dir> use that clang / wasm-ld / wasm-opt
 *
 * Modules are listed in wasm/modules.json. No Emscripten runtime: clang compiles each source with
 * pinned flags, wasm-ld links it with the shared memory imported, wasm-opt optimizes it and keeps
 * only the name section (so Chrome profiles name the functions). Every built module must pass the
 * kernel rules in scripts/wasmKernelRules.mjs: one import (the shared memory), only the listed
 * function exports, no start function, globals, data, tables or own memory.
 *
 * The toolchain is the emsdk the Box2D build already uses, found the way
 * Box2d_3.2_C_-_liquidfun/weedjs/build_for_weed.bat finds it: the sibling repo's emsdk\, then
 * %EMSDK%. Only emsdk's upstream/bin is used (clang, wasm-ld, wasm-opt); no emsdk_env, no emcc.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { kernelRuleProblems } from './wasmKernelRules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'wasm', 'modules.json');

/** Compile flags, pinned. Doubles stay doubles: no -ffast-math, no FMA contraction. */
export const CLANG_FLAGS = [
  '--target=wasm32',
  '-std=c11',
  '-O3',
  '-msimd128',
  '-matomics',
  '-mbulk-memory',
  '-nostdlib',
  '-ffreestanding',
  '-ffp-contract=off',
  '-Wall',
  '-Werror',
];

/** Link flags, pinned; --max-memory comes from the manifest. */
export const LINK_FLAGS = ['--no-entry', '--import-memory', '--shared-memory'];

/** wasm-opt flags, pinned. Reads the features from the target_features section, then strips it. */
export const OPT_FLAGS = ['-O3', '-g', '--strip-producers', '--strip-target-features'];

function parseArgs(argv) {
  const out = { check: false, only: null, llvmBin: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--only' && argv[i + 1]) out.only = argv[++i];
    else if (a === '--llvm-bin' && argv[i + 1]) out.llvmBin = path.resolve(argv[++i]);
    else throw new Error(`buildWasm: unknown argument ${a}`);
  }
  return out;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Candidate emsdk upstream/bin directories, in the order build_for_weed.bat uses. */
export function toolchainCandidates(env = process.env) {
  const dirs = [path.resolve(root, '..', 'Box2d_3.2_C_-_liquidfun', 'emsdk', 'upstream', 'bin')];
  if (env.EMSDK) dirs.push(path.resolve(env.EMSDK, 'upstream', 'bin'));
  return dirs;
}

function findToolchain(explicit) {
  const dirs = explicit ? [explicit] : toolchainCandidates();
  for (const dir of dirs) {
    if (['clang', 'wasm-ld', 'wasm-opt'].every((t) => fs.existsSync(path.join(dir, exe(t))))) {
      return {
        dir,
        clang: path.join(dir, exe('clang')),
        wasmLd: path.join(dir, exe('wasm-ld')),
        wasmOpt: path.join(dir, exe('wasm-opt')),
      };
    }
  }
  throw new Error(
    `buildWasm: no clang, wasm-ld and wasm-opt found in:\n  ${dirs.join('\n  ')}\n` +
      'Install emsdk in the sibling Box2d_3.2_C_-_liquidfun\\emsdk, set %EMSDK%, or pass --llvm-bin <dir>.',
  );
}

function firstLine(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}

function versionWarnings(tools, pinned) {
  const warnings = [];
  const clangVersion = firstLine(tools.clang, ['--version']);
  const optVersion = firstLine(tools.wasmOpt, ['--version']);
  if (!pinned.clang.every((s) => clangVersion.includes(s))) {
    warnings.push(`clang is "${clangVersion}"; the binaries were built with ${pinned.clang.join(' ')}`);
  }
  if (!pinned.wasmOpt.every((s) => optVersion.includes(s))) {
    warnings.push(`wasm-opt is "${optVersion}"; the binaries were built with ${pinned.wasmOpt.join(' ')}`);
  }
  return { clangVersion, optVersion, warnings };
}

function run(file, args) {
  try {
    execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new Error(`${path.basename(file)} failed:\n${text}`);
  }
}

/** A module's C sources: `sources` (the engine module, every kernel linked into one) or its one `source`. */
export function moduleSources(mod) {
  return mod.sources || [mod.source];
}

/** Compile, link and optimize one module into workDir; returns the bytes. */
export function buildModule(tools, mod, workDir) {
  // The linked file's name becomes the module name in the name section: keep it <name>.wasm.
  fs.mkdirSync(path.join(workDir, 'link'), { recursive: true });
  const objs = moduleSources(mod).map((source) => {
    const obj = path.join(workDir, `${path.basename(source, '.c')}.o`);
    run(tools.clang, [...CLANG_FLAGS, '-c', path.join(root, source), '-o', obj]);
    return obj;
  });
  const linked = path.join(workDir, 'link', `${mod.name}.wasm`);
  const out = path.join(workDir, `${mod.name}.wasm`);
  run(tools.wasmLd, [...LINK_FLAGS, `--max-memory=${mod.maxMemoryPages * 65536}`, '-o', linked, ...objs]);
  run(tools.wasmOpt, [...OPT_FLAGS, linked, '-o', out]);
  return fs.readFileSync(out);
}

const kb = (n) => `${n} B`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const modules = manifest.modules.filter((m) => !args.only || m.name === args.only);
  if (!modules.length) throw new Error(`buildWasm: no module named ${args.only}`);

  const tools = findToolchain(args.llvmBin);
  const versions = versionWarnings(tools, manifest.toolchain);
  console.log(`toolchain ${tools.dir}`);
  console.log(`  ${versions.clangVersion}`);
  console.log(`  ${versions.optVersion}`);
  for (const w of versions.warnings) console.warn(`  warning: ${w} (bytes may differ)`);

  const workRoot = path.join(root, 'tests', 'results', 'wasm-build');
  let failed = 0;
  for (const mod of modules) {
    const outputPath = path.join(root, mod.output);
    const committed = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
    const spec = { exports: mod.exports, maxMemoryPages: mod.maxMemoryPages, names: true };

    if (mod.builtBy) {
      // Not built by this script: nothing to rebuild or compare. Report its rule problems.
      const problems = committed ? kernelRuleProblems(committed, spec) : ['missing'];
      console.log(`\n${mod.name}: not built by this script (${mod.builtBy})`);
      console.log(`  ${mod.output} ${committed ? kb(committed.length) : 'missing'}`);
      for (const p of problems) console.log(`  rule: ${p}`);
      if (args.check && problems.length) failed++;
      continue;
    }

    const bytes = buildModule(tools, mod, path.join(workRoot, mod.name));
    const problems = kernelRuleProblems(bytes, spec);
    const gz = zlib.gzipSync(bytes, { level: 9 }).length;
    const from = moduleSources(mod);
    console.log(`\n${mod.name}: ${kb(bytes.length)} (${kb(gz)} gzip) from ${from.length > 1 ? `${from.length} sources` : from[0]}`);
    for (const p of problems) console.log(`  rule: ${p}`);
    if (problems.length) {
      failed++;
      continue;
    }
    if (args.check) {
      if (!committed) {
        console.log(`  ${mod.output} is missing`);
        failed++;
      } else if (Buffer.compare(bytes, committed) !== 0) {
        console.log(`  DIFFERS from ${mod.output} (${kb(committed.length)}): rebuild and commit it`);
        failed++;
      } else {
        console.log(`  identical to ${mod.output}`);
      }
    } else if (committed && Buffer.compare(bytes, committed) === 0) {
      console.log(`  ${mod.output} unchanged`);
    } else {
      fs.writeFileSync(outputPath, bytes);
      console.log(`  wrote ${mod.output}${committed ? ` (was ${kb(committed.length)})` : ''}`);
    }
  }
  if (failed) {
    console.error(`\nbuildWasm: ${failed} module(s) failed`);
    process.exitCode = 1;
  }
}

// Case-insensitive on Windows: a drive letter or folder typed in another case is the same file.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
