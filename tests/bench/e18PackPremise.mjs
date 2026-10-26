#!/usr/bin/env node
/**
 * E-18 premise, before any C.
 *
 * The claim is a WASM SIMD transpose of packInstancedRows. WASM SIMD loads
 * contiguous vectors. This loop does not: each output row gathers one float
 * from each column through the painter index. This bench asks two questions
 * the transpose assumes are already answered:
 *
 *   1. How much of the fast sprite loop is the gather, and how much is the
 *      arithmetic a SIMD body could actually rewrite?
 *   2. How often are successive painter indices adjacent? A run of one is a
 *      scalar gather. A contiguous transpose never sees that index list.
 *
 * Each case is its own worker thread so the JIT matches one call shape.
 *   node tests/bench/e18PackPremise.mjs
 *   node tests/bench/e18PackPremise.mjs --output tests/results/e18-pack-premise/kernel.json
 */
import { GPU_SPRITE_FLOATS, GPU_SPACE_WORLD, makePackContext } from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';
import { packInstancedRows } from '../reference/gpuPackJs.mjs';

function buildQueue(fx, rows) {
  const { x, y, rotC, rotS, active } = fx.arrays;
  const ids = [];
  for (let i = 0; i < fx.meta.n && ids.length < rows; i++) if (active[i]) ids.push(i);
  const n = ids.length;
  const rng = mulberry32(0x9ac4);
  const f32 = () => new Float32Array(n);
  const q = {
    count: n,
    x: f32(), y: f32(), scaleX: f32(), scaleY: f32(),
    rotC: f32(), rotS: f32(), alpha: f32(),
    tint: new Uint32Array(n),
    textureId: new Uint16Array(n),
    anchorX: f32(), anchorY: f32(),
    repeatX: f32(), repeatY: f32(),
    tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: new Uint16Array(n),
    tileOffsetV: new Uint16Array(n),
    type: new Uint8Array(n),
  };
  for (let r = 0; r < n; r++) {
    const i = ids[r];
    q.x[r] = x[i];
    q.y[r] = y[i];
    q.scaleX[r] = 0.8 + rng() * 0.4;
    q.scaleY[r] = q.scaleX[r];
    q.rotC[r] = rotC[i] || 1;
    q.rotS[r] = rotS[i] || 0;
    q.alpha[r] = rng() < 0.9 ? 1 : rng();
    q.tint[r] = 0xffffff;
    q.textureId[r] = (rng() * 400) | 0;
    q.anchorX[r] = 0.5;
    q.anchorY[r] = 1;
  }
  const painter = Uint32Array.from({ length: n }, (_, r) => r);
  painter.sort((a, b) => q.y[a] - q.y[b] || a - b);
  return { q, painter };
}

/** Same stores as the fast sprite loop, none of the arithmetic. Premise only. */
function gatherOnly(q, ctx, dst, dstU32) {
  const indices = ctx.indices;
  const useIndices = ctx.useIndices;
  const scanCount = ctx.scanCount | 0;
  const rqX = q.x, rqY = q.y, rqScaleX = q.scaleX, rqScaleY = q.scaleY;
  const rqRotC = q.rotC, rqRotS = q.rotS, rqAlpha = q.alpha, rqTint = q.tint;
  const rqTextureId = q.textureId, rqAnchorX = q.anchorX, rqAnchorY = q.anchorY;
  const rqTileMulX = q.tileMulX, rqTileMulY = q.tileMulY;
  const rqTileOffU = q.tileOffsetU, rqTileOffV = q.tileOffsetV;
  let base = 0;
  for (let k = 0; k < scanCount; k++) {
    const i = useIndices ? indices[k] : k;
    dst[base] = rqX[i];
    dst[base + 1] = rqY[i];
    dst[base + 2] = rqScaleX[i];
    dst[base + 3] = rqScaleY[i];
    dst[base + 4] = rqAnchorX[i];
    dst[base + 5] = rqAnchorY[i];
    dst[base + 6] = rqRotC[i];
    dst[base + 7] = rqRotS[i];
    dst[base + 8] = rqAlpha[i];
    dstU32[base + 9] = rqTint[i];
    dst[base + 10] = rqTextureId[i];
    dst[base + 11] = rqTileMulX[i];
    dst[base + 12] = rqTileMulY[i];
    dst[base + 13] = rqTileOffU[i];
    dst[base + 14] = rqTileOffV[i];
    base += 15;
  }
  return scanCount;
}

