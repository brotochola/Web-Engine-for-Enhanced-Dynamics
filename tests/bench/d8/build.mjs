// Bundle a WeedJS Node kernel into one ES module that d8 can run: node:* modules become small stubs, `process`
// is a shim with the given argv, and every module keeps its own import.meta.url (so isCli() is true only for the
// entry). The engine code is bundled as is (no minify).
// N-236: D8KIT_NATIVE=1 leaves the engine's own files (the repo's src/) native ES modules that d8 loads itself, as
// Chrome's --src runs do: esbuild turns every top-level const of a bundled module into var, which changes what
// TurboFan folds. It cuts both ways: a bundled rebuildChecked ran 43 ns an entity against 25 native (2026-11-16), and
// bodyPackMicrobench 187 ops/s bundled against 114 native (2026-11-22). Say the mode beside any d8 timing. In native
// mode the kernel and its tests/ helpers are bundled and the shims go to <out>.prelude.js, a plain script d8 must run
// before the module (runKernels.sh passes it), since a native module evaluates before any banner. Write <out> inside
// the repo's tests/bench (and delete it after) when the kernel imports a worker by a relative path.
//   node build.mjs <repo-relative kernel> <out.mjs> [kernel args...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// WEED_REPO points the kit at another tree.
const REPO = (process.env.WEED_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')).split(path.sep).join('/');
const esbuild = createRequire(path.join(REPO, 'package.json'))('esbuild');

const [kernel, out, ...kernelArgs] = process.argv.slice(2);
const entry = path.resolve(REPO, kernel);
const entryUrl = pathToFileURL(entry).href;

const STUBS = {
  'node:fs': `
    const fs = { writeFileSync() {}, mkdirSync() {}, existsSync() { return false }, readFileSync(p) { throw new Error('d8: no fs ' + p) },
      readdirSync() { return [] }, rmSync() {}, statSync() { throw new Error('d8: no fs') } };
    export default fs; export const { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync } = fs;`,
  'node:path': `
    const norm = (p) => { const abs = p.startsWith('/') || /^[A-Za-z]:/.test(p); const out = [];
      for (const s of p.replace(/\\\\/g, '/').split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
      const j = out.join('/'); return abs && !/^[A-Za-z]:/.test(j) ? '/' + j : j; };
    const path = { sep: '/', join: (...a) => norm(a.join('/')), resolve: (...a) => { let r = ''; for (const s of a) r = (s.startsWith('/') || /^[A-Za-z]:/.test(s)) ? s : r + '/' + s; return norm(r); },
      dirname: (p) => norm(p).split('/').slice(0, -1).join('/') || '/', basename: (p, e) => { const b = norm(p).split('/').pop(); return e && b.endsWith(e) ? b.slice(0, -e.length) : b; },
      extname: (p) => { const m = /\\.[^./]*$/.exec(p); return m ? m[0] : ''; }, isAbsolute: (p) => p.startsWith('/') || /^[A-Za-z]:/.test(p), relative: (a, b) => b, normalize: norm };
    export default path; export const { sep, join, resolve, dirname, basename, extname, isAbsolute, relative, normalize } = path;`,
  'node:url': `
    export const fileURLToPath = (u) => decodeURIComponent(String(u).replace(/^file:\\/\\/(?:\\/(?=[A-Za-z]:))?/, ''));
    export const pathToFileURL = (p) => ({ href: String(p) }); // d8 imports a plain path, not a file: URL
    export default { fileURLToPath, pathToFileURL };`,
  'node:os': `const os = { cpus: () => [], platform: () => '${process.platform}', tmpdir: () => '/tmp', EOL: '\\n' }; export default os; export const { cpus, platform, tmpdir, EOL } = os;`,
  'node:assert/strict': `
    const fail = (m) => { throw new Error('assert: ' + (m || 'failed')); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function assert(v, m) { if (!v) fail(m); }
    Object.assign(assert, { ok: assert, equal: (a, b, m) => a === b || fail(m || a + ' !== ' + b), strictEqual: (a, b, m) => a === b || fail(m || a + ' !== ' + b),
      notEqual: (a, b, m) => a !== b || fail(m), deepEqual: (a, b, m) => same(a, b) || fail(m), deepStrictEqual: (a, b, m) => same(a, b) || fail(m),
      match: (s, r, m) => r.test(s) || fail(m), throws: (f) => { try { f(); } catch { return; } fail('no throw'); } });
    export default assert;`,
};
STUBS['node:assert'] = STUBS['node:assert/strict'];
STUBS['node:process'] = 'export default globalThis.process;';
STUBS['node:perf_hooks'] = 'export const performance = globalThis.performance; export default { performance };';

const banner = `globalThis.process = { argv: ['d8', ${JSON.stringify(entry)}, ...${JSON.stringify(kernelArgs)}], env: {}, platform: '${process.platform}',
  versions: { v8: 'd8' }, exitCode: 0, exit(c) { if (c) throw new Error('process.exit(' + c + ')'); },
  hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0, rss: 0 }), stdout: { write: (s) => { print(String(s).replace(/\\n$/, '')); return true; } },
  stderr: { write: (s) => { print(String(s).replace(/\\n$/, '')); return true; } }, on() {}, cwd: () => ${JSON.stringify(REPO)},
  getBuiltinModule: (n) => n === 'fs' ? { readFileSync: (p) => new Uint8Array(readbuffer(String(p))) } : n === 'url' ? { fileURLToPath: (u) => decodeURIComponent(String(u).replace(/^file:[/][/](?:[/](?=[A-Za-z]:))?/, '')) } : undefined };
globalThis.self ??= globalThis;
globalThis.TextEncoder ??= class { encode(s = '') { const u = unescape(encodeURIComponent(s)); const a = new Uint8Array(u.length); for (let i = 0; i < u.length; i++) a[i] = u.charCodeAt(i); return a; }
  encodeInto(s, dst) { const a = this.encode(s); const n = Math.min(a.length, dst.length); dst.set(a.subarray(0, n)); return { read: s.length, written: n }; } };
globalThis.TextDecoder ??= class { decode(b) { if (!b) return ''; const a = b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  try { return decodeURIComponent(escape(s)); } catch { return s; } } };
globalThis.navigator ??= { hardwareConcurrency: 8, userAgent: 'd8' };
globalThis.URL ??= class URL {
  constructor(input, base) {
    input = String(input);
    let href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) href = input;
    else {
      const b = String(base ?? '');
      const m = /^([a-z][a-z0-9+.-]*:\\/\\/[^/]*)(\\/.*)?$/i.exec(b);
      const origin = m ? m[1] : '';
      const dir = (m ? m[2] || '/' : b).replace(/[^/]*$/, '');
      const parts = (input.startsWith('/') ? input : dir + input).split('/');
      const outp = [];
      for (const s of parts) { if (s === '..') { if (outp.length > 1) outp.pop(); } else if (s !== '.') outp.push(s); }
      href = origin + outp.join('/');
    }
    this.href = href;
    const p = /^([a-z][a-z0-9+.-]*:)(?:\\/\\/[^/]*)?(.*)$/i.exec(href);
    this.protocol = p ? p[1] : '';
    this.pathname = p ? p[2] : href;
    this.search = '';
    this.hash = '';
  }
  toString() { return this.href; }
};
globalThis.URLSearchParams ??= class URLSearchParams { constructor(q = '') { this._m = new Map(); for (const p of String(q).replace(/^[?]/, '').split('&')) { if (!p) continue; const i = p.indexOf('='); this._m.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1)); } } get(k) { return this._m.has(k) ? this._m.get(k) : null; } has(k) { return this._m.has(k); } set(k, v) { this._m.set(k, String(v)); } toString() { return [...this._m].map(([k, v]) => k + '=' + v).join('&'); } };
globalThis.location ??= { search: '', href: 'file:///d8', origin: 'file://' };
globalThis.fetch ??= async (u) => { const p = decodeURIComponent(String(u).replace(/^file:[/][/](?:[/](?=[A-Za-z]:))?/, '')); const b = readbuffer(p); return { ok: true, status: 200, arrayBuffer: async () => b }; };
globalThis.queueMicrotask ??= (f) => Promise.resolve().then(f);
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));`;

const BUNDLE_ALL = process.env.D8KIT_NATIVE !== '1';
const SRC_DIR = path.resolve(REPO, 'src') + path.sep;

const plugin = {
  name: 'd8',
  setup(b) {
    // N-236: a relative import into the repo's src/ stays an import of that file, by its absolute path (d8 imports a
    // plain path), so the engine's modules run as the browser runs them.
    if (!BUNDLE_ALL) {
      b.onResolve({ filter: /^\.{1,2}\// }, (a) => {
        const abs = path.resolve(a.resolveDir, a.path);
        if (!abs.startsWith(SRC_DIR)) return null;
        return { path: abs.split(path.sep).join('/'), external: true };
      });
    }
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      if (!STUBS[a.path]) throw new Error(`no d8 stub for ${a.path}`);
      return { contents: STUBS[a.path], loader: 'js' };
    });
    // Each module's own URL, as a literal.
    b.onLoad({ filter: /\.(m?js)$/ }, (a) => {
      const src = fs.readFileSync(a.path, 'utf8');
      if (!src.includes('import.meta.url')) return null;
      return { contents: src.split('import.meta.url').join(JSON.stringify(pathToFileURL(a.path).href)), loader: 'js' };
    });
  },
};

const prelude = out.replace(/\.m?js$/, '') + '.prelude.js';
if (BUNDLE_ALL) {
  if (fs.existsSync(prelude)) fs.rmSync(prelude);
} else {
  fs.writeFileSync(prelude, banner + '\n');
}
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'esnext', outfile: out,
  ...(BUNDLE_ALL ? { banner: { js: banner } } : {}), plugins: [plugin], logLevel: 'warning', minify: false, keepNames: false,
});
console.log(`built ${out} from ${kernel} (${entryUrl})${BUNDLE_ALL ? ', all bundled' : `, src/ native; run ${prelude} first`}`);
