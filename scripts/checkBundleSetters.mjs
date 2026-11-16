#!/usr/bin/env node
/**
 * N-234: the bytecode V8 makes for GameObject's per-frame setters in the shipped bundles, not in src/.
 *
 * setterBytecodeSize.test.js measures the setters from source, but the bundle build changes them: an operand past a
 * module's 255th slot takes 4 bytes more (E-459's set x: 58 bytes from source, 62 in the bundle), and terser wrote a
 * function with one caller into it as a closure made at each call (E-469). V8 inlines a setter whatever its caller's
 * budget when the call passes a heap number and the setter's own bytecode is 75 bytes or less
 * (--max-inlined-bytecode-size-small-with-heapnum-in-out, Chrome 157's V8 15.7 and V8 16); past that, a caller out of
 * budget calls it and boxes the double.
 *
 * For each bundle: the worker sources it embeds (gzip+base64 in the compressed ones), the one that defines class
 * GameObject, compiled whole by d8 with --no-lazy --print-bytecode (every function's bytecode at compile time, nothing
 * run), and each setter told from other classes' functions of the same name by its source positions. A setter fails
 * past 75 bytes or when its bytecode makes a closure (CreateClosure). The src column is this Node's bytecode of the
 * same setter from source (setterBytecodeDriver.mjs, as the test reads it), for the bundle's growth.
 *
 *   node scripts/checkBundleSetters.mjs [--bundle dist/<file> ...] [--d8 <v8.exe>] [--json <out.json>]
 *
 * Default bundles: the raw prod and debug ESM ones. d8: --d8, else $WEED_D8, else D:/perf-tools/v8/release/v8.exe;
 * without one it uses this Node's V8 and says so (another V8 can size bytecode differently).
 * Exit 0 when every setter passes, 1 when one fails, 2 when the check cannot run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The setters setterBytecodeSize.test.js names, by the name V8 prints. */
export const SETTERS = [
  'set x',
  'set y',
  'set vx',
  'set vy',
  'set angularVelocity',
  'set alpha',
  'setAlpha',
  'setAnimationSpeed',
  'setPosition',
  'setVelocity',
  'setScale',
];
/** V8's --max-inlined-bytecode-size-small-with-heapnum-in-out default. */
export const HEAPNUM_INLINE_MAX = 75;
const DEFAULT_BUNDLES = ['dist/weed.prod.bundle.esm.min.js', 'dist/weed.bundle.esm.min.js'];
const DEFAULT_D8 = 'D:/perf-tools/v8/release/v8.exe';
const BIG_STRING = 20000;

async function babelParse(code, sourceType) {
  const { parseSync } = await import('@babel/core');
  return parseSync(code, { configFile: false, babelrc: false, sourceType, parserOpts: { errorRecovery: false } });
}

/** Calls fn(node, parent) for every node of a Babel AST. */
function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x.type === 'string') walk(x, fn, node);
    } else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}

/** A gzip+base64 payload's text (the compressed bundles), else the string itself. */
function inflateIfGzipB64(s) {
  if (!s.startsWith('H4sI') || !/^[A-Za-z0-9+/=]+$/.test(s)) return s;
  try {
    return zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8');
  } catch {
    return s;
  }
}

/**
 * The big string literals of a bundle (the worker sources it embeds), inflated where gzipped.
 * @returns {Promise<{ label: string, text: string }[]>}
 */
export async function extractEmbeddedSources(bundleText) {
  let ast;
  try {
    ast = await babelParse(bundleText, 'module');
  } catch {
    ast = await babelParse(bundleText, 'script');
  }
  const out = [];
  walk(ast, (node, parent) => {
    if (node.type !== 'StringLiteral' || node.value.length < BIG_STRING) return;
    let label = `string at ${node.start}`;
    if (parent && parent.type === 'ObjectProperty' && parent.value === node) {
      label = parent.key.type === 'Identifier' ? parent.key.name : String(parent.key.value);
    }
    const text = inflateIfGzipB64(node.value);
    // The shared chunk (workerCommonSource) is a variable's value: its webpack chunk push names it.
    if (label.startsWith('string at') && text.includes('webpackChunk') && text.includes('.push([[')) label = 'worker_common';
    out.push({ label, text });
  });
  return out;
}

