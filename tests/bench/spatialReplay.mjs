/**
 * The spatial worker's deterministic replay (replayWorker.mjs --worker spatial): its recorder, which runs inside a
 * live scene's spatial worker, and its replay, which feeds the frames recorded into real SpatialWorker instances
 * (workerHarness.mjs) and times each frame's update().
 *
 * What a spatial frame reads, and so what is recorded each frame (replayCodec.mjs keeps only what changed):
 *   - the columns rebuildOwnedRows, _rebuildMovedRows, getColliderBounds and _findNeighbors read: Transform x, y,
 *     active, entityType, rotC and rotS (for colliders that are not circles: the circle branches never read a
 *     rotation), Collider active, shapeType, radius, width, height, offsets, visualRange and its polygon columns,
 *     SpriteRenderer.active, RigidBody.active, the LightEmitter columns in a scene with walls (lighting.walls: a light
 *     searches its own reach) and the shared active list;
 *   - logic 0's frame number in frameRateData (E-200's typed stagger), the active-query version, and physics' moved
 *     list header (E-126: generation, count, sequence) with its entries when the movers path could read them (a count
 *     of at most half the active entities; past MOVERS_MAX_FRACTION the worker reads only the header).
 * Everything else the worker keeps (its grid, poses, candidate rows, reuse signatures, stagger countdowns) is its own
 * state, rebuilt by the replay from the first frame on, which is why a replay's first frames are warm-up.
 *
 * No node: module here, so the replay runs natively in d8 too (replayD8Entry.mjs).
 */
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Grid } from '../../src/core/grid.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { createMovedBodiesSab, bindMovedBodies, viewsFromSab, HDR_GEN, HDR_COUNT, HDR_SEQ } from '../../src/box2d/box2dMovedBodies.js';
import { createReplayDecoder, unsignedView } from './replayCodec.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker, quietly, spatialPublishBuffers } from './workerHarness.mjs';

/**
 * The recorder, run inside the live spatial worker (Playwright's worker.evaluate sends its source text, so it uses
 * only its argument and the worker's globals). It wraps the worker's update(): before each of the next `frames`
 * frames it encodes what the frame will read, and it posts the records in chunks to `uploadPath` (base64 text,
 * "<chunk>:<data>"). Returns the recording's meta; progress is on self.__weedReplayRecorder.
 * @param {{ frames: number, chunkFrames: number, encoderSource: string, uploadPath: string, srcBase: string }} args
 */
