import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createReplayDecoder, createReplayEncoder, MODE_FULL, MODE_SAME, MODE_SPARSE } from '../bench/replayCodec.mjs';
import { runSpatialReplay, spatialRecorderInWorker } from '../bench/spatialReplay.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';
import { mulberry32 } from '../bench/benchMath.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The mode the encoder chose for column `c` of a record. */
function modes(record, specs, movedLen) {
  const i32 = new Int32Array(record.buffer, record.byteOffset, record.length >> 2);
  let at = 16 + movedLen;
  const out = [];
  for (const s of specs) {
    const mode = i32[at];
    const count = i32[at + 1];
    out.push(mode);
    at += 2;
    if (mode === MODE_SPARSE) at += count + (((count * s.bpe + 3) & ~3) >> 2);
    else if (mode === MODE_FULL) at += ((s.length * s.bpe + 3) & ~3) >> 2;
  }
  return out;
}

test('replay codec: every mode round-trips bit for bit, NaN and -0 included', () => {
  const n = 1000;
  const specs = [
    { name: 'x', length: n, bpe: 4, predict: true },
    { name: 'flags', length: n, bpe: 1 },
    { name: 'type', length: n, bpe: 2 },
    { name: 'rot', length: n, bpe: 4, masked: true },
    { name: 'list', length: n + 1, bpe: 2 },
  ];
  const enc = createReplayEncoder(specs);
  const dec = createReplayDecoder(specs);
  const rng = mulberry32(7);
  const x = new Float32Array(n);
  const vx = new Float32Array(n).map(() => (rng() - 0.5) * 4);
  const flags = new Uint8Array(n);
  const type = new Uint16Array(n);
  const rot = new Float32Array(n);
  const list = new Uint16Array(n + 1);
  const mask = new Int32Array(n);
  const targets = specs.map((s) => new (s.bpe === 1 ? Uint8Array : s.bpe === 2 ? Uint16Array : Uint32Array)(s.length));
  const seen = new Set();
  for (let f = 0; f < 30; f++) {
    // x moves (a full record) except on frames 10-11 (same), 20 (a few: sparse); NaN and -0 appear.
    if (f < 10 || f > 11) for (let i = 0; i < n; i++) if (f !== 20 || i % 97 === 0) x[i] += vx[i];
    if (f === 5) x[3] = NaN;
    if (f === 6) x[4] = -0;
    if (f % 7 === 0) flags[(f * 31) % n] ^= 1;
    if (f === 3) type.fill(9);
    const m = f % 3 === 0 ? 50 : 0;
    for (let k = 0; k < m; k++) mask[k] = k * 7;
    for (let k = 0; k < m; k++) rot[mask[k]] = Math.cos(f + k);
    // A rotation outside the mask changes but is not recorded.
    rot[n - 1] = f;
    list[0] = n - (f % 5);
    for (let i = 1; i <= list[0]; i++) list[i] = i - 1 + (f % 5);
    const views = [new Uint32Array(x.buffer), flags, type, new Uint32Array(rot.buffer), list];
    const rec = enc.encode(
      { frame: f, queryVersion: f * 3, movedGen: f, movedCount: 2, movedSeq: f * 2, logicFrame: f + 0.5, clock: 1000 + f },
      Uint32Array.of(5, 6),
      2,
      views,
      [null, null, null, mask, null],
      [0, 0, 0, m, 0],
    );
    for (const mode of modes(rec, specs, 2)) seen.add(mode);
    const buf = new Uint8Array(rec.length);
    buf.set(rec);
    assert.equal(dec.decode(buf, 0, targets), rec.length);
    assert.equal(dec.header.frame, f);
    assert.equal(dec.header.queryVersion, f * 3);
    assert.equal(dec.header.logicFrame, f + 0.5);
    assert.deepEqual(Array.from(dec.header.moved), [5, 6]);
    assert.deepEqual(targets[0], new Uint32Array(x.buffer), `x at frame ${f}`);
    assert.deepEqual(targets[1], flags);
    assert.deepEqual(targets[2], type);
    assert.deepEqual(targets[4], list);
    for (let k = 0; k < m; k++) assert.equal(targets[3][mask[k]], new Uint32Array(rot.buffer)[mask[k]]);
    assert.equal(targets[3][n - 1], 0, 'a rotation outside the mask is not recorded');
  }
  assert.deepEqual([...seen].sort(), [MODE_SAME, MODE_SPARSE, MODE_FULL]);
});

