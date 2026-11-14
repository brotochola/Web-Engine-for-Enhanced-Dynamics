#!/usr/bin/env node
/**
 * E-193 step 0: Pixi's keyed pack (gpuPackKeyedMicrobench's frame, pack_sprites_keyed through gpuPack.wasm) with the
 * queue's columns written just before each pack, as pre-render's emit writes them on another core in the scene. In the
 * worker the pack reads about 0.7 ms a frame at Predator's defaults where this kernel reads 0.075 (R-0813); if the
 * cost is in reading rows another core has just written, `--writer other` shows it and `none` does not.
 *
 *   --writer none   only the textures a twentieth of the rows change (gpuPackKeyedMicrobench's frame)
 *   --writer same   this thread rewrites every queue column of every row before each pack (fresh data, warm cache)
 *   --writer other  a worker thread rewrites them and signals (fresh data, written on another core), then the pack
 *
 *   node tests/bench/gpuPackKeyedCrossCoreMicrobench.mjs [--writer none|same|other] [--order random|near|queue]
 *     [--pack gather|scatter|table]
 *     [--rows 14000] [--entities 42600] [--frames 61] [--output path]
 *
 * Node only (worker_threads). `queue` packs in the queue's own order (no gather): the bound for an inverse.
 * `--pack table` (E-201's ceiling): no keyed pack; a per-entity pose table (4 floats an entity, in the same shared memory,
 * rewritten by the writer like the queue's columns) is copied whole into Pixi's own array, and the slot stream is each
 * drawn row's key in the painter's order: what Pixi would do if pre-render kept the poses by key. The statics updates
 * are left out on this side (a twentieth of the rows), so it reads a little low.
 */
import { Worker } from 'node:worker_threads';

import { GPU_SPACE_WORLD, makePackContext } from '../../src/render/gpuQueueLayout.js';
import * as client from '../../src/render/gpuPackClient.js';
import { setup } from './gpuPackKeyedMicrobench.mjs';
import { parseArgs, writeReport } from './microbenchHelpers.mjs';

/** The queue's columns as { byteOffset, length, bytes } (every one the emit writes for a row). */
function queueColumns(q) {
  const out = [];
  for (const [name, v] of Object.entries(q)) {
    if (!ArrayBuffer.isView(v)) continue;
    out.push({ name, byteOffset: v.byteOffset, length: v.length, bytes: v.BYTES_PER_ELEMENT });
  }
  return out;
}

// The writer: on each go, a store to every element of every column (the value it holds, so the frame's data is
// unchanged and only the lines' owner moves), in the queue's order, column by column as the emit's kernel does.
const WRITER = `
const { workerData } = require('node:worker_threads');
const { buffer, control, columns } = workerData;
const flag = new Int32Array(control);
const views = columns.map((c) => c.bytes === 4 ? new Uint32Array(buffer, c.byteOffset, c.length)
  : c.bytes === 2 ? new Uint16Array(buffer, c.byteOffset, c.length) : new Uint8Array(buffer, c.byteOffset, c.length));
for (;;) {
  Atomics.wait(flag, 0, 0);
  if (Atomics.load(flag, 0) === 3) break;
  for (const v of views) for (let i = 0; i < v.length; i++) v[i] = v[i];
  Atomics.store(flag, 0, 2);
  Atomics.notify(flag, 0);
}
`;

