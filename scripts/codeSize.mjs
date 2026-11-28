// N-303 CR-0: the code reduction campaign's ruler. Counts the code, comment and blank lines of src/ by folder (the
// generated files left out), the bytes of both .wasm files and of the four minified bundles (raw and gzipped at level
// 9), and with --suite the node suite's test count and time.
//   node scripts/codeSize.mjs [--suite] [--json <file>]
// A line is blank when it holds only white space, a comment line when all it holds is a comment (// or inside /* */),
// and code otherwise (code with a comment after it is code). Shaders count like JS: both languages use // and /* */.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
/** Generated or vendored: not the engine's own lines. */
const GENERATED = new Set(['box2d/box2dWasm.js', 'wasm/engine.js', 'vendor/pixi.min.js', 'version.js']);
const COUNTED = /\.(m?js|glsl|wgsl|frag|vert)$/;
const BUNDLES = ['weed.prod.bundle.min.js', 'weed.bundle.esm.min.js', 'weed.prod.bundle.esm.min.js'];
const WASM = ['src/wasm/engine.wasm', 'src/box2d/box2dWasm.wasm'];

function parseArgs(argv) {
  const out = { suite: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite') out.suite = true;
    else if (argv[i] === '--json') out.json = argv[++i];
  }
  return out;
}

/** The code, comment and blank lines of one source text. */
export function countLines(text) {
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      blank++;
      continue;
    }
    // Walk the line: is there anything outside comments? (Strings holding // or /* are rare enough in this
    // engine's sources to be counted as they read.)
    let hasCode = false;
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) {
          i = line.length;
        } else {
          inBlock = false;
          i = end + 2;
        }
        continue;
      }
      if (line.startsWith('//', i)) break;
      if (line.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (line[i] !== ' ' && line[i] !== '\t') hasCode = true;
      i++;
    }
    if (hasCode) code++;
    else comment++;
  }
  return { code, comment, blank };
}

/** Every counted file under src/, its path relative to src/ with forward slashes. */
function listSources(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listSources(path.join(dir, entry.name), r));
    else if (COUNTED.test(entry.name) && !GENERATED.has(r)) out.push(r);
  }
  return out;
}

/** The folder a file is reported under: src's first level, with core/debug and core/save apart. */
function folderOf(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return '(src root)';
  if (parts[0] === 'core' && (parts[1] === 'debug' || parts[1] === 'save') && parts.length > 2) return `core/${parts[1]}`;
  return parts[0];
}

function fileBytes(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const bytes = fs.readFileSync(p);
  return { bytes: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length };
}

function runSuite() {
  const started = Date.now();
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:node'], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28,
  });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: num(/^# tests (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
    durationMs: num(/^# duration_ms ([\d.]+)/m),
    wallMs: Date.now() - started,
  };
}

function fmt(n) {
  return n == null ? '-' : n.toLocaleString('en-US').replace(/,/g, ' ');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const byFolder = new Map();
  const total = { files: 0, code: 0, comment: 0, blank: 0 };
  for (const rel of listSources(SRC)) {
    const c = countLines(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    const key = folderOf(rel);
    const row = byFolder.get(key) || { files: 0, code: 0, comment: 0, blank: 0 };
    row.files++;
    row.code += c.code;
    row.comment += c.comment;
    row.blank += c.blank;
    byFolder.set(key, row);
    total.files++;
    total.code += c.code;
    total.comment += c.comment;
    total.blank += c.blank;
  }
  const folders = [...byFolder.entries()].sort((a, b) => b[1].code - a[1].code);
  const wasm = Object.fromEntries(WASM.map((f) => [f, fileBytes(f)]));
  const bundles = Object.fromEntries(BUNDLES.map((f) => [`dist/${f}`, fileBytes(`dist/${f}`)]));
  const suite = args.suite ? runSuite() : null;

  const lines = [];
  lines.push('| folder | files | code lines | comment lines | blank lines |', '| --- | --- | --- | --- | --- |');
  for (const [k, r] of folders) lines.push(`| \`src/${k}\` | ${r.files} | ${fmt(r.code)} | ${fmt(r.comment)} | ${fmt(r.blank)} |`);
  lines.push(`| **\`src/\` in all** | **${total.files}** | **${fmt(total.code)}** | **${fmt(total.comment)}** | **${fmt(total.blank)}** |`);
  lines.push('', `Left out (generated or vendored): ${[...GENERATED].map((g) => `\`src/${g}\``).join(', ')}.`, '');
  lines.push('| file | bytes | gzipped (level 9) |', '| --- | --- | --- |');
  for (const [f, b] of [...Object.entries(wasm), ...Object.entries(bundles)]) {
    lines.push(`| \`${f}\` | ${b ? fmt(b.bytes) : 'missing'} | ${b ? fmt(b.gzip) : '-'} |`);
  }
  if (suite) {
    lines.push('', `Node suite: ${fmt(suite.tests)} tests (${fmt(suite.pass)} pass, ${fmt(suite.fail)} fail), ` +
      `${suite.durationMs != null ? (suite.durationMs / 1000).toFixed(1) : '-'} s by the runner, ${(suite.wallMs / 1000).toFixed(1)} s wall.`);
  }
  console.log(lines.join('\n'));
  if (args.json) {
    fs.writeFileSync(args.json, `${JSON.stringify({ folders: Object.fromEntries(folders), total, wasm, bundles, suite }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
