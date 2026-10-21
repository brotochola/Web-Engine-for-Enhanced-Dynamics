#!/usr/bin/env node
/**
 * Map Chrome `wasm-function[N]` indices from the shipped box2dWasm.wasm
 * back to C export names when the function is exported, and to a call/atomic
 * profile when it is internal. The shipped binary has no `name` custom section
 * (LTO). Chrome's index includes imports; binaryen `$k` is defined-only, so
 * `$k` = chromeIndex - importFunctionCount.
 *
 * Indices belong to one build: take them from a trace of the box2dWasm.wasm
 * that is in the tree now.
 *
 *   node tests/bench/mapWasmFunctions.mjs --indices 102,285,39
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WASM = path.join(repoRoot, 'src/box2d/box2dWasm.wasm');
const JS = path.join(repoRoot, 'src/box2d/box2dWasm.js');
const WAT = path.join(repoRoot, 'tests/results/wasm-map/box2d.wat');
const OUT = path.join(repoRoot, 'tests/results/wasm-map/indices.md');
const WASM_DIS = path.resolve(
  repoRoot,
  '../Box2d_3.2_C_-_liquidfun/emsdk/upstream/bin/wasm-dis.exe',
);

// The disassembly is cached; a wasm rebuilt after it makes it a different binary.
function ensureWat() {
  if (fs.existsSync(WAT) && fs.statSync(WAT).size > 1000 && fs.statSync(WAT).mtimeMs >= fs.statSync(WASM).mtimeMs) return;
  if (!fs.existsSync(WASM_DIS)) throw new Error(`wasm-dis missing: ${WASM_DIS}`);
  fs.mkdirSync(path.dirname(WAT), { recursive: true });
  execFileSync(WASM_DIS, [WASM, '-o', WAT], { stdio: 'inherit' });
}

function parseCExports(js) {
  const map = new Map();
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(js))) map.set(m[2], m[1]);
  return map;
}

// LTO minifies import names (`a.b`); the glue's assignWasmImports says what each is.
function parseImportNames(js) {
  const map = new Map();
  const block = js.match(/function assignWasmImports\(\)\s*\{([\s\S]*?)\n\}/);
  if (!block) return map;
  const re = /(\w+):\s*(\w+)/g;
  let m;
  while ((m = re.exec(block[1]))) map.set(m[1], m[2]);
  return map;
}

function parseWat(text) {
  const lines = text.split('\n');
  const funcLine = [];
  const exportToFunc = new Map();
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.startsWith(' (func ')) funcLine.push(i);
    const exp = s.match(/^\s*\(export "([^"]+)" \(func \$(\d+)\)\)/);
    if (exp) exportToFunc.set(exp[1], Number(exp[2]));
  }
  return { lines, funcLine, exportToFunc };
}

function profile(lines, funcLine, definedIndex, nowCall) {
  const start = funcLine[definedIndex];
  const end = funcLine[definedIndex + 1] ?? lines.length;
  const body = lines.slice(start, end);
  const calls = new Map();
  let atomic = 0;
  let loops = 0;
  let nowCalls = 0;
  let waits = 0;
  for (const line of body) {
    if (line.includes('atomic')) atomic++;
    if (line.includes('loop ')) loops++;
    if (nowCall && line.includes(nowCall)) nowCalls++;
    if (line.includes('atomic.wait')) waits++;
    const c = line.match(/call \$(\d+)/);
    if (c) {
      const id = Number(c[1]);
      calls.set(id, (calls.get(id) || 0) + 1);
    }
  }
  const top = [...calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    line: start + 1,
    lines: body.length,
    atomic,
    loops,
    nowCalls,
    waits,
    top,
    head: lines[start].trim(),
  };
}

function main() {
  const args = parseArgs();
  const hot = args.indices === undefined || args.indices === true
    ? []
    : String(args.indices).split(',').map((n) => Number(n)).filter(Number.isInteger);
  if (!hot.length) {
    console.error(
      'usage: node tests/bench/mapWasmFunctions.mjs --indices 102,285,39\n' +
        'Indices belong to one build: take them from a trace of the current box2dWasm.wasm.',
    );
    process.exit(1);
  }
  ensureWat();
  const wasm = fs.readFileSync(WASM);
  const mod = new WebAssembly.Module(wasm);
  const importFuncs = WebAssembly.Module.imports(mod).filter((i) => i.kind === 'function');
  const nameSections = WebAssembly.Module.customSections(mod, 'name');
  const glue = fs.readFileSync(JS, 'utf8');
  const cByExport = parseCExports(glue);
  const importNames = parseImportNames(glue);
  const nowIndex = importFuncs.findIndex((imp) => importNames.get(imp.name) === '_emscripten_get_now');
  const nowCall = nowIndex >= 0 ? `call $fimport$${nowIndex}` : null;
  const { lines, funcLine, exportToFunc } = parseWat(fs.readFileSync(WAT, 'utf8'));

  const cByDefined = new Map();
  for (const [exp, cname] of cByExport) {
    const defined = exportToFunc.get(exp);
    if (defined !== undefined) cByDefined.set(defined, cname);
  }

  const importLines = importFuncs.map((imp, i) => {
    const js = importNames.get(imp.name);
    return `- import[${i}] \`${imp.module}.${imp.name}\`${js ? ` = \`${js}\`` : ''}`;
  });

  const nowRank = [];
  for (let i = 0; i < funcLine.length; i++) {
    const p = profile(lines, funcLine, i, nowCall);
    if (p.nowCalls || p.waits) nowRank.push({ defined: i, chrome: i + importFuncs.length, ...p });
  }
  nowRank.sort((a, b) => (b.nowCalls + b.waits) - (a.nowCalls + a.waits));

  const rows = [];
  for (const chrome of hot) {
    const defined = chrome - importFuncs.length;
    const ok = defined >= 0 && defined < funcLine.length;
    const p = ok ? profile(lines, funcLine, defined, nowCall) : null;
    const cname = cByDefined.get(defined);
    let kind = 'internal';
    if (cname) kind = `export ${cname}`;
    else if (p && p.atomic > 20 && p.loops > 0) kind = 'atomic loop (solver spin / mailbox candidate)';
    else if (p && p.loops > 2) kind = 'loop-heavy internal';
    rows.push({ chrome, defined, cname, kind, p });
  }

  const linesOut = [];
  linesOut.push('# wasm-function map (shipped box2dWasm.wasm)');
  linesOut.push('');
  linesOut.push(`Binary: \`src/box2d/box2dWasm.wasm\` (${wasm.byteLength} bytes).`);
  linesOut.push(`Name section: ${nameSections.length === 0 ? 'absent (LTO stripped names)' : `${nameSections.length} section(s)`}.`);
  linesOut.push(`Import functions: ${importFuncs.length}. Chrome \`wasm-function[N]\` includes imports, so defined index = N - ${importFuncs.length}, which is binaryen \`$index\` in \`box2d.wat\`.`);
  linesOut.push('');
  linesOut.push('## Imports');
  linesOut.push(...importLines);
  linesOut.push('');
  linesOut.push('## Requested indices');
  linesOut.push('');
  linesOut.push('| chrome | defined $ | C export | kind | atomic | loops | get_now | atomic.wait | wat lines | top callees |');
  linesOut.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const top = r.p ? r.p.top.map(([id, n]) => `$${id}×${n}`).join(', ') : '';
    const p = r.p;
    linesOut.push(`| ${r.chrome} | ${r.defined} | ${r.cname || ''} | ${r.kind} | ${p ? p.atomic : ''} | ${p ? p.loops : ''} | ${p ? p.nowCalls : ''} | ${p ? p.waits : ''} | ${p ? p.lines : ''} | ${top} |`);
  }
  linesOut.push('');
  linesOut.push(`## Functions that call \`_emscripten_get_now\` (${nowCall ? `\`$fimport$${nowIndex}\`` : 'not imported'}) or wait (\`memory.atomic.wait\`)`);
  linesOut.push('');
  linesOut.push('| chrome | defined $ | C export | get_now | atomic.wait | atomic | loops |');
  linesOut.push('|---|---|---|---|---|---|---|');
  for (const r of nowRank.slice(0, 12)) {
    linesOut.push(`| ${r.chrome} | ${r.defined} | ${cByDefined.get(r.defined) || ''} | ${r.nowCalls} | ${r.waits} | ${r.atomic} | ${r.loops} |`);
  }
  linesOut.push('');
  linesOut.push('## Notes');
  linesOut.push('');
  linesOut.push('- An import is not a defined function. A pthread whose samples land in `wasm-function[N]` is inside a defined function; `_emscripten_get_now` shows up as its own JS frame when the import is called.');
  linesOut.push('- What the 2026-10-01 build\'s hot indices turned out to be (the pool thread parked in the mailbox, the solver spinner) is in HYPOTHESIS_LOG, "Trace after-keeps". Those indices do not carry over to another build.');
  linesOut.push('- Do not rebuild with `-g` and then A/B that wasm: LTO changes indices and the speed.');
  linesOut.push('');

  const spin = rows.filter((r) => r.p && r.p.atomic > 20 && r.p.loops > 0 && !r.cname);
  if (spin.length) {
    linesOut.push('## Spin candidates (internal, many atomic ops, has a loop)');
    linesOut.push('');
    for (const r of spin) {
      linesOut.push(`- chrome ${r.chrome} = $${r.defined}, ${r.p.lines} wat lines, atomic ${r.p.atomic}, loops ${r.p.loops}, head \`${r.p.head}\``);
    }
    linesOut.push('');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, linesOut.join('\n'));
  console.log(linesOut.join('\n'));
  console.log(`\nWrote ${OUT}`);
}

if (isCli(import.meta.url)) main();