export async function run({ writer = 'none', order = 'random', pack: packKind = 'gather', rows = 14000, entities = 42600, frames = 61 } = {}) {
  const s = await setup(rows | 0, entities | 0, order === 'queue' ? 'near' : order);
  // gather: the painter's order (the binding without its inverse); scatter: E-193's, through the inverse, where the
  // tree's gpuPack has it.
  if (packKind === 'gather' || packKind === 'table') s.b = { ...s.b, keyedInverseByte: 0 };
  else if (!s.b.spritesKeyedScatter) throw new Error('this tree has no pack_sprites_keyed_scatter');
  // E-201: the pose table by key, in the queue's shared memory (so the writer rewrites it), and Pixi's private copy.
  const tableShared = packKind === 'table' ? new Float32Array(new SharedArrayBuffer(entities * 4 * 4)) : null;
  const tablePrivate = packKind === 'table' ? new Float32Array(entities * 4) : null;
  if (tableShared) for (let i = 0; i < tableShared.length; i++) tableShared[i] = (i % 97) * 0.5;
  if (order === 'queue') for (let i = 0; i < rows; i++) s.order[i] = i;
  const opts = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: rows, type: s.q.type };
  const ctx = () => makePackContext(s.q, opts, rows, {});
  const changes = Math.round(rows * 0.05);
  const columns = queueColumns(s.q);
  const tableColumn = tableShared ? { name: 'poseTable', byteOffset: 0, length: tableShared.length, bytes: 4 } : null;
  const sameViews = columns.map((c) => s.q[c.name]);

  let worker = null;
  let worker2 = null;
  let flag = null;
  const control2 = new SharedArrayBuffer(16);
  const flag2 = new Int32Array(control2);
  if (writer === 'other') {
    // The queue lives in the pack's shared WebAssembly memory: its buffer is a SharedArrayBuffer.
    const control = new SharedArrayBuffer(16);
    flag = new Int32Array(control);
    worker = new Worker(WRITER, { eval: true, workerData: { buffer: s.q.x.buffer, control, columns } });
    if (tableColumn) worker2 = new Worker(WRITER, { eval: true, workerData: { buffer: tableShared.buffer, control: control2, columns: [tableColumn] } });
  }

  const change = () => {
    for (let m = 0; m < changes; m++) {
      const i = (s.rng() * rows) | 0;
      s.q.textureId[i] = (s.q.textureId[i] + 1) & 63;
    }
    if (writer === 'same') {
      for (const v of sameViews) for (let i = 0; i < v.length; i++) v[i] = v[i];
    } else if (writer === 'other') {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      while (Atomics.load(flag, 0) !== 2) Atomics.wait(flag, 0, 1, 50);
      Atomics.store(flag, 0, 0);
      if (worker2) {
        Atomics.store(flag2, 0, 1);
        Atomics.notify(flag2, 0);
        while (Atomics.load(flag2, 0) !== 2) Atomics.wait(flag2, 0, 1, 50);
        Atomics.store(flag2, 0, 0);
      }
    }
  };

  const keyed = {
    tableByte: s.keyTable.byteOffset, stampByte: s.stamps.byteOffset, keyBase: entities, epoch: 0,
    updatesByte: s.updates.byteOffset, updates: 0,
  };
  const keyCol = s.q.key;
  const pack = packKind === 'table'
    ? () => {
        tablePrivate.set(tableShared);
        const slots = s.slots;
        const order = s.order;
        for (let k = 0; k < rows; k++) {
          const key = keyCol[order[k]];
          slots[k] = key < entities ? key : entities + k;
        }
        return rows;
      }
    : () => {
        keyed.epoch = (keyed.epoch + 1) >>> 0 || 1;
        return client.packKeyedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, keyed, rows);
      };
  if (pack() !== rows) throw new Error('the keyed pack did not take the frame');
  const warm = 20;
  for (let f = 0; f < warm; f++) {
    change();
    pack();
  }
  const times = [];
  for (let f = 0; f < frames; f++) {
    change();
    const t0 = performance.now();
    pack();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  if (worker) {
    Atomics.store(flag, 0, 3);
    Atomics.notify(flag, 0);
    await worker.terminate();
  }
  if (worker2) {
    Atomics.store(flag2, 0, 3);
    Atomics.notify(flag2, 0);
    await worker2.terminate();
  }
  let check = 0;
  for (let k = 0; k < s.pose.length; k += 97) check += s.pose[k];
  return {
    feature: 'gpu-pack-keyed-cross-core',
    writer,
    order,
    pack: packKind,
    rows,
    entities,
    frames,
    ms: times[(times.length / 2) | 0],
    p90: times[Math.floor(times.length * 0.9)],
    check,
  };
}

const args = parseArgs();
const report = await run({
  writer: String(args.writer ?? 'none'),
  pack: String(args.pack ?? 'gather'),
  order: String(args.order ?? 'random'),
  rows: Number(args.rows ?? 14000),
  entities: Number(args.entities ?? 42600),
  frames: Number(args.frames ?? 61),
});
console.log(`pack ${report.pack.padEnd(7)} writer ${report.writer.padEnd(5)} order ${report.order.padEnd(6)} ${report.ms.toFixed(3)} ms a pack (p90 ${report.p90.toFixed(3)}, check ${report.check.toFixed(1)})`);
if (args.output) writeReport(String(args.output), report);
