import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spatialPublishRegions } from '../../src/util/wasmMemoryMap.js';

// E-76 T3: the spatial publish module is built freestanding by scripts/buildWasm.mjs. It must
// publish exactly what the emcc binary it replaced published (kept as a fixture), and both must
// match a float32 model of wasm/spatialPublish.c: every operation rounds to float, as the C does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHIPPED = path.join(root, 'src/workers/spatialPublish.wasm');
const EMCC = path.join(root, 'tests/fixtures/spatialPublish.emcc.wasm');

async function instantiateShipped(memory) {
  // Only the memory: the freestanding module imports nothing else.
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(SHIPPED), { env: { memory } });
  return instance.exports.publish_batch;
}

async function instantiateEmcc(memory) {
  // The emcc binary imports WASI and Emscripten stubs; the old loader answered them with 0.
  const env = new Proxy({ memory }, { get: (t, p) => (p in t ? t[p] : () => 0) });
  const wasi = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(EMCC), { env, wasi_snapshot_preview1: wasi });
  return instance.exports.publish_batch;
}

/**
 * The product layout (the memory map), in a memory of at least 2 pages: the emcc fixture's import
 * asks for 2, the freestanding module's for 1.
 */
function publishMemory(count, maxN) {
  const layout = spatialPublishRegions(count, maxN, 1);
  const pages = Math.max(2, layout.pages);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const r = layout.regions;
  return {
    memory,
    buffer: memory.buffer,
    posByte: r.pos.byte,
    rangeByte: r.range.byte,
    neighborByte: r.rows.byte,
    candByte: r.cand.byte,
    listByte: r.lists.byte,
  };
}

const f = Math.fround;

/** The C predicate, operation by operation in float32. */
function publishF32(pos, range, cand, list, n, maxN) {
  const stride = 1 + maxN;
  const rows = [];
  for (let k = 0; k < n; k++) {
    const a = list[k];
    const base = a * stride;
    const myX = pos[a * 4];
    const myY = pos[a * 4 + 1];
    const myRange = range[a];
    const row = [];
    for (let i = 0; i < cand[base] && row.length < maxN; i++) {
      const b = cand[base + 1 + i];
      const dx = f(pos[b * 4] - myX);
      const dy = f(pos[b * 4 + 1] - myY);
      const er = f(myRange + pos[b * 4 + 2]);
      if (f(f(dx * dx) + f(dy * dy)) < f(er * er)) row.push(b);
    }
    rows.push(row);
  }
  return rows;
}

function readRows(neighbor, list, n, maxN) {
  const stride = 1 + maxN;
  const rows = [];
  for (let k = 0; k < n; k++) {
    const base = list[k] * stride;
    rows.push(Array.from(neighbor.subarray(base + 1, base + 1 + neighbor[base])));
  }
  return rows;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Fill one frame: positions, ranges, a batch list and candidate rows. A third of the candidates
 * sit on the range edge (one float32 step inside or outside), so the comparison itself is tested.
 */
function fillFrame(views, count, maxN, batch, seed) {
  const { pos, range, cand, list } = views;
  const rnd = lcg(seed);
  for (let e = 0; e < count; e++) {
    pos[e * 4] = rnd() * 4000;
    pos[e * 4 + 1] = rnd() * 2000;
    pos[e * 4 + 2] = rnd() * 16;
    pos[e * 4 + 3] = 0;
    range[e] = 20 + rnd() * 180;
  }
  const stride = 1 + maxN;
  const used = new Set();
  let n = 0;
  while (n < batch) {
    const a = (rnd() * count) | 0;
    if (used.has(a)) continue;
    used.add(a);
    list[n++] = a;
    const base = a * stride;
    const candCount = Math.min(maxN, (rnd() * (maxN + 1)) | 0);
    cand[base] = candCount;
    for (let i = 0; i < candCount; i++) {
      let b = (rnd() * count) | 0;
      if (rnd() < 0.33 && !used.has(b)) {
        // Put b on the edge of a's range, then nudge it one float32 step either way.
        const er = f(range[a] + pos[b * 4 + 2]);
        const ang = rnd() * Math.PI * 2;
        let x = f(pos[a * 4] + er * Math.cos(ang));
        const y = f(pos[a * 4 + 1] + er * Math.sin(ang));
        const step = Math.max(Math.abs(x) * 2 ** -23, 2 ** -126);
        x = f(x + (rnd() < 0.5 ? step : -step));
        pos[b * 4] = x;
        pos[b * 4 + 1] = y;
      }
      if (b === a) b = (b + 1) % count;
      cand[base + 1 + i] = b;
    }
  }
  return n;
}

const CONFIGS = [
  { count: 4096, maxN: 1024, batch: 512, seed: 1 },
  { count: 4096, maxN: 64, batch: 2048, seed: 2 },
  { count: 1000, maxN: 7, batch: 1000, seed: 3 }, // truncation in the SIMD and tail loops
  { count: 300, maxN: 3, batch: 300, seed: 4 }, // under one SIMD group
  { count: 64, maxN: 0, batch: 64, seed: 5 }, // no row space at all
];

test('the freestanding spatial module publishes what the emcc binary did, in float32', async () => {
  for (const cfg of CONFIGS) {
    const mem = publishMemory(cfg.count, cfg.maxN);
    const { buffer } = mem;
    const stride = 1 + cfg.maxN;
    const views = {
      pos: new Float32Array(buffer, mem.posByte, cfg.count * 4),
      range: new Float32Array(buffer, mem.rangeByte, cfg.count),
      cand: new Uint16Array(buffer, mem.candByte, cfg.count * stride),
      list: new Uint16Array(buffer, mem.listByte, cfg.count),
    };
    const neighbor = new Uint16Array(buffer, mem.neighborByte, cfg.count * stride);
    // Instantiate before filling the frame: the emcc binary's start function writes its init flag
    // and a static at addresses 1024 and 1028 (N-62), inside the pose region since T9.
    const emccPublish = await instantiateEmcc(mem.memory);
    const shippedPublish = await instantiateShipped(mem.memory);
    const n = fillFrame(views, cfg.count, cfg.maxN, cfg.batch, cfg.seed);
    const run = (fn) => {
      neighbor.fill(0xbeef);
      fn(n, cfg.maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte);
      return readRows(neighbor, views.list, n, cfg.maxN);
    };
    const emcc = run(emccPublish);
    const shipped = run(shippedPublish);
    const model = publishF32(views.pos, views.range, views.cand, views.list, n, cfg.maxN);
    const label = JSON.stringify(cfg);
    assert.deepEqual(shipped, emcc, `${label}: shipped vs emcc`);
    assert.deepEqual(shipped, model, `${label}: shipped vs float32 model`);
    const published = shipped.reduce((s, r) => s + r.length, 0);
    if (cfg.maxN > 0) assert.ok(published > 0, `${label}: something was published`);
  }
});

test('the shipped spatial module imports only the shared memory', () => {
  const mod = new WebAssembly.Module(fs.readFileSync(SHIPPED));
  assert.deepEqual(WebAssembly.Module.imports(mod), [{ module: 'env', name: 'memory', kind: 'memory' }]);
  assert.deepEqual(WebAssembly.Module.exports(mod), [{ name: 'publish_batch', kind: 'function' }]);
});
