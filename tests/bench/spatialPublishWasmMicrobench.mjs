/**
 * Kernel: WASM SIMD publish of neighbor lists vs the JS predicate in
 * SpatialWorker._publishFilteredNeighbors. Same SharedArrayBuffer.
 *
 *   node tests/bench/spatialPublishWasmMicrobench.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, timeIt } from './microbenchHelpers.mjs';

const ENTITIES = 4096;
const MAX_NEIGHBORS = 1024;
const STRIDE = 1 + MAX_NEIGHBORS;
const CAND = 48;
const BATCH = 2048;

const POS_FLOATS = ENTITIES * 4;
const RANGE_FLOATS = ENTITIES;
const LIST_U16 = BATCH;
const ROW_U16 = ENTITIES * STRIDE;
const align4 = (n) => (n + 3) & ~3;

const posByte = 0;
const rangeByte = POS_FLOATS * 4;
const listByte = align4(rangeByte + RANGE_FLOATS * 4);
const candByte = align4(listByte + LIST_U16 * 2);
const neighborJsByte = align4(candByte + ROW_U16 * 2);
const neighborWasmByte = align4(neighborJsByte + ROW_U16 * 2);
const bytes = neighborWasmByte + ROW_U16 * 2;
const pages = 4096;
if (bytes > pages * 65536) throw new Error(`layout ${bytes} exceeds wasm memory`);

function fill(memory) {
  const pos = new Float32Array(memory.buffer, posByte, POS_FLOATS);
  const range = new Float32Array(memory.buffer, rangeByte, RANGE_FLOATS);
  const list = new Uint16Array(memory.buffer, listByte, LIST_U16);
  const cand = new Uint16Array(memory.buffer, candByte, ROW_U16);
  let s = 0x1234567;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let e = 0; e < ENTITIES; e++) {
    pos[e * 4] = rnd() * 10000;
    pos[e * 4 + 1] = rnd() * 5000;
    pos[e * 4 + 2] = 4 + rnd() * 12;
    range[e] = 80 + rnd() * 120;
  }
  for (let n = 0; n < BATCH; n++) list[n] = (rnd() * ENTITIES) | 0;
  for (let n = 0; n < BATCH; n++) {
    const entityA = list[n];
    const base = entityA * STRIDE;
    cand[base] = CAND;
    for (let i = 0; i < CAND; i++) {
      let b = (rnd() * ENTITIES) | 0;
      if (b === entityA) b = (b + 1) % ENTITIES;
      cand[base + 1 + i] = b;
    }
  }
}

function publishJs(memory) {
  const pos = new Float32Array(memory.buffer, posByte, POS_FLOATS);
  const range = new Float32Array(memory.buffer, rangeByte, RANGE_FLOATS);
  const list = new Uint16Array(memory.buffer, listByte, LIST_U16);
  const cand = new Uint16Array(memory.buffer, candByte, ROW_U16);
  const neighbor = new Uint16Array(memory.buffer, neighborJsByte, ROW_U16);
  for (let n = 0; n < BATCH; n++) {
    const entityA = list[n];
    const myX = pos[entityA * 4];
    const myY = pos[entityA * 4 + 1];
    const myRange = range[entityA];
    const base = entityA * STRIDE;
    const candCount = cand[base];
    let published = 0;
    for (let i = 0; i < candCount && published < MAX_NEIGHBORS; i++) {
      const b = cand[base + 1 + i];
      const dx = pos[b * 4] - myX;
      const dy = pos[b * 4 + 1] - myY;
      const er = myRange + pos[b * 4 + 2];
      if (dx * dx + dy * dy < er * er) {
        neighbor[base + 1 + published] = b;
        published++;
      }
    }
    neighbor[base] = published;
  }
}

function checksumNeighbor(memory, byteOff) {
  const neighbor = new Uint16Array(memory.buffer, byteOff, ROW_U16);
  const list = new Uint16Array(memory.buffer, listByte, LIST_U16);
  let h = 2166136261;
  for (let n = 0; n < BATCH; n++) {
    const base = list[n] * STRIDE;
    const count = neighbor[base];
    h = checksumInts(neighbor.subarray(base, base + 1 + count), count + 1) ^ h;
  }
  return h >>> 0;
}

async function main() {
  const wasmPath = join(dirname(fileURLToPath(import.meta.url)), 'wasm', 'spatialPublish.wasm');
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  fill(memory);
  const env = new Proxy(
    { memory },
    { get: (target, prop) => (prop in target ? target[prop] : () => 0) },
  );
  const wasi = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
    env,
    wasi_snapshot_preview1: wasi,
  });
  const publishWasm = instance.exports.publish_batch;
  publishJs(memory);
  publishWasm(BATCH, MAX_NEIGHBORS, posByte, rangeByte, candByte, neighborWasmByte, listByte);
  const jsSum = checksumNeighbor(memory, neighborJsByte);
  const wasmSum = checksumNeighbor(memory, neighborWasmByte);
  if (jsSum !== wasmSum) {
    console.error(`checksum JS ${jsSum} WASM ${wasmSum}`);
    process.exit(1);
  }
  console.log(`checksum ${jsSum} pages ${pages}`);
  const js = timeIt('js-publish', () => publishJs(memory));
  const wasm = timeIt('wasm-publish', () => {
    publishWasm(BATCH, MAX_NEIGHBORS, posByte, rangeByte, candByte, neighborWasmByte, listByte);
  });
  const delta = ((wasm.opsPerSec - js.opsPerSec) / js.opsPerSec) * 100;
  console.log(`delta ${delta.toFixed(1)}% ops/s (wasm vs js)`);
  return { js, wasm, delta, checksum: jsSum };
}

if (isCli(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