function memberName(m) {
  const key = m.key.type === 'Identifier' ? m.key.name : m.key.type === 'StringLiteral' ? m.key.value : null;
  if (key === null || m.computed) return null;
  return m.kind === 'set' ? `set ${key}` : m.kind === 'get' ? `get ${key}` : key;
}

/**
 * The source ranges of class GameObject's setters in a worker's source (keep_classnames keeps the class name).
 * @returns {Promise<Map<string, { start: number, end: number }[]>>} V8 name → ranges (more than one if two classes
 *   are named GameObject)
 */
export async function findGameObjectSetters(chunkText) {
  const ast = await babelParse(chunkText, 'script');
  const found = new Map();
  walk(ast, (node) => {
    if ((node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') || !node.id || node.id.name !== 'GameObject') return;
    for (const m of node.body.body) {
      if (m.type !== 'ClassMethod' || m.static) continue;
      const name = memberName(m);
      if (!SETTERS.includes(name)) continue;
      if (!found.has(name)) found.set(name, []);
      found.get(name).push({ start: m.start, end: m.end });
    }
  });
  return found;
}

/**
 * Functions in a --print-bytecode dump: name, bytecode length, the source positions its lines carry, and whether it
 * makes a closure.
 * @returns {{ name: string, length: number, minPos: number, maxPos: number, closures: number }[]}
 */
export function parseBytecodeDump(text) {
  const out = [];
  const parts = text.split('[generated bytecode for function: ');
  for (const part of parts.slice(1)) {
    const name = /^(.*?) \(0x[0-9a-fA-F]+ <SharedFunctionInfo/.exec(part);
    const length = /\nBytecode length: (\d+)/.exec(part);
    if (!name || !length) continue;
    let minPos = Infinity;
    let maxPos = -Infinity;
    let closures = 0;
    for (const line of part.split('\n')) {
      const pos = /^\s*(\d+) [SE]> /.exec(line);
      if (pos) {
        const p = Number(pos[1]);
        if (p < minPos) minPos = p;
        if (p > maxPos) maxPos = p;
      }
      if (/ : [0-9a-f ]+\s+CreateClosure /.test(line)) closures++;
    }
    out.push({ name: name[1], length: Number(length[1]), minPos, maxPos, closures });
  }
  return out;
}

/** Runs a V8 shell (d8, or this Node) on the chunk with --no-lazy --print-bytecode for the set* functions. */
function bytecodeOfChunk(chunkText, engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-setters-'));
  try {
    const chunk = path.join(dir, engine.node ? 'chunk.cjs' : 'chunk.js');
    fs.writeFileSync(chunk, chunkText);
    const flags = ['--no-lazy', '--no-enable-lazy-source-positions', '--print-bytecode', '--print-bytecode-filter=set*'];
    let args;
    if (engine.node) {
      // Node compiles a CommonJS file as a function body: positions still count from the file's start.
      args = [...flags, chunk];
    } else {
      const prelude = path.join(dir, 'prelude.js');
      fs.writeFileSync(prelude, 'var self = globalThis;\n');
      args = [...flags, prelude, chunk];
    }
    // The chunk may throw when it runs (no worker globals): its bytecode was printed when it compiled.
    const r = spawnSync(engine.path, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw r.error;
    return parseBytecodeDump(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** GameObject's setters as this Node compiles them from source (setterBytecodeSize.test.js's reading). */
function sourceLengths() {
  const driver = path.join(root, 'tests', 'helpers', 'setterBytecodeDriver.mjs');
  if (!fs.existsSync(driver)) return new Map();
  const r = spawnSync(process.execPath, ['--print-bytecode', '--print-bytecode-filter=set*', driver], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const lengths = new Map();
  for (const f of parseBytecodeDump(r.stdout || '')) if (SETTERS.includes(f.name) && !lengths.has(f.name)) lengths.set(f.name, f.length);
  return lengths;
}

/**
 * Judges one chunk's setters.
 * @returns {{ name: string, length: number|null, closures: number, ok: boolean, why: string }[]}
 */
export function judgeSetters(ranges, functions) {
  const rows = [];
  for (const name of SETTERS) {
    const spans = ranges.get(name) || [];
    if (spans.length !== 1) {
      rows.push({ name, length: null, closures: 0, ok: false, why: spans.length ? `${spans.length} GameObject members of that name` : 'not found in class GameObject' });
      continue;
    }
    const { start, end } = spans[0];
    const fns = functions.filter((f) => f.name === name && f.minPos >= start && f.maxPos <= end);
    if (fns.length !== 1) {
      rows.push({ name, length: null, closures: 0, ok: false, why: `${fns.length} compiled functions of that name in its source range` });
      continue;
    }
    const f = fns[0];
    const why = [];
    if (f.length > HEAPNUM_INLINE_MAX) why.push(`over ${HEAPNUM_INLINE_MAX} bytes`);
    if (f.closures) why.push(`makes ${f.closures} closure${f.closures > 1 ? 's' : ''} a call`);
    rows.push({ name, length: f.length, closures: f.closures, ok: why.length === 0, why: why.join(', ') });
  }
  return rows;
}

function parseArgs(argv) {
  const opts = { bundles: [], d8: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') opts.bundles.push(argv[++i]);
    else if (a === '--d8') opts.d8 = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.bundles.length) opts.bundles = DEFAULT_BUNDLES;
  return opts;
}

function pickEngine(requested) {
  const d8 = requested || process.env.WEED_D8 || DEFAULT_D8;
  if (fs.existsSync(d8)) return { path: d8, node: false, label: d8 };
  if (requested) throw new Error(`no d8 at ${requested}`);
  return { path: process.execPath, node: true, label: `this Node's V8 ${process.versions.v8} (no d8 at ${d8})` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engine = pickEngine(opts.d8);
  console.log(`checkBundleSetters: ${engine.label}; limit ${HEAPNUM_INLINE_MAX} bytes and no closure a call`);
  const src = sourceLengths();
  const report = [];
  let failed = false;
  for (const rel of opts.bundles) {
    const file = path.resolve(root, rel);
    if (!fs.existsSync(file)) throw new Error(`no bundle at ${file}`);
    const sources = await extractEmbeddedSources(fs.readFileSync(file, 'utf8'));
    const withClass = sources.filter((s) => s.text.includes('class GameObject'));
    if (!withClass.length) throw new Error(`${rel}: no embedded source defines class GameObject`);
    for (const chunk of withClass) {
      const ranges = await findGameObjectSetters(chunk.text);
      const rows = judgeSetters(ranges, bytecodeOfChunk(chunk.text, engine));
      console.log(`\n${path.basename(file)} (${chunk.label}, ${chunk.text.length} chars)`);
      console.log(`  ${'setter'.padEnd(20)} ${'bundle'.padStart(6)} ${'src'.padStart(5)}  verdict`);
      for (const r of rows) {
        const s = src.has(r.name) ? String(src.get(r.name)) : '-';
        console.log(`  ${r.name.padEnd(20)} ${String(r.length ?? '-').padStart(6)} ${s.padStart(5)}  ${r.ok ? 'ok' : 'FAIL: ' + r.why}`);
        if (!r.ok) failed = true;
      }
      report.push({ bundle: path.basename(file), chunk: chunk.label, rows: rows.map((r) => ({ ...r, src: src.get(r.name) ?? null })) });
    }
  }
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ engine: engine.label, limit: HEAPNUM_INLINE_MAX, report }, null, 2));
  console.log(failed ? `\nFAIL: a setter is over ${HEAPNUM_INLINE_MAX} bytes or makes a closure at each call` : '\nok');
  process.exitCode = failed ? 1 : 0;
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isDirectRun) {
  main().catch((err) => {
    console.error(`checkBundleSetters: ${err.message}`);
    process.exitCode = 2;
  });
}
