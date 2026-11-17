/**
 * The replay in d8 (V8 16, as Chrome: inlining and boxing claims are judged there, not in Node 22). replayWorker.mjs
 * --d8 runs it as
 *   v8.exe --expose-gc tests/bench/replayD8Entry.mjs -- '{"meta": "<meta.json>", "raw": "<frames, decompressed>", "rounds": 2}'
 * and reads the line `REPLAY_RESULT <json>` it prints. The engine's modules load natively (not bundled: a bundler
 * turns module consts into top-level vars, which TurboFan does not fold), after the few globals d8 lacks are
 * installed below; the imports are dynamic so that they evaluate after them.
 */
/* global print, read, readbuffer */

if (typeof globalThis.URL === 'undefined') {
  // Enough for `new URL('./x.wasm', import.meta.url)`: d8's import.meta.url is a plain path.
  globalThis.URL = class URL {
    constructor(input, base) {
      input = String(input);
      let href;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('/')) href = input;
      else {
        const dir = String(base ?? '').replace(/[^/\\]*$/, '');
        const out = [];
        for (const s of (dir + input).split(/[/\\]/)) {
          if (s === '..') out.pop();
          else if (s !== '.') out.push(s);
        }
        href = out.join('/');
      }
      this.href = href;
      this.pathname = href;
      this.protocol = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(href)?.[1] ?? '';
      this.search = '';
      this.hash = '';
    }
    toString() {
      return this.href;
    }
  };
}
globalThis.URLSearchParams ??= class URLSearchParams {
  constructor(q = '') {
    this._m = new Map();
    for (const p of String(q).replace(/^[?]/, '').split('&')) {
      if (!p) continue;
      const i = p.indexOf('=');
      this._m.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1));
    }
  }
  get(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  }
  has(k) {
    return this._m.has(k);
  }
  set(k, v) {
    this._m.set(k, String(v));
  }
  toString() {
    return [...this._m].map(([k, v]) => `${k}=${v}`).join('&');
  }
};
globalThis.fetch ??= async (url) => {
  const p = decodeURIComponent(String(url).replace(/^file:\/\/\/?/, ''));
  const b = readbuffer(p);
  return { ok: true, status: 200, arrayBuffer: async () => b };
};
globalThis.queueMicrotask ??= (f) => Promise.resolve().then(f);
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));
globalThis.navigator ??= { hardwareConcurrency: 8, userAgent: 'd8' };
globalThis.location ??= { search: '', href: 'file:///d8', origin: 'file://' };
globalThis.TextEncoder ??= class TextEncoder {
  encode(s = '') {
    const u = unescape(encodeURIComponent(s));
    const a = new Uint8Array(u.length);
    for (let i = 0; i < u.length; i++) a[i] = u.charCodeAt(i);
    return a;
  }
};
globalThis.TextDecoder ??= class TextDecoder {
  decode(b) {
    if (!b) return '';
    const a = b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b);
    let s = '';
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  }
};

const opts = JSON.parse(globalThis.arguments[0]);
const meta = JSON.parse(read(opts.meta));
const bytes = new Uint8Array(readbuffer(opts.raw));
const { runSpatialReplay } = await import('./spatialReplay.mjs');
const out = await runSpatialReplay(meta, bytes, {
  rounds: opts.rounds ?? 2,
  check: opts.check !== false,
  workers: opts.workers || undefined,
  log: (s) => print(`  ${s}`),
});
print(`REPLAY_RESULT ${JSON.stringify(out)}`);