test('spatial replay: the recorder inside a live worker, then the replay, publish the same rows every frame', async () => {
  const k = await setupSpatialKernel({ n: 3000, workers: 1, types: 'predator' });
  const worker = k.workers[0];
  // The recorder looks for the worker where a spatial worker's module puts it.
  const savedWorker = globalThis.self.spatialWorker;
  globalThis.self.spatialWorker = worker;
  const posted = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted.push(init.body);
    return { ok: true, status: 200 };
  };
  const FRAMES = 40;
  const liveHashes = [];
  let meta;
  try {
    meta = await spatialRecorderInWorker({
      frames: FRAMES,
      chunkFrames: 7,
      encoderSource: createReplayEncoder.toString(),
      uploadPath: '/upload',
      srcBase: pathToFileURL(path.join(repoRoot, 'src')).href + '/',
    });
    const { Grid } = await import('../../src/core/grid.js');
    // The replay's rowsHash, on the live worker's rows.
    const hashRows = () => {
      const rows = Grid.neighborData;
      const stride = Grid._stride;
      let h = 2166136261;
      for (let i = 0; i < k.n; i++) {
        const base = i * stride;
        const count = rows[base];
        h = Math.imul(h ^ count, 16777619) >>> 0;
        if (count === 0) continue;
        let s = 0;
        for (let j = 0; j < count; j++) s = (s + Math.imul(rows[base + 1 + j] + 1, 2654435761)) >>> 0;
        h = Math.imul(h ^ s, 16777619) >>> 0;
      }
      return h >>> 0;
    };
    for (let f = 0; f < FRAMES; f++) {
      k.frame();
      liveHashes.push(hashRows());
    }
    // The uploads settle in microtasks.
    for (let i = 0; i < 10 && !globalThis.self.__weedReplayRecorder.done; i++) await new Promise((r) => setTimeout(r, 5));
    const rec = globalThis.self.__weedReplayRecorder;
    assert.equal(rec.error, null);
    assert.ok(rec.done, 'the recorder finished');
    assert.equal(rec.chunks, Math.ceil(FRAMES / 7));
    assert.equal(rec.live.length, FRAMES);
    assert.equal(Object.prototype.hasOwnProperty.call(worker, 'update'), false, 'update() is the class method again');
    meta = { ...meta, movedBound: rec.movedBound };
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.self.spatialWorker = savedWorker;
    delete globalThis.self.__weedReplayRecorder;
  }
  assert.ok(meta.logicFrameSlot >= 0, 'the typed stagger reads logic 0 frame number');
  assert.equal(meta.registeredClasses.length, 4);
  const chunks = posted
    .map((b) => {
      const colon = b.indexOf(':');
      return [Number(b.slice(0, colon)), Buffer.from(b.slice(colon + 1), 'base64')];
    })
    .sort((a, b) => a[0] - b[0]);
  const joined = Buffer.concat(chunks.map((c) => c[1]));
  const bytes = new Uint8Array(joined.length);
  bytes.set(joined);
  const out = await runSpatialReplay(meta, bytes, { rounds: 1 });
  assert.equal(out.frames, FRAMES);
  assert.deepEqual(out.check.hashes, liveHashes, 'replayed rows, frame by frame');
  assert.equal(out.timed[0].finalHash, out.check.finalHash, 'a second pass on fresh workers is the same');
  assert.ok(out.check.counters.rebuilt.some((r) => r > 0) && out.check.counters.reused.some((r) => r > 0));
});