export async function spatialRecorderInWorker(args) {
  const sw = self.spatialWorker;
  if (!sw || !sw.activeEntitiesData || !sw.entityPosData) throw new Error('replay: no initialized spatial worker here');
  if (self.__weedReplayRecorder) throw new Error('replay: a recorder is already installed in this worker');
  const createEncoder = (0, eval)(`(${args.encoderSource})`);
  const load = (p) => import(args.srcBase + p);
  const [tr, co, rb, sr, le, gr, mb, ew, cu] = await Promise.all([
    load('components/transform.js'),
    load('components/collider.js'),
    load('components/rigidBody.js'),
    load('components/spriteRenderer.js'),
    load('components/lightEmitter.js'),
    load('core/grid.js'),
    load('box2d/box2dMovedBodies.js'),
    load('util/entityIdWidth.js'),
    load('util/colliderUtils.js'),
  ]);
  const Transform = tr.Transform;
  const Collider = co.Collider;
  const Grid = gr.Grid;
  const n = sw.globalEntityCount | 0;
  // The modules imported here are the worker's own only if they are bound (same URLs, one module map per worker).
  if (!Transform.x || Transform.x.length < n || !Grid.neighborData || Grid.neighborData.length === 0) {
    throw new Error("replay: the imported engine modules are not the worker's (Transform.x or Grid.neighborData unbound)");
  }
  const MAXV = Collider.MAX_POLYGON_VERTICES | 0;
  const CIRCLE = cu.SHAPE_CIRCLE;
  const comp = { Transform, Collider, RigidBody: rb.RigidBody, SpriteRenderer: sr.SpriteRenderer, LightEmitter: le.LightEmitter, Grid };
  const field = (name) => {
    if (name === 'activeList') return sw.activeEntitiesData;
    const dot = name.indexOf('.');
    return comp[name.slice(0, dot)][name.slice(dot + 1)] || null;
  };
  const defs = [
    { name: 'Transform.x', predict: true },
    { name: 'Transform.y', predict: true },
    { name: 'Transform.rotC', masked: true },
    { name: 'Transform.rotS', masked: true },
    { name: 'Transform.active' },
    { name: 'Transform.entityType' },
    { name: 'Collider.active' },
    { name: 'Collider.shapeType' },
    { name: 'Collider.radius' },
    { name: 'Collider.width' },
    { name: 'Collider.height' },
    { name: 'Collider.offsetX' },
    { name: 'Collider.offsetY' },
    { name: 'Collider.visualRange' },
    { name: 'Collider.polyCount' },
    { name: 'Collider.polyCentroidX' },
    { name: 'Collider.polyCentroidY' },
    { name: 'Collider.fixtureCount' },
    { name: 'Collider.polyVertexX', perEntity: MAXV },
    { name: 'Collider.polyVertexY', perEntity: MAXV },
    { name: 'SpriteRenderer.active' },
    { name: 'RigidBody.active' },
    ...(sw._raycastLights
      ? ['active', 'castShadows', 'radius', 'shadowRange', 'offsetX', 'offsetY'].map((k) => ({ name: `LightEmitter.${k}` }))
      : []),
    { name: 'activeList', length: n + 1 },
  ];
  const specs = [];
  const getters = [];
  for (const d of defs) {
    const a = field(d.name);
    // A column this scene never sized is left out: the replay keeps it at its init values.
    if (!a || !a.BYTES_PER_ELEMENT || a.length === 0) continue;
    const length = d.whole ? a.length : d.length || n * (d.perEntity || 1);
    if (a.length < length) throw new Error(`replay: ${d.name} has ${a.length} elements, expected ${length}`);
    specs.push({ name: d.name, length, bpe: a.BYTES_PER_ELEMENT, type: a.constructor.name, predict: !!d.predict, masked: !!d.masked });
    getters.push(() => field(d.name));
  }
  const encoder = createEncoder(specs);
  const intType = (bpe) => (bpe === 1 ? Uint8Array : bpe === 2 ? Uint16Array : Uint32Array);
  const cache = specs.map(() => ({ arr: null, view: null }));
  const views = new Array(specs.length).fill(null);
  const rotMask = new Int32Array(n);
  const masks = specs.map((s) => (s.masked ? rotMask : null));
  const maskCounts = new Array(specs.length).fill(0);
  const head = new Int32Array(3);
  const frames = args.frames | 0;
  const live = new Float64Array(frames);
  const clock = new Float64Array(frames);
  const rec = { frames: 0, done: false, error: null, bytes: 0, chunks: 0, acked: 0, live: null, clock: null };
  self.__weedReplayRecorder = rec;
  const slot = sw._logicFrameSlot | 0;
  let movedBound = false;

  function encodeFrame(f) {
    for (let c = 0; c < specs.length; c++) {
      const a = getters[c]();
      const k = cache[c];
      if (a !== k.arr) {
        k.arr = a;
        k.view = a ? new (intType(specs[c].bpe))(a.buffer, a.byteOffset, specs[c].length) : null;
      }
      views[c] = k.view;
    }
    // Rotations matter only where a branch reads them: colliders that are not circles.
    let m = 0;
    const ca = Collider.active;
    const st = Collider.shapeType;
    for (let i = 0; i < n; i++) if (ca[i] && st[i] !== CIRCLE) rotMask[m++] = i;
    for (let c = 0; c < specs.length; c++) if (specs[c].masked) maskCounts[c] = m;
    const listed = mb.readMovedBodiesHeader(head);
    movedBound = movedBound || listed;
    let movedList = null;
    let movedLen = 0;
    if (listed && head[1] > 0 && head[1] <= sw.activeEntitiesData[0] * 0.5) {
      const v = mb.getMovedBodiesViews();
      if (v) {
        movedList = v.movedList;
        movedLen = Math.min(head[1], movedList.length);
      }
    }
    const bytes = encoder.encode(
      {
        frame: f,
        queryVersion: sw.queryVersionData ? sw.queryVersionData[0] : 0,
        movedGen: listed ? head[0] : 0,
        movedCount: listed ? head[1] : 0,
        movedSeq: listed ? head[2] : -2,
        logicFrame: slot >= 0 && sw.frameRateData ? sw.frameRateData[slot] : NaN,
        clock: performance.now(),
      },
      movedList,
      movedLen,
      views,
      masks,
      maskCounts,
    );
    rec.bytes += bytes.length;
    return bytes;
  }

  const toBase64 = (u8) => {
    if (typeof u8.toBase64 === 'function') return u8.toBase64();
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  let pending = [];
  let pendingBytes = 0;
  let inflight = 0;
  const finish = () => {
    if (rec.frames < frames || inflight > 0 || rec.done) return;
    rec.live = Array.from(live);
    rec.clock = Array.from(clock);
    rec.movedBound = movedBound;
    rec.done = true;
  };
  function flush() {
    if (pending.length === 0) return;
    const out = new Uint8Array(pendingBytes);
    let o = 0;
    for (const p of pending) {
      out.set(p, o);
      o += p.length;
    }
    pending = [];
    pendingBytes = 0;
    const id = rec.chunks++;
    inflight++;
    fetch(args.uploadPath, { method: 'POST', body: `${id}:${toBase64(out)}`, headers: { 'Content-Type': 'text/plain' } })
      .then((r) => {
        if (!r.ok) throw new Error(`upload ${id}: HTTP ${r.status}`);
        rec.acked++;
      })
      .catch((e) => {
        rec.error = String(e && e.stack ? e.stack : e);
      })
      .finally(() => {
        inflight--;
        finish();
      });
  }

  const proto = Object.getPrototypeOf(sw);
  let f = 0;
  sw.update = function recordedUpdate(deltaTime, dtRatio, resuming) {
    if (f >= frames) return proto.update.call(this, deltaTime, dtRatio, resuming);
    try {
      const bytes = encodeFrame(f);
      pending.push(bytes);
      pendingBytes += bytes.length;
    } catch (e) {
      rec.error = String(e && e.stack ? e.stack : e);
    }
    const t = performance.now();
    proto.update.call(this, deltaTime, dtRatio, resuming);
    live[f] = performance.now() - t;
    clock[f] = t;
    f++;
    rec.frames = f;
    if (pending.length >= args.chunkFrames || f === frames) flush();
    if (f === frames) {
      delete sw.update;
      finish();
    }
  };

  const meta = sw._wasmMeta || {};
  const cfg = sw.config || {};
  return {
    worker: 'spatial',
    n,
    columns: specs,
    entityIdBytes: ew.entityIdBytes(),
    worldWidth: cfg.worldWidth,
    worldHeight: cfg.worldHeight,
    spatial: cfg.spatial || {},
    staggeredUpdates: cfg.logic?.staggeredUpdates === true,
    raycastLights: sw._raycastLights === true,
    collectDetailedStats: sw.collectDetailedStats === true,
    gridMetadata: {
      cellSize: meta.cellSize,
      gridCols: meta.gridCols,
      gridRows: meta.gridRows,
      totalCells: meta.totalCells,
      maxEntitiesPerCell: meta.maxEntitiesPerCell,
      maxNeighbors: meta.maxNeighbors,
      rowsPerBlock: sw.rowsPerBlock,
    },
    registeredClasses: (sw.registeredClasses || []).map((r) => ({
      name: r.name,
      poolSize: r.poolSize,
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      entityType: r.entityType,
      tickInterval: r.tickInterval,
      ticks: r.ticks,
    })),
    logicFrameSlot: slot,
    frameRateStride: sw.frameRateStride,
    workerId: sw.workerId,
    totalSpatialWorkers: sw.totalSpatialWorkers,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

const COMPONENTS = { Transform, Collider, RigidBody, SpriteRenderer, LightEmitter, Grid };

/**
 * Real SpatialWorker instances set up as the recorded scene's (its grid, spatial config, classes, lighting and id
 * width), on fresh memory, with what each frame reads bound where the recording writes it.
 * @param {object} meta the recording's meta.json
 * @param {{ workers?: number }} [opts] workers: how many spatial workers share the frames (the recording's count)
 */
export async function createSpatialReplay(meta, opts = {}) {
  if (meta.worker !== 'spatial') throw new Error(`not a spatial recording: ${meta.worker}`);
  bindEntityIdWidth(meta.entityIdBytes === 4 ? 32 : 16);
  const n = meta.n;
  const g = meta.gridMetadata;
  const W = opts.workers || meta.totalSpatialWorkers || 1;
  const cfg = {
    worldWidth: meta.worldWidth,
    worldHeight: meta.worldHeight,
    cellSize: g.cellSize,
    maxEntitiesPerCell: g.maxEntitiesPerCell,
    maxNeighbors: g.maxNeighbors,
    rowsPerBlock: g.rowsPerBlock,
  };
  const { buffers, gridMetadata, mem } = spatialPublishBuffers(cfg, n, W);
  if (gridMetadata.gridCols !== g.gridCols || gridMetadata.gridRows !== g.gridRows) {
    throw new Error(`replay grid ${gridMetadata.gridCols}x${gridMetadata.gridRows} is not the scene's ${g.gridCols}x${g.gridRows}`);
  }
  buffers.componentData = coreComponentData(n);
  if (meta.raycastLights) buffers.componentData.LightEmitter = new SharedArrayBuffer(LightEmitter.getBufferSize(n));
  const stride = meta.frameRateStride || 16;
  const logicRow = meta.logicFrameSlot >= 0 ? (meta.logicFrameSlot - 1) / stride : -1;
  buffers.frameRateData = new SharedArrayBuffer(Math.max(W, logicRow + 1) * stride * 4);
  buffers.queryVersion = new SharedArrayBuffer(4);
  const frameRate = new Float32Array(buffers.frameRateData);
  const queryVersion = new Int32Array(buffers.queryVersion);
  let moved = null;
  if (meta.movedBound) {
    const sab = createMovedBodiesSab(n);
    bindMovedBodies(sab);
    moved = viewsFromSab(sab);
  } else {
    bindMovedBodies(null);
  }

  const first = await loadWorker('spatialWorker.js', 'spatialWorker');
  const Ctor = first.constructor;
  const classes = (meta.registeredClasses || []).map((r) => ({ ...r, engineProvided: true, components: [] }));
  const workers = [];
  for (let w = 0; w < W; w++) {
    const worker = await quietly(() => new Ctor(globalThis.self));
    await initWorker(worker, {
      config: {
        worldWidth: meta.worldWidth,
        worldHeight: meta.worldHeight,
        spatial: meta.spatial,
        entityIdWidth: meta.entityIdBytes === 4 ? 32 : 16,
        logic: { staggeredUpdates: meta.staggeredUpdates },
        // The worker's own name for it (SpatialWorker._raycastLights) is on when the scene has walls.
        lighting: meta.raycastLights ? { enabled: true, walls: true } : { enabled: false },
        debug: { collectDetailedStats: meta.collectDetailedStats === true },
      },
      globalEntityCount: n,
      buffers,
      gridMetadata,
      extra: {
        workerIndex: w,
        totalSpatialWorkers: W,
        frameRateIndex: w,
        frameRateStride: stride,
        spatialPublishMemory: mem.memory,
        registeredClasses: classes,
        ...(logicRow >= 0 ? { logicFrameRateIndex: logicRow } : {}),
      },
    });
    workers.push(worker);
  }
  bindPoseColumns(n);

  const field = (name) => {
    if (name === 'activeList') return workers[0].activeEntitiesData;
    const dot = name.indexOf('.');
    return COMPONENTS[name.slice(0, dot)][name.slice(dot + 1)] || null;
  };
  const targets = meta.columns.map((s) => {
    const a = field(s.name);
    if (!a) throw new Error(`replay: this tree has no ${s.name}`);
    if (a.BYTES_PER_ELEMENT !== s.bpe || a.length < s.length) {
      throw new Error(`replay: ${s.name} is ${a.constructor.name}[${a.length}], recorded ${s.type}[${s.length}]`);
    }
    return unsignedView(a, s.length);
  });
  const slot = meta.logicFrameSlot;

  return {
    n,
    workers,
    /** Decode the record at `offset` into the columns and shared words; returns the next record's offset. */
    apply(decoder, bytes, offset) {
      const next = decoder.decode(bytes, offset, targets);
      const h = decoder.header;
      if (slot >= 0) frameRate[slot] = h.logicFrame === h.logicFrame ? h.logicFrame : 0;
      queryVersion[0] = h.queryVersion;
      if (moved) {
        if (h.movedLen > 0) moved.movedList.set(h.moved);
        moved.hdrI32[HDR_COUNT] = h.movedCount;
        moved.hdrI32[HDR_GEN] = h.movedGen;
        // A sequence read mid-publish (-1) is odd here, so the worker reads it as torn too.
        moved.hdrI32[HDR_SEQ] = h.movedSeq >= 0 ? h.movedSeq : 1;
      }
      return next;
    },
    /** Each worker's update(), timed: times[w][f] in ms. */
    step(times, f) {
      for (let w = 0; w < workers.length; w++) {
        const t0 = performance.now();
        workers[w].update(16.67, 1, false);
        times[w][f] = performance.now() - t0;
      }
    },
    /** The published neighbour rows: each row's count and the set of its ids (a list's order is the walk's). */
    rowsHash() {
      const nd = Grid.neighborData;
      const rowStride = Grid._stride;
      let h = 2166136261;
      for (let i = 0; i < n; i++) {
        const base = i * rowStride;
        const count = nd[base];
        h = Math.imul(h ^ count, 16777619) >>> 0;
        if (count === 0) continue;
        let s = 0;
        for (let k = 0; k < count; k++) s = (s + Math.imul(nd[base + 1 + k] + 1, 2654435761)) >>> 0;
        h = Math.imul(h ^ s, 16777619) >>> 0;
      }
      return h >>> 0;
    },
    /** What the workers did this frame (their own counters, summed). */
    counters() {
      let rebuilt = 0;
      let published = 0;
      let reused = 0;
      let movers = 0;
      for (const w of workers) {
        rebuilt += w.neighborsRebuiltThisFrame | 0;
        published += w.neighborsPublishedThisFrame | 0;
        reused += w.neighborsReusedThisFrame | 0;
        movers += w._gridMoversThisFrame | 0;
      }
      return { rebuilt, published, reused, movers };
    },
  };
}

/** Byte offsets of the records of a frame stream. */
export function indexRecords(bytes) {
  const offsets = [];
  let off = 0;
  while (off < bytes.length) {
    offsets.push(off);
    const len = new Int32Array(bytes.buffer, bytes.byteOffset + off + 8, 1)[0];
    if (!(len > 0)) throw new Error(`replay: record ${offsets.length - 1} has length ${len}`);
    off += len;
  }
  return offsets;
}

/**
 * The replay itself: a check pass (every frame's rows hashed, and the workers' counters) then `rounds` timed passes,
 * each on fresh workers and memory, so every pass starts from the same state. Returns every frame's time per pass.
 * @param {object} meta
 * @param {Uint8Array} bytes the frame stream (8-aligned in its buffer)
 * @param {{ rounds?: number, check?: boolean, workers?: number, log?: (s: string) => void }} [opts]
 */
export async function runSpatialReplay(meta, bytes, opts = {}) {
  const rounds = opts.rounds ?? 2;
  const check = opts.check !== false;
  const log = opts.log || (() => {});
  const offsets = indexRecords(bytes);
  const F = offsets.length;
  const out = { frames: F, workers: 0, check: null, timed: [] };
  const passes = (check ? 1 : 0) + rounds;
  for (let p = 0; p < passes; p++) {
    const isCheck = check && p === 0;
    const r = await createSpatialReplay(meta, { workers: opts.workers });
    out.workers = r.workers.length;
    const decoder = createReplayDecoder(meta.columns);
    const times = r.workers.map(() => new Float64Array(F));
    const hashes = isCheck ? new Array(F) : null;
    const counters = isCheck ? { rebuilt: [], published: [], reused: [], movers: [] } : null;
    const t0 = performance.now();
    for (let f = 0; f < F; f++) {
      r.apply(decoder, bytes, offsets[f]);
      r.step(times, f);
      if (isCheck) {
        hashes[f] = r.rowsHash();
        const c = r.counters();
        for (const k in counters) counters[k].push(c[k]);
      }
    }
    const pass = {
      times: times.map((t) => Array.from(t, (v) => Math.round(v * 1000) / 1000)),
      finalHash: r.rowsHash(),
      wallMs: Math.round(performance.now() - t0),
    };
    if (isCheck) out.check = { ...pass, hashes, counters };
    else out.timed.push(pass);
    log(`${isCheck ? 'check' : `round ${out.timed.length}`}: ${F} frames, ${pass.wallMs} ms, rows ${pass.finalHash.toString(16)}`);
    if (typeof globalThis.gc === 'function') globalThis.gc();
  }
  return out;
}
