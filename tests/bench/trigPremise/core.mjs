// Q2 premise (E-76), browser-safe: trigQ2.wasm (musl atan/sin/cos/asin, V8's atan2) against this
// engine's Math.*, bit for bit, on about 1e8 inputs per function. node.mjs and chrome.mjs feed it the bytes.
export async function compareAll(wasmBytes, { scale = 1, which = 'atan2,atan,sin,cos,asin' } = {}) {
const CHUNK = 1 << 18;
const BASE = 1 << 20; // above the module's data and stack
const pages = Math.ceil((BASE + CHUNK * 8 * 3) / 65536);
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: { memory } });
const ex = instance.exports;
const A = new Float64Array(memory.buffer, BASE, CHUNK), B = new Float64Array(memory.buffer, BASE + CHUNK * 8, CHUNK), O = new Float64Array(memory.buffer, BASE + CHUNK * 16, CHUNK);
const Au = new Uint32Array(A.buffer, A.byteOffset, CHUNK * 2), Bu = new Uint32Array(B.buffer, B.byteOffset, CHUNK * 2);
const results = {};
let s = 0x9e3779b9;
const r32 = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
const rnd = () => r32() / 4294967296;
const f = Math.fround;
const ulps = (a, b) => { const v = new Float64Array([a, b]); const u = new BigInt64Array(v.buffer); return u[0] > u[1] ? u[0] - u[1] : u[1] - u[0]; };

const gens1 = {
  bits: (i) => { Au[2 * i] = r32(); Au[2 * i + 1] = r32(); },
  game: (i) => { A[i] = (rnd() * 2 - 1) * 8 * Math.PI; },
  medium: (i) => { A[i] = (rnd() * 2 - 1) * 1e6; },
  unit: (i) => { A[i] = rnd() * 2 - 1; },
};
const gens2 = {
  bits: (i) => { Au[2 * i] = r32(); Au[2 * i + 1] = r32(); Bu[2 * i] = r32(); Bu[2 * i + 1] = r32(); },
  f32diff: (i) => { const ly = f(rnd() * 5000), lx = f(rnd() * 10000); A[i] = f(rnd() * 5000) - ly; B[i] = f(rnd() * 10000) - lx; },
  wide: (i) => { A[i] = (rnd() * 2 - 1) * 1000; B[i] = (rnd() * 2 - 1) * 1000; },
};
function edges1() {
  const out = [0, -0, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, -2.2250738585072014e-308, Number.MAX_VALUE, -Number.MAX_VALUE, 1, -1, 0.5, -0.5];
  const near = (x) => { const v = new Float64Array([x]); const u = new BigInt64Array(v.buffer); const r = [x]; for (const d of [-2n, -1n, 1n, 2n]) { u[0] += d; r.push(v[0]); u[0] -= d; } return r; };
  for (let k = -200000; k <= 200000; k++) out.push(...near((k * Math.PI) / 4));
  for (const x of [1, -1, 0.5, -0.5, 0.975, 1e-8, 2 ** -27, 2 ** -26, 2 ** 20 * Math.PI / 2, 2 ** 28, 2 ** 52]) out.push(...near(x));
  return out;
}
function edges2() {
  const v = [0, -0, Infinity, -Infinity, NaN, 1, -1, 5e-324, -5e-324, 1e300, -1e300, 3, -3];
  const out = [];
  for (const y of v) for (const x of v) out.push([y, x]);
  for (let i = 0; i < 100000; i++) { const t = rnd() * 2000 - 1000; out.push([t, 0], [0, t], [t, t], [t, -t], [-t, t]); }
  return out;
}

function run1(name, fnWasm, fnJs) {
  const report = {};
  const todo = Object.entries(gens1).map(([k, g]) => [k, g, Math.round((k === 'game' ? 4e7 : 2e7) * scale)]);
  todo.push(['edges', null, 0]);
  for (const [k, g, total] of todo) {
    let n = 0, mism = 0, maxU = 0n, f32m = 0; const ex = [];
    const edgeList = g ? null : edges1();
    const count = g ? total : edgeList.length;
    for (let done = 0; done < count; done += CHUNK) {
      const m = Math.min(CHUNK, count - done);
      for (let i = 0; i < m; i++) { if (g) g(i); else A[i] = edgeList[done + i]; }
      fnWasm(A.byteOffset, O.byteOffset, m);
      for (let i = 0; i < m; i++) {
        const j = fnJs(A[i]); const w = O[i];
        if (Object.is(j, w) || (j !== j && w !== w)) continue;
        mism++; const u = ulps(j, w); if (u > maxU) maxU = u;
        if (Math.fround(j) !== Math.fround(w)) f32m++;
        if (ex.length < 3) ex.push(`${name}(${A[i]}) js ${j} wasm ${w}`);
      }
      n += m;
    }
    report[k] = { n, mismatches: mism, f32Mismatches: f32m, maxUlp: Number(maxU), examples: ex };
  }
  results[name] = report;
}
function run2() {
  const report = {};
  const todo = Object.entries(gens2).map(([k, g]) => [k, g, Math.round((k === 'f32diff' ? 4e7 : 2e7) * scale)]);
  todo.push(['edges', null, 0]);
  for (const [k, g, total] of todo) {
    let n = 0, mism = 0, maxU = 0n; const exs = [];
    const edgeList = g ? null : edges2();
    const count = g ? total : edgeList.length;
    for (let done = 0; done < count; done += CHUNK) {
      const m = Math.min(CHUNK, count - done);
      for (let i = 0; i < m; i++) { if (g) g(i); else { A[i] = edgeList[done + i][0]; B[i] = edgeList[done + i][1]; } }
      ex.atan2_batch(A.byteOffset, B.byteOffset, O.byteOffset, m);
      for (let i = 0; i < m; i++) {
        const j = Math.atan2(A[i], B[i]); const w = O[i];
        if (Object.is(j, w) || (j !== j && w !== w)) continue;
        mism++; const u = ulps(j, w); if (u > maxU) maxU = u;
        if (exs.length < 3) exs.push(`atan2(${A[i]}, ${B[i]}) js ${j} wasm ${w}`);
      }
      n += m;
    }
    report[k] = { n, mismatches: mism, maxUlp: Number(maxU), examples: exs };
  }
  results.atan2 = report;
}
const list = which.split(',');
const t0 = Date.now();
if (list.includes('atan2')) run2();
if (list.includes('atan')) run1('atan', ex.atan_batch, Math.atan);
if (list.includes('sin')) run1('sin', ex.sin_batch, Math.sin);
if (list.includes('cos')) run1('cos', ex.cos_batch, Math.cos);
if (list.includes('asin')) run1('asin', ex.asin_batch, Math.asin);
results.seconds = (Date.now() - t0) / 1000;
return results;
}