function indexRuns(indices) {
  let runs = 0;
  let adjacent = 0;
  let prev = -2;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i === prev + 1) adjacent++;
    else runs++;
    prev = i;
  }
  return {
    rows: indices.length,
    runs,
    adjacent,
    adjacentShare: indices.length > 1 ? adjacent / (indices.length - 1) : 0,
    meanRun: indices.length / runs,
  };
}

function runCase(mode, rows) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin');
  const { q, painter } = buildQueue(fx, rows);
  const n = q.count;
  const dst = new Float32Array(n * GPU_SPRITE_FLOATS);
  const u32 = new Uint32Array(dst.buffer);
  const indices = mode === 'sequential' ? Uint32Array.from({ length: n }, (_, i) => i) : painter;
  const opts = { indices, indexCount: n, space: GPU_SPACE_WORLD, zoom: 0.4, cameraX: 0, cameraY: 0, type: q.type };
  const ctxOut = {};
  const pack = mode === 'gather'
    ? () => gatherOnly(q, makePackContext(q, opts, n, ctxOut), dst, u32)
    : () => packInstancedRows(q, makePackContext(q, opts, n, ctxOut), dst, u32, GPU_SPRITE_FLOATS, n, false);
  const out = pack();
  const checksum = checksumFloats(dst, out * GPU_SPRITE_FLOATS);
  const result = timeIt(`e18 ${mode} (${out} rows)`, pack, { iterations: 40, warmup: 20 });
  return {
    rows: out,
    checksum,
    msPerCall: result.ms / result.iterations,
    opsPerSec: result.opsPerSec,
    sampleMs: result.ms,
    iterations: result.iterations,
    runs: mode === 'painter' ? indexRuns(painter) : null,
  };
}

async function main() {
  const args = parseArgs();
  const rows = Number(args.rows ?? 16384);
  const { Worker } = await import('node:worker_threads');
  const modes = ['painter', 'sequential', 'gather'];
  const cases = {};
  for (const mode of modes) {
    cases[mode] = await new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { role: 'case', mode, rows } });
      w.once('message', resolve);
      w.once('error', reject);
    });
  }
  const painterMs = cases.painter.msPerCall;
  const gatherMs = cases.gather.msPerCall;
  const sequentialMs = cases.sequential.msPerCall;
  const report = {
    feature: 'e18-pack-premise',
    hypothesis: 'WASM SIMD transpose of packInstancedRows',
    rows,
    seed: 0x9ac4,
    note: 'gather is the same 15 loads and stores with the arithmetic removed. sequential is the shipped pack with identity indices. each case is its own thread.',
    arithmeticShareOfPainter: painterMs > 0 ? (painterMs - gatherMs) / painterMs : null,
    painterOverSequential: sequentialMs > 0 ? painterMs / sequentialMs : null,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify({
    rows: cases.painter.rows,
    painterMs: Number(painterMs.toFixed(4)),
    gatherMs: Number(gatherMs.toFixed(4)),
    sequentialMs: Number(sequentialMs.toFixed(4)),
    arithmeticShareOfPainter: report.arithmeticShareOfPainter,
    painterOverSequential: report.painterOverSequential,
    adjacentShare: cases.painter.runs.adjacentShare,
    meanRun: cases.painter.runs.meanRun,
  }, null, 2));
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.mode, workerData.rows));
} else if (isCli(import.meta.url)) await main();
