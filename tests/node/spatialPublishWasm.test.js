import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Grid } from '../../src/core/grid.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';
import { initWorker, loadWorker, spatialBuffers } from '../bench/workerHarness.mjs';

// The spatial publish module (wasm/spatialPublish.c, built by scripts/buildWasm.mjs) must publish
// exactly what the JavaScript path publishes: SpatialWorker._publishFilteredNeighbors on a real
// worker, the path taken at 32-bit ids or with wasm.spatialPublish false. Since E-76 W8a the C
// does the JS arithmetic (float32 inputs widened, every operation in double); in float32 the two
// disagreed within ~3e-7 of the range edge, so a third of the candidates here sit on that edge.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHIPPED = path.join(root, 'src/workers/spatialPublish.wasm');

async function instantiateShipped(memory) {
  // Only the memory: the module imports nothing else.
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(SHIPPED), { env: { memory } });
  return instance.exports.publish_batch;
}

/** A real spatial worker in JS mode (no publish memory), sized for this frame. */
async function jsWorker(count, maxN) {
  const cfg = { worldWidth: 4096, worldHeight: 2048, cellSize: 128, maxEntitiesPerCell: 16, maxNeighbors: maxN };
  const worker = await loadWorker('spatialWorker.js', 'spatialWorker');
  const { buffers, gridMetadata } = spatialBuffers(cfg, count);
  await initWorker(worker, {
    config: { worldWidth: cfg.worldWidth, worldHeight: cfg.worldHeight, spatial: cfg },
    globalEntityCount: count,
    buffers,
    gridMetadata,
    extra: { workerIndex: 0, totalSpatialWorkers: 1 },
  });
  assert.equal(worker._wasmPub, null, 'the reference worker runs the JS path');
  return worker;
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

const f = Math.fround;

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
  { count: 1000, maxN: 7, batch: 1000, seed: 3 }, // rows truncate at maxNeighbors
  { count: 300, maxN: 3, batch: 300, seed: 4 },
  { count: 64, maxN: 0, batch: 64, seed: 5 }, // no row space at all
];

test('the spatial module publishes exactly what the JS path publishes, on the range edge too', async () => {
  for (const cfg of CONFIGS) {
    const mem = createSpatialPublishMemory(cfg.count, cfg.maxN, 1);
    assert.ok(mem, 'spatial publish memory');
    const { buffer } = mem;
    const stride = 1 + cfg.maxN;
    const views = {
      pos: new Float32Array(buffer, mem.posByte, cfg.count * 4),
      range: new Float32Array(buffer, mem.rangeByte, cfg.count),
      cand: new Uint16Array(buffer, mem.candByte, cfg.count * stride),
      list: new Uint16Array(buffer, mem.listByte, cfg.count),
    };
    const neighbor = new Uint16Array(buffer, mem.neighborByte, cfg.count * stride);
    const n = fillFrame(views, cfg.count, cfg.maxN, cfg.batch, cfg.seed);

    neighbor.fill(0xbeef);
    const publish = await instantiateShipped(mem.memory);
    publish(n, cfg.maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte);
    const shipped = readRows(neighbor, views.list, n, cfg.maxN);

    // The same bytes in the JS path's own storage: poses, candidates, rows in Grid.neighborData.
    const worker = await jsWorker(cfg.count, cfg.maxN);
    worker.entityPosData.set(views.pos);
    worker._neighborCandidateData.set(views.cand);
    const rows = Grid.neighborData;
    rows.fill(0xbeef);
    for (let k = 0; k < n; k++) {
      const a = views.list[k];
      worker._publishFilteredNeighbors(a, views.pos[a * 4], views.pos[a * 4 + 1], views.range[a], a * stride, cfg.maxN, worker.entityPosData, rows);
    }
    const js = readRows(rows, views.list, n, cfg.maxN);

    const label = JSON.stringify(cfg);
    assert.deepEqual(shipped, js, `${label}: shipped module vs JS path`);
    const published = shipped.reduce((s, r) => s + r.length, 0);
    if (cfg.maxN > 0) assert.ok(published > 0, `${label}: something was published`);
  }
});

test('the shipped spatial module imports only the shared memory', () => {
  const mod = new WebAssembly.Module(fs.readFileSync(SHIPPED));
  assert.deepEqual(WebAssembly.Module.imports(mod), [{ module: 'env', name: 'memory', kind: 'memory' }]);
  assert.deepEqual(WebAssembly.Module.exports(mod), [{ name: 'publish_batch', kind: 'function' }]);
});
