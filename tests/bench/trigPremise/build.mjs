#!/usr/bin/env node
/**
 * Build trigQ2.wasm for the Q2 premise (E-76): musl's FreeBSD-derived atan, sin, cos and asin, and
 * V8's own atan2 branch, compiled with the engine's pinned clang flags (minus -Werror, for musl's
 * code) against the libm shim in shim/ and musl's math sources from the emsdk the engine uses. It
 * is not a kernel: sin/cos need a stack (the reduction passes y[2] by address), so it links a
 * 64 KB stack first in memory and is outside wasm/modules.json and the T6 rules.
 *
 *   node tests/bench/trigPremise/build.mjs        (the committed trigQ2.wasm came from this)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLANG_FLAGS, LINK_FLAGS, OPT_FLAGS, toolchainCandidates } from '../../../scripts/buildWasm.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = toolchainCandidates().find((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'clang.exe' : 'clang')));
if (!bin) throw new Error('no emsdk clang found (see scripts/buildWasm.mjs)');
const exe = (t) => path.join(bin, process.platform === 'win32' ? `${t}.exe` : t);
const musl = path.resolve(bin, '..', 'emscripten', 'system', 'lib', 'libc', 'musl', 'src', 'math');
const work = path.join(dir, '..', '..', 'results', 'trig-premise-build');
fs.mkdirSync(path.join(work, 'link'), { recursive: true });
const obj = path.join(work, 'trigQ2.o');
const linked = path.join(work, 'link', 'trigQ2.wasm');
const out = path.join(dir, 'trigQ2.wasm');
execFileSync(exe('clang'), [...CLANG_FLAGS.filter((f) => f !== '-Werror'), '-Wno-unused-variable', '-I', path.join(dir, 'shim'), '-I', musl, '-c', path.join(dir, 'trigQ2.c'), '-o', obj], { stdio: 'inherit' });
execFileSync(exe('wasm-ld'), [...LINK_FLAGS, '--stack-first', '-z', 'stack-size=65536', `--max-memory=${8192 * 65536}`, '-o', linked, obj], { stdio: 'inherit' });
execFileSync(exe('wasm-opt'), [...OPT_FLAGS, linked, '-o', out], { stdio: 'inherit' });
console.log(`trigQ2.wasm ${fs.statSync(out).size} bytes`);
