// A MESH layer's per-frame pose work in one pass: trackMeshFillPose decides each mesh's pose source once, compares it
// and every presence with the layer's record and writes what moved, where Pixi ran up to four passes over every
// entity (colliderFillCanSkipPack's scan, meshFillPresenceChanged, meshFillPoseOrPresenceChanged again, then
// copyMeshFillPoseScratch), each deciding every pose again. The old functions are kept below as the reference, as
// they were at a43899ed, and both flows run over random scenes and frames: meshes appearing, disappearing and hidden,
// live poses moving inside and past the 48 px slack, poses published or not, static bodies, rotations not published
// yet, poses of sprites drawn this frame (N-138), views missing columns. Every frame and layer: the same skip
// decision, the same two flags, and the same record (every presence; the pose of every mesh recorded live and
// visible, the only poses anything reads). Where the layer packs, both batches' pose tables: uploadPoseTable takes the
// record's poses and must leave the texels sampling left, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { LAYER_KIND, ShapeType, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { createWeedPosePayload, initWeedPoseDefaults } from '../../src/box2d/box2dHotFields.js';
import {
  trackMeshFillPose,
  colliderFillEpochsMatch,
  colliderFillCanSkipPack,
  MESH_FILL_MOVED,
  MESH_FILL_PRESENCE_MOVED,
  COLLIDER_FILL_PACK_FIRST_FRAME,
  ColliderFillBatch,
} from '../../src/render/colliderFillBatch.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';

// --- The reference: src/render/colliderFillBatch.js's pose functions at a43899ed. ---

const REF_SLACK_SQ = 48 * 48;
const REF_LATCHED = 0;
const REF_LIVE = 1;
const REF_QUEUE = 2;

function refPoseSource(i, views) {
  const frame = views.queueFrame;
  if (frame > 0 && views.queueStamp[i] === frame) return REF_QUEUE;
  if (!views.liveX || !views.liveY) return REF_LATCHED;
  if (views.rbStatic && views.rbStatic[i]) return REF_LIVE;
  const c = views.rotC ? views.rotC[i] : 1;
  const s = views.rotS ? views.rotS[i] : 0;
  if (c * c + s * s <= 0.25) return REF_LIVE;
  const dx = views.liveX[i] - views.x[i];
  const dy = views.liveY[i] - views.y[i];
  return dx * dx + dy * dy > REF_SLACK_SQ ? REF_LIVE : REF_LATCHED;
}

const REF_POSE = new Float64Array(4);

function refReadPose(i, views, source) {
  if (source === REF_QUEUE) {
    const q = views.queuePose;
    const o = i * 4;
    REF_POSE[0] = q[o];
    REF_POSE[1] = q[o + 1];
    REF_POSE[2] = q[o + 2];
    REF_POSE[3] = q[o + 3];
    return REF_POSE;
  }
  const useLive = source === REF_LIVE;
  REF_POSE[0] = useLive ? views.liveX[i] : views.x[i];
  REF_POSE[1] = useLive ? views.liveY[i] : views.y[i];
  if (useLive && views.liveRotC) REF_POSE[2] = views.liveRotC[i];
  else REF_POSE[2] = views.rotC ? views.rotC[i] : 1;
  if (useLive && views.liveRotS) REF_POSE[3] = views.liveRotS[i];
  else REF_POSE[3] = views.rotS ? views.rotS[i] : 0;
  return REF_POSE;
}

function refEnsure(prevPose, entityCount) {
  const n = entityCount | 0;
  if (!prevPose.x || prevPose.x.length < n) {
    prevPose.x = new Float32Array(n);
    prevPose.y = new Float32Array(n);
    prevPose.rotC = new Float32Array(n);
    prevPose.rotS = new Float32Array(n);
    prevPose.active = new Uint8Array(n);
    prevPose.visible = new Uint8Array(n);
  }
  return prevPose;
}

function refCopy(views, prevPose) {
  const n = views.entityCount | 0;
  refEnsure(prevPose, n);
  for (let i = 0; i < n; i++) {
    const pose = refReadPose(i, views, refPoseSource(i, views));
    prevPose.x[i] = pose[0];
    prevPose.y[i] = pose[1];
    prevPose.rotC[i] = pose[2];
    prevPose.rotS[i] = pose[3];
    prevPose.active[i] = views.meshActive[i];
    prevPose.visible[i] = views.meshVisible[i];
  }
}

function refPoseOrPresenceChanged(views, prevPose) {
  const n = views.entityCount | 0;
  const px = prevPose && prevPose.x;
  if (!px || px.length < n) return true;
  for (let i = 0; i < n; i++) {
    const a = views.meshActive[i] | 0;
    const vis = views.meshVisible[i] | 0;
    if ((prevPose.active[i] | 0) !== a || (prevPose.visible[i] | 0) !== vis) return true;
    if (!a || !vis) continue;
    const pose = refReadPose(i, views, refPoseSource(i, views));
    if (pose[0] !== px[i] || pose[1] !== prevPose.y[i] || pose[2] !== prevPose.rotC[i] || pose[3] !== prevPose.rotS[i]) {
      return true;
    }
  }
  return false;
}

function refPresenceChanged(views, prevPose) {
  const n = views.entityCount | 0;
  const pa = prevPose && prevPose.active;
  if (!pa || pa.length < n) return true;
  for (let i = 0; i < n; i++) {
    if ((pa[i] | 0) !== (views.meshActive[i] | 0) || (prevPose.visible[i] | 0) !== (views.meshVisible[i] | 0)) return true;
  }
  return false;
}

function refPaintDirty(views) {
  const ep = views.paintEpoch;
  if (ep) return (ep[0] | 0) !== (views.lastPaintEpoch | 0);
  const d = views.meshDirty;
  if (!d) return false;
  for (let i = 0; i < (views.entityCount | 0); i++) if (d[i]) return true;
  return false;
}

function refCanSkip(views, lastRevision, prevPose) {
  if ((lastRevision | 0) < 0 || !prevPose) return false;
  const rev = views.fixtureRevision ? (views.fixtureRevision[0] | 0) : 0;
  if (rev !== (lastRevision | 0)) return false;
  if (views.meshGeomRevision && (views.meshGeomRevision[0] | 0) !== (views.lastMeshRevision | 0)) return false;
  if (views.outsetEpoch && (views.outsetEpoch[0] | 0) !== (views.lastOutsetEpoch | 0)) return false;
  if (views.meshVertEpoch && Atomics.load(views.meshVertEpoch, 0) !== (views.lastVertEpoch >>> 0)) return false;
  if (views.paintEpoch) {
    if ((views.paintEpoch[0] | 0) !== (views.lastPaintEpoch | 0)) return false;
  } else if (refPaintDirty(views)) {
    return false;
  }
  return !refPoseOrPresenceChanged(views, prevPose);
}

/** ColliderFillBatch.uploadPoseTable at a43899ed, on a batch-like ctx (MeshUvFillBatch's was the same). */
function refUploadPoseTable(ctx, instanceEntity, count, views) {
  const n = count | 0;
  if (n <= 0 || !instanceEntity) return 0;
  const entityCount = views.entityCount | 0;
  const width = 256;
  const height = Math.max(1, ((entityCount + width - 1) / width) | 0);
  const need = width * height * 4;
  if (!ctx.poseTable || ctx.poseTable.length < need) ctx.poseTable = new Float32Array(need);
  if (!ctx._poseGen || ctx._poseGen.length < entityCount) ctx._poseGen = new Int32Array(entityCount);
  const table = ctx.poseTable;
  const gen = ctx._poseGen;
  const stamp = (ctx._poseStamp + 1) | 0 || 1;
  ctx._poseStamp = stamp;
  let k = 0;
  while (k < n) {
    const i = instanceEntity[k] | 0;
    let end = k + 1;
    while (end < n && (instanceEntity[end] | 0) === i) end++;
    k = end;
    if (i < 0 || i >= entityCount || gen[i] === stamp) continue;
    gen[i] = stamp;
    const pose = refReadPose(i, views, refPoseSource(i, views));
    const o = i * 4;
    table[o] = pose[0];
    table[o + 1] = pose[1];
    table[o + 2] = pose[2];
    table[o + 3] = pose[3];
  }
  ctx._poseWidth = width;
  ctx._poseHeight = height;
  ctx._poseDirty = true;
  ctx.mesh.visible = true;
  return n;
}

// --- Random scenes and frames. ---

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which columns the views carry. Pixi's own: every column, the published pose apart from the live one, and with
 * sprite poses (queue) or without; or with the live Transform as its published pose (no pose latched yet). The rest
 * leave columns out, as tests and tools do, and take the pass's general loop.
 */
const SHAPES = {
  pixiQueue: { queue: true },
  pixi: {},
  transformOnly: { latchedIsLive: true },
  transformQueue: { latchedIsLive: true, queue: true },
  noLive: { drop: ['liveX', 'liveY'] },
  noLiveQueue: { drop: ['liveX', 'liveY'], queue: true },
  noLiveRot: { drop: ['liveRotC', 'liveRotS'] },
  noRot: { drop: ['rotC', 'rotS'] },
  noStatic: { drop: ['rbStatic'], queue: true },
  bare: { drop: ['liveX', 'liveY', 'liveRotC', 'liveRotS', 'rotC', 'rotS', 'rbStatic'] },
};

/** The game side's columns (always all of them) and the views on them, which leave out the shape's dropped ones. */
function makeScene(r, size, entityCount, shape) {
  const w = {
    size,
    meshActive: new Uint8Array(size),
    meshVisible: new Uint8Array(size),
    x: new Float32Array(size),
    y: new Float32Array(size),
    rotC: new Float32Array(size),
    rotS: new Float32Array(size),
    liveX: new Float32Array(size),
    liveY: new Float32Array(size),
    liveRotC: new Float32Array(size),
    liveRotS: new Float32Array(size),
    rbStatic: new Uint8Array(size),
    queueStamp: new Int32Array(size),
    queuePose: new Float32Array(size * 4),
  };
  if (shape.latchedIsLive) {
    w.x = w.liveX;
    w.y = w.liveY;
    w.rotC = w.liveRotC;
    w.rotS = w.liveRotS;
  }
  for (let i = 0; i < size; i++) {
    w.meshActive[i] = r() < 0.8 ? 1 : 0;
    w.meshVisible[i] = r() < 0.9 ? 1 : 0;
    w.liveX[i] = r() * 4000;
    w.liveY[i] = r() * 3000;
    const a = r() * Math.PI * 2;
    w.liveRotC[i] = Math.cos(a);
    w.liveRotS[i] = Math.sin(a);
    w.x[i] = w.liveX[i];
    w.y[i] = w.liveY[i];
    w.rotC[i] = w.liveRotC[i];
    w.rotS[i] = w.liveRotS[i];
    w.rbStatic[i] = r() < 0.1 ? 1 : 0;
  }
  const views = {
    entityCount,
    meshActive: w.meshActive,
    meshVisible: w.meshVisible,
    x: w.x,
    y: w.y,
    rotC: w.rotC,
    rotS: w.rotS,
    liveX: w.liveX,
    liveY: w.liveY,
    liveRotC: w.liveRotC,
    liveRotS: w.liveRotS,
    rbStatic: w.rbStatic,
    queueStamp: w.queueStamp,
    queuePose: w.queuePose,
    queueFrame: -1,
    fixtureRevision: new Uint32Array([5]),
    paintEpoch: new Uint32Array([0]),
    lastPaintEpoch: 0,
  };
  for (const k of shape.drop || []) views[k] = null;
  return { w, views };
}

/** One game frame: presence toggles, live moves (inside and past the slack), publishes, turns, static bodies, sprite poses. */
function gameFrame(r, scene, f, shape) {
  const { w, views } = scene;
  // A frame where nothing moved: the layers can skip, unless a repaint or a new fixture asks them to pack.
  if (r() < 0.2) {
    const e = r();
    if (e < 0.15) views.paintEpoch[0]++;
    else if (e < 0.3) views.fixtureRevision[0]++;
    return;
  }
  const n = w.size;
  if (r() < 0.35) {
    for (let k = 0; k < 3; k++) {
      const i = Math.floor(r() * n);
      if (r() < 0.5) w.meshActive[i] ^= 1;
      else w.meshVisible[i] ^= 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.15) {
      w.liveX[i] += (r() - 0.5) * 20;
      w.liveY[i] += (r() - 0.5) * 20;
    } else if (p < 0.19) {
      w.liveX[i] += 60 + r() * 200;
    } else if (p < 0.21) {
      // On the slack exactly: 48 px is not past it.
      w.liveX[i] = w.x[i] + 48;
      w.liveY[i] = w.y[i];
    } else if (p < 0.23) {
      // Written again with what it holds: nothing moved.
      w.liveX[i] = w.liveX[i];
    }
    if (r() < 0.05) {
      const a = r() * Math.PI * 2;
      w.liveRotC[i] = Math.cos(a);
      w.liveRotS[i] = Math.sin(a);
    }
    if (r() < 0.25) {
      // The renderer's published pose catches up with the live one.
      w.x[i] = w.liveX[i];
      w.y[i] = w.liveY[i];
      w.rotC[i] = w.liveRotC[i];
      w.rotS[i] = w.liveRotS[i];
    }
    const g = r();
    if (g < 0.02) {
      // A life whose rotation is not published yet.
      w.rotC[i] = 0;
      w.rotS[i] = 0;
    } else if (g < 0.03) {
      // On the gate: 0.25 is still not published.
      w.rotC[i] = 0.5;
      w.rotS[i] = 0;
    }
    if (r() < 0.02) w.rbStatic[i] ^= 1;
  }
  // A pose that is not a number never compares equal: it moves every frame it is shown, in both flows. A published
  // rotation that is not a number passes the gate (NaN <= 0.25 is false) to the slack test.
  if (r() < 0.05) w.liveX[0] = Number.isNaN(w.liveX[0]) ? r() * 4000 : NaN;
  if (r() < 0.1) w.rotC[1] = Number.isNaN(w.rotC[1]) ? 1 : NaN;
  if (shape.queue) {
    // Pre-render's list: the meshes whose sprite it drew this frame, at that sprite's pose. Now and then no frame.
    views.queueFrame = r() < 0.1 ? (r() < 0.5 ? 0 : -1) : f + 1;
    for (let i = 0; i < n; i++) {
      if (r() < 0.4) {
        w.queueStamp[i] = f + 1;
        const o = i * 4;
        w.queuePose[o] = w.liveX[i] - r() * 6;
        w.queuePose[o + 1] = w.liveY[i] + r() * 6;
        w.queuePose[o + 2] = w.liveRotC[i];
        w.queuePose[o + 3] = r() < 0.05 ? 0 : w.liveRotS[i];
      }
    }
  }
  if (r() < 0.05) views.fixtureRevision[0]++;
  if (r() < 0.05) views.paintEpoch[0]++;
}

/** Records equal where anything reads them: every presence, and the pose of every mesh recorded live and visible. */
function assertSameRecord(ref, rec, n, where) {
  assert.ok(rec.x.length >= n && rec.active.length >= n, `${where}: the record holds every entity`);
  const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const cols = ['x', 'y', 'rotC', 'rotS'];
  const refBits = cols.map((k) => bits(ref[k]));
  const recBits = cols.map((k) => bits(rec[k]));
  for (let i = 0; i < n; i++) {
    assert.equal(rec.active[i], ref.active[i], `${where}: active[${i}]`);
    assert.equal(rec.visible[i], ref.visible[i], `${where}: visible[${i}]`);
    if (!ref.active[i] || !ref.visible[i]) continue;
    for (let k = 0; k < 4; k++) {
      assert.equal(recBits[k][i], refBits[k][i], `${where}: ${cols[k]}[${i}] ${rec[cols[k]][i]} vs ${ref[cols[k]][i]}`);
    }
  }
}

/** What uploadPoseTable takes from the record: each live, visible mesh's pose this frame, as a Float32. */
function assertRecordHoldsFramePoses(views, rec, n, where) {
  const f32 = new Float32Array(4);
  const want = new Uint32Array(f32.buffer);
  const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const have = [bits(rec.x), bits(rec.y), bits(rec.rotC), bits(rec.rotS)];
  for (let i = 0; i < n; i++) {
    if (!(views.meshActive[i] | 0) || !(views.meshVisible[i] | 0)) continue;
    f32.set(refReadPose(i, views, refPoseSource(i, views)));
    for (let k = 0; k < 4; k++) assert.equal(have[k][i], want[k], `${where}: entity ${i}, pose column ${k}`);
  }
}

/** A batch's pose table state as its constructor leaves it. */
function tableCtx() {
  return { poseTable: new Float32Array(256 * 4), mesh: { visible: false } };
}

/**
 * A layer as Pixi keeps it: the record, the revision and paint epoch of its last pack, and per batch the pose table as
 * the old upload left it (ref), as the shipped one leaves it from the record (rec) and without a record (sampled).
 */
function makeLayer(record) {
  return {
    ref: {},
    rec: record,
    lastRevision: COLLIDER_FILL_PACK_FIRST_FRAME,
    lastPaintEpoch: -1,
    tables: [0, 1].map(() => ({ ref: tableCtx(), rec: tableCtx(), sampled: tableCtx() })),
  };
}

/**
 * A batch's instance list, as its pack writes it: in entity order, a run of rows per live, visible mesh the batch
 * takes. Now and then a mesh hidden at this frame's pass (packed after its presence moved), an entity again after
 * others, and ids past the entities (written by neither upload).
 */
function instanceList(r, views, takes) {
  const ids = [];
  const n = views.entityCount;
  for (let i = 0; i < n; i++) {
    if (!takes(i)) continue;
    if ((!views.meshActive[i] || !views.meshVisible[i]) && r() > 0.05) continue;
    const run = 1 + Math.floor(r() * 4);
    for (let k = 0; k < run; k++) ids.push(i);
  }
  if (ids.length > 0 && r() < 0.2) ids.push(ids[0]);
  if (r() < 0.1) ids.push(n + 3);
  if (r() < 0.05) ids.push(0xffffffff);
  return Uint32Array.from(ids);
}

function assertSameTable(want, have, where) {
  assert.equal(have.length, want.length, `${where}: table length`);
  const a = new Uint32Array(want.buffer, want.byteOffset, want.length);
  const b = new Uint32Array(have.buffer, have.byteOffset, have.length);
  for (let q = 0; q < a.length; q++) {
    if (a[q] !== b[q]) assert.fail(`${where}: texel float ${q} (entity ${q >> 2}): ${have[q]}, sampled ${want[q]}`);
  }
}

/**
 * A packing layer's uploads: each batch's list through the old upload, the shipped one with the record, and the
 * shipped one without; the same texels all three. Counts the texels taken from the record and sampled past it.
 */
function uploadTables(r, views, layer, where, tally) {
  for (let b = 0; b < 2; b++) {
    const list = instanceList(r, views, (i) => ((i * 7 + b) % 3) !== 0);
    const t = layer.tables[b];
    const proto = b === 0 ? ColliderFillBatch.prototype : MeshUvFillBatch.prototype;
    const count = list.length;
    const want = refUploadPoseTable(t.ref, list, count, views);
    assert.equal(proto.uploadPoseTable.call(t.rec, list, count, views, layer.rec), want, `${where}: batch ${b} count`);
    assert.equal(proto.uploadPoseTable.call(t.sampled, list, count, views), want, `${where}: batch ${b} count, sampled`);
    assertSameTable(t.ref.poseTable, t.rec.poseTable, `${where}: batch ${b} from the record`);
    assertSameTable(t.ref.poseTable, t.sampled.poseTable, `${where}: batch ${b} sampled`);
    for (const ctx of [t.rec, t.sampled]) {
      assert.equal(ctx._poseWidth, t.ref._poseWidth);
      assert.equal(ctx._poseHeight, t.ref._poseHeight);
      assert.equal(ctx.mesh.visible, t.ref.mesh.visible);
    }
    const seen = new Set();
    for (const id of list) {
      const i = id | 0;
      if (i < 0 || i >= views.entityCount || seen.has(i)) continue;
      seen.add(i);
      if (layer.rec.active[i] && layer.rec.visible[i]) tally.fromRecord++;
      else tally.sampledPastRecord++;
    }
  }
}

/**
 * Both flows on one scene: per frame, each layer's skip decision and flags as the old functions answer them on the old
 * record, then trackMeshFillPose's on its own. Layer 1 starts on frame 3 with a record of empty arrays (Pixi's), layer
 * 0 on frame 0 with an empty object (the old Pixi's).
 */
function runScene(seed, shapeName, { size = 160, frames = 90, growAt = -1, shrinkBy = 0 } = {}) {
  const shape = SHAPES[shapeName];
  const r = rng(seed);
  const scene = makeScene(r, size, size - shrinkBy, shape);
  const { views } = scene;
  const empty = () => ({
    x: new Float32Array(0),
    y: new Float32Array(0),
    rotC: new Float32Array(0),
    rotS: new Float32Array(0),
    active: new Uint8Array(0),
    visible: new Uint8Array(0),
  });
  const layers = [makeLayer({}), makeLayer(empty())];
  const tally = {
    skip: 0,
    pack: 0,
    presence: 0,
    pose: 0,
    queue: 0,
    liveStatic: 0,
    liveGate: 0,
    liveSlack: 0,
    latched: 0,
    fromRecord: 0,
    sampledPastRecord: 0,
  };
  for (let f = 0; f < frames; f++) {
    if (f > 0) gameFrame(r, scene, f, shape);
    if (f === growAt) views.entityCount = size;
    const n = views.entityCount;
    for (let i = 0; i < n; i++) {
      if (!views.meshActive[i] || !views.meshVisible[i]) continue;
      const src = refPoseSource(i, views);
      if (src === REF_QUEUE) tally.queue++;
      else if (src === REF_LATCHED) tally.latched++;
      else if (views.rbStatic && views.rbStatic[i]) tally.liveStatic++;
      else if (!views.rotC || views.rotC[i] * views.rotC[i] + views.rotS[i] * views.rotS[i] <= 0.25) tally.liveGate++;
      else tally.liveSlack++;
    }
    for (let L = 0; L < layers.length; L++) {
      if (L === 1 && f < 3) continue;
      const layer = layers[L];
      const where = `${shapeName} seed ${seed} frame ${f} layer ${L}`;
      views.lastPaintEpoch = layer.lastPaintEpoch;
      // The old flow on its record.
      const wantSkip = refCanSkip(views, layer.lastRevision, layer.ref);
      const wantPresence = refPresenceChanged(views, layer.ref);
      const wantMoved = refPoseOrPresenceChanged(views, layer.ref);
      assert.equal(colliderFillCanSkipPack(views, layer.lastRevision, layer.ref), wantSkip, `${where}: colliderFillCanSkipPack`);
      if (!wantSkip) refCopy(views, layer.ref);
      // The new one on its own.
      const moved = trackMeshFillPose(views, layer.rec);
      const skip = moved === 0 && colliderFillEpochsMatch(views, layer.lastRevision);
      assert.equal(skip, wantSkip, `${where}: skip`);
      assert.equal(moved & ~(MESH_FILL_MOVED | MESH_FILL_PRESENCE_MOVED), 0, `${where}: flags`);
      assert.equal((moved & MESH_FILL_PRESENCE_MOVED) !== 0, wantPresence, `${where}: presence moved`);
      assert.equal(moved !== 0, wantMoved, `${where}: pose or presence moved`);
      if (moved & MESH_FILL_PRESENCE_MOVED) assert.ok(moved & MESH_FILL_MOVED, `${where}: a presence move is a move`);
      assertSameRecord(layer.ref, layer.rec, n, where);
      assertRecordHoldsFramePoses(views, layer.rec, n, where);
      if (skip) {
        tally.skip++;
      } else {
        tally.pack++;
        uploadTables(r, views, layer, where, tally);
        layer.lastRevision = views.fixtureRevision[0] | 0;
        layer.lastPaintEpoch = views.paintEpoch[0] | 0;
      }
      if (wantPresence) tally.presence++;
      if (wantMoved && !wantPresence) tally.pose++;
    }
  }
  return tally;
}

test("trackMeshFillPose decides, flags and records as the old passes did, on Pixi's views", () => {
  for (const shapeName of ['pixiQueue', 'pixi', 'transformOnly', 'transformQueue']) {
    const total = {};
    for (let seed = 1; seed <= 6; seed++) {
      const t = runScene(0x5eed + seed * 977, shapeName);
      for (const k in t) total[k] = (total[k] || 0) + t[k];
    }
    // Every case the pass decides came up.
    assert.ok(total.skip > 20 && total.pack > 20, `${shapeName}: skips ${total.skip}, packs ${total.pack}`);
    assert.ok(total.presence > 20 && total.pose > 20, `${shapeName}: presence moves ${total.presence}, pose moves ${total.pose}`);
    assert.ok(total.liveStatic > 0 && total.liveGate > 0, `${shapeName}: static ${total.liveStatic}, gate ${total.liveGate}`);
    if (shapeName.startsWith('pixi')) assert.ok(total.liveSlack > 0 && total.latched > 0, `${shapeName}: slack ${total.liveSlack}, latched ${total.latched}`);
    if (shapeName.endsWith('Queue')) assert.ok(total.queue > 0, `${shapeName}: sprite poses ${total.queue}`);
  }
});

test('uploadPoseTable from the record leaves the texels sampling leaves, in both batches', () => {
  const total = {};
  for (const shapeName of Object.keys(SHAPES)) {
    for (let seed = 1; seed <= 2; seed++) {
      const t = runScene(0x7ab1e + seed * 31, shapeName, { size: 300, frames: 50 });
      for (const k in t) total[k] = (total[k] || 0) + t[k];
    }
  }
  // Both ways a texel is written: from the record, and sampled for a mesh the record saw hidden.
  assert.ok(total.fromRecord > 10000, `${total.fromRecord} texels from the record`);
  assert.ok(total.sampledPastRecord > 100, `${total.sampledPastRecord} sampled past it`);
});

test('uploadPoseTable with the record sends the pose this frame was decided on, not one written since', () => {
  const { w, views } = makeScene(rng(9), 4, 4, SHAPES.pixi);
  w.meshActive.fill(1);
  w.meshVisible.fill(1);
  w.rbStatic.fill(1);
  const record = {};
  trackMeshFillPose(views, record);
  // Logic moves entity 2 after the pass, before the upload.
  const decided = w.liveX[2];
  w.liveX[2] = decided + 100;
  const ids = new Uint32Array([0, 1, 2, 2, 3]);
  for (const proto of [ColliderFillBatch.prototype, MeshUvFillBatch.prototype]) {
    const fromRecord = tableCtx();
    proto.uploadPoseTable.call(fromRecord, ids, ids.length, views, record);
    assert.equal(fromRecord.poseTable[2 * 4], decided, 'the pose the record holds, which the layer compares next frame');
    const sampled = tableCtx();
    proto.uploadPoseTable.call(sampled, ids, ids.length, views);
    assert.equal(sampled.poseTable[2 * 4], w.liveX[2], 'without it, the pose read now');
  }
});

test('trackMeshFillPose matches the old passes on views without some pose column', () => {
  for (const shapeName of ['noLive', 'noLiveQueue', 'noLiveRot', 'noRot', 'noStatic', 'bare']) {
    for (let seed = 1; seed <= 3; seed++) {
      const t = runScene(0xc01 + seed * 131, shapeName, { size: 96, frames: 60 });
      assert.ok(t.skip > 0 && t.pack > 0, `${shapeName}: skips ${t.skip}, packs ${t.pack}`);
    }
  }
});

test('a record that holds fewer entities than the views is grown, and everything moved', () => {
  for (const shapeName of ['pixiQueue', 'pixi', 'bare']) {
    runScene(0xa11, shapeName, { size: 120, frames: 40, growAt: 17, shrinkBy: 9 });
  }
  const views = makeScene(rng(3), 8, 8, SHAPES.pixi).views;
  for (const record of [{}, { x: new Float32Array(4), active: new Uint8Array(8) }, { x: new Float32Array(8), active: new Uint8Array(0) }]) {
    assert.equal(trackMeshFillPose(views, record), MESH_FILL_MOVED | MESH_FILL_PRESENCE_MOVED);
    assert.equal(record.x.length, 8);
    assert.equal(record.visible.length, 8);
    assert.equal(trackMeshFillPose(views, record), 0, 'the next frame holds still');
  }
  // A record short of the views moved, even when no mesh is live: the old scan answered so before comparing anything.
  views.meshActive.fill(0);
  views.meshVisible.fill(0);
  assert.equal(refPoseOrPresenceChanged(views, {}), true);
  assert.equal(trackMeshFillPose(views, {}), MESH_FILL_MOVED | MESH_FILL_PRESENCE_MOVED);
  // No entity, no move: the old passes found none either (a record of empty arrays).
  const none = makeScene(rng(4), 4, 0, SHAPES.pixi).views;
  assert.equal(trackMeshFillPose(none, { x: new Float32Array(0), active: new Uint8Array(0) }), 0);
});

// --- Pixi's real MESH layer pass (initializeCustomLayers, then updateCustomLayers a frame), as meshCornersWired runs it. ---

const W_N = 64;
const W_FRAMES = 160;
const W_SHADERS = {
  colliderFill: fs.readFileSync(new URL('../../src/shaders/colliderFill.wgsl', import.meta.url), 'utf8'),
  meshUvFill: fs.readFileSync(new URL('../../src/shaders/meshUvFill.wgsl', import.meta.url), 'utf8'),
};

class PoseThing extends GameObject {}
PoseThing.components = [RigidBody, Collider, MeshRenderer];

/** The main thread's shared buffers: W_N entities, two MESH layers. */
function buildWiredScene() {
  Query.reset();
  const scene = {
    totalEntityCount: W_N,
    nextComponentId: 4,
    registeredClasses: [{ class: PoseThing, count: W_N, startIndex: 0, entityType: 0, components: PoseThing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      MeshRenderer: { ComponentClass: MeshRenderer },
    },
    config: {
      worldWidth: 4000,
      worldHeight: 3000,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { enabled: false, maxJoints: 0 },
      spatial: { cellSize: 100, maxNeighbors: 8, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 100, maxMeshVerts: 4096, maxMeshIndices: 12288 },
      layers: { a: { kind: LAYER_KIND.MESH, zIndex: 2 }, b: { kind: LAYER_KIND.MESH, zIndex: 3 } },
      wasm: { ...WASM_DEFAULTS },
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
  createSceneSharedBuffers(scene);
  scene.weedPose = createWeedPosePayload(W_N);
  initWeedPoseDefaults(scene.weedPose);
  return scene;
}

async function initWiredPixi(px, scene) {
  px._colliderFillSkip = [];
  px._colliderFillViews = null;
  px._colliderFillLayerCount = -1;
  px._customLayerList = [];
  px.globalEntityCount = scene.totalEntityCount;
  px.config = scene.config;
  px._useWebGpu = true;
  px._engineShaders = W_SHADERS;
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: null };
  await px.initializeCustomLayers({
    config: scene.config,
    layerData: Layer.getSerializableData(),
    customLayerRenderQueues: scene.customLayerRenderQueues,
    meshGeom: {
      enabled: true,
      maxMeshVerts: 4096,
      maxMeshIndices: 12288,
      entityCount: scene.totalEntityCount,
      data: scene.buffers.meshGeomData,
      memory: scene.meshMemory?.memory || null,
      layout: scene.meshMemory?.layout || null,
    },
  });
}

const W_QUAD = [-16, -12, 16, -12, 16, 12, -16, 12];

function wiredFan(r, n) {
  const xy = [];
  const rad = 10 + r() * 10;
  for (let i = 0; i < n; i++) xy.push(Math.cos((i / n) * Math.PI * 2) * rad, Math.sin((i / n) * Math.PI * 2) * rad);
  return xy;
}

/**
 * The game side of one frame: presence toggles, live moves inside and past the slack, the renderer's published pose
 * catching up (Pixi's _poseX columns), rotations not published yet, static bodies, sprite poses of this frame, a
 * repaint, vertex edits. A fifth of the frames move no pose: some change nothing, some only repaint or edit vertices.
 */
function wiredGameFrame(r, px, api, f) {
  const n = W_N;
  if (r() < 0.2) {
    const e = r();
    if (e < 0.25) api[Math.floor(r() * n)].tint = Math.floor(r() * 0xffffff);
    else if (e < 0.5) {
      const i = 1 + 4 * Math.floor(r() * (n / 4));
      if (MeshGeometry.vertOffset[i] >= 0) api[i].setVertices(wiredFan(r, MeshGeometry.vertCount[i]));
    }
    return;
  }
  if (r() < 0.35) {
    for (let k = 0; k < 2; k++) {
      const i = Math.floor(r() * n);
      if (r() < 0.5) MeshRenderer.active[i] ^= 1;
      else MeshRenderer.renderVisible[i] ^= 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.15) {
      Transform.x[i] += (r() - 0.5) * 20;
      Transform.y[i] += (r() - 0.5) * 20;
    } else if (p < 0.19) {
      Transform.x[i] += 60 + r() * 200;
    } else if (p < 0.21) {
      Transform.x[i] = px._poseX[i] + 48;
      Transform.y[i] = px._poseY[i];
    }
    if (r() < 0.05) {
      const a = r() * Math.PI * 2;
      Transform.rotC[i] = Math.cos(a);
      Transform.rotS[i] = Math.sin(a);
    }
    if (r() < 0.25) {
      px._poseX[i] = Transform.x[i];
      px._poseY[i] = Transform.y[i];
      px._poseRotC[i] = Transform.rotC[i];
      px._poseRotS[i] = Transform.rotS[i];
    }
    if (r() < 0.02) {
      px._poseRotC[i] = 0;
      px._poseRotS[i] = 0;
    }
    if (r() < 0.02) RigidBody.static[i] ^= 1;
  }
  // Pre-render's list for the frame Pixi takes: the meshes whose sprite it drew, at that sprite's pose.
  px.lastReadFrame = r() < 0.1 ? -1 : f + 1;
  for (let i = 0; i < n; i++) {
    if (r() < 0.4) {
      px._meshQueueStamp[i] = f + 1;
      const o = i * 4;
      px._meshQueuePose[o] = Transform.x[i] - r() * 6;
      px._meshQueuePose[o + 1] = Transform.y[i] + r() * 6;
      px._meshQueuePose[o + 2] = Transform.rotC[i];
      px._meshQueuePose[o + 3] = Transform.rotS[i];
    }
  }
  if (r() < 0.1) api[Math.floor(r() * n)].tint = Math.floor(r() * 0xffffff);
  if (r() < 0.2) {
    const i = 1 + 4 * Math.floor(r() * (n / 4));
    if (MeshGeometry.vertOffset[i] >= 0) api[i].setVertices(wiredFan(r, MeshGeometry.vertCount[i]));
  }
}

test("Pixi's MESH layers decide, record and upload as the old passes did", async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const scene = await quietly(() => buildWiredScene());
  // The published pose apart from the live Transform, and sprite poses; bound before the first frame builds the views.
  px._poseX = new Float32Array(W_N);
  px._poseY = new Float32Array(W_N);
  px._poseRotC = new Float32Array(W_N);
  px._poseRotS = new Float32Array(W_N);
  px._meshPoseLists = [{}, {}];
  px._meshQueueStamp = new Int32Array(W_N);
  px._meshQueuePose = new Float32Array(W_N * 4);
  await quietly(() => initWiredPixi(px, scene));
  const ids = [Layer.get('a').id, Layer.get('b').id];
  const layers = ids.map((id) => px._customLayers[id]);
  assert.ok(layers.every((cl) => cl?.fillBatch), 'both MESH layers have their fill batch');

  const r = rng(0x9a55);
  const api = [];
  for (let i = 0; i < W_N; i++) {
    const mr = new MeshRenderer(i);
    api.push(mr);
    MeshRenderer.active[i] = 1;
    MeshRenderer.layerMask[i] = i % 3 === 0 ? 1 << ids[0] : i % 3 === 1 ? 1 << ids[1] : (1 << ids[0]) | (1 << ids[1]);
    Transform.x[i] = 100 + r() * 3000;
    Transform.y[i] = 100 + r() * 2000;
    const a = r() * Math.PI * 2;
    Transform.rotC[i] = Math.cos(a);
    Transform.rotS[i] = Math.sin(a);
    px._poseX[i] = Transform.x[i];
    px._poseY[i] = Transform.y[i];
    px._poseRotC[i] = Transform.rotC[i];
    px._poseRotS[i] = Transform.rotS[i];
    const kind = i % 4;
    // UV rows (the UV batch), a mesh without UVs and a collider box (the fill batch), a plane (the UV batch).
    if (kind === 0) mr.setMesh(W_QUAD, [0, 1, 2, 0, 2, 3], [0, 0, 1, 0, 1, 1, 0, 1]);
    else if (kind === 1) mr.setMesh(wiredFan(r, 6));
    else if (kind === 3) mr.setPlane(40, 30, 2, 2);
    else {
      Collider.shapeType[i] = ShapeType.Box;
      Collider.width[i] = 20;
      Collider.height[i] = 12;
    }
  }

  // What the frame did, per layer (its skip object) and batch.
  const log = { nonSkip: new Set(), full: new Set(), failedRewrite: new Set(), uploads: new Set() };
  const proto = Object.getPrototypeOf(px);
  px._ensureVertGenScratch = function (skip, views) {
    log.nonSkip.add(skip);
    return proto._ensureVertGenScratch.call(this, skip, views);
  };
  px._packMeshUvLayer = function (cl, views, skip) {
    log.full.add(skip);
    return proto._packMeshUvLayer.call(this, cl, views, skip);
  };
  px._rewriteMeshCorners = function (...args) {
    const code = proto._rewriteMeshCorners.apply(this, args);
    if (code < 0) log.failedRewrite.add(args[2]);
    return code;
  };
  // Each upload against the old one on a table of its own, the table the old flow would have left on the batch.
  const refTables = new Map();
  // A batch's fields before its first upload: the uploads add none (its constructor declares them).
  const keysAtBirth = new Map();
  const keys = (batch) => Object.keys(batch).filter((k) => k !== 'uploadPoseTable').join();
  let compared = 0;
  const spy = (batch, name) => {
    const own = Object.getPrototypeOf(batch).uploadPoseTable;
    keysAtBirth.set(batch, keys(batch));
    refTables.set(batch, tableCtx());
    batch.uploadPoseTable = function (instanceEntity, count, views, framePose) {
      log.uploads.add(name);
      assert.ok(framePose && framePose.x, `${name}: the upload has the layer's record`);
      refUploadPoseTable(refTables.get(this), instanceEntity, count, views);
      const n = own.call(this, instanceEntity, count, views, framePose);
      assertSameTable(refTables.get(this).poseTable, this.poseTable, `${name} after ${compared} uploads`);
      compared++;
      return n;
    };
  };
  layers.forEach((cl, L) => spy(cl.fillBatch, `layer ${L} fill`));
  px._ensureMeshUvBatch = function (cl) {
    const had = cl.uvFillBatch;
    const batch = proto._ensureMeshUvBatch.call(this, cl);
    if (batch && batch !== had) spy(batch, `layer ${layers.indexOf(cl)} uv`);
    return batch;
  };

  const refs = layers.map(() => ({}));
  const tally = { skip: 0, full: 0, poseOnly: 0, packNoPose: 0, presence: 0 };
  try {
    await quietly(() => {
      for (let f = 0; f < W_FRAMES; f++) {
        if (f > 0) wiredGameFrame(r, px, api, f);
        // The old flow's answers, from what each layer holds before the frame.
        const views = px._ensureColliderFillViews();
        const want = layers.map((cl, L) => {
          const skip = px._colliderFillSkip[cl.layerId];
          const v = {
            ...views,
            lastPaintEpoch: skip ? skip.lastPaintEpoch : -1,
            lastMeshRevision: skip ? skip.lastMeshRevision | 0 : 0,
            lastOutsetEpoch: skip ? skip.lastOutsetEpoch | 0 : 0,
            lastVertEpoch: skip ? skip.lastVertEpoch >>> 0 : 0,
          };
          const lastRevision = skip ? skip.lastRevision : COLLIDER_FILL_PACK_FIRST_FRAME;
          const presence = refPresenceChanged(v, refs[L]);
          return {
            v,
            skip: refCanSkip(v, lastRevision, refs[L]),
            presence,
            moved: refPoseOrPresenceChanged(v, refs[L]),
            topologyStable:
              lastRevision !== COLLIDER_FILL_PACK_FIRST_FRAME &&
              (v.fixtureRevision ? v.fixtureRevision[0] | 0 : 0) === (lastRevision | 0) &&
              (v.meshGeomRevision ? v.meshGeomRevision[0] | 0 : 0) === v.lastMeshRevision &&
              (v.outsetEpoch ? v.outsetEpoch[0] | 0 : 0) === v.lastOutsetEpoch &&
              !presence,
            fillCount: cl.prevCount | 0,
            uvCount: cl.uvPrevCount | 0,
          };
        });
        log.nonSkip.clear();
        log.full.clear();
        log.failedRewrite.clear();
        log.uploads.clear();
        px.updateCustomLayers();
        layers.forEach((cl, L) => {
          const e = want[L];
          const skip = px._colliderFillSkip[cl.layerId];
          const where = `frame ${f} layer ${L}`;
          assert.equal(!log.nonSkip.has(skip), e.skip, `${where}: skip`);
          const fillUp = log.uploads.has(`layer ${L} fill`);
          const uvUp = log.uploads.has(`layer ${L} uv`);
          if (e.skip) {
            assert.ok(!fillUp && !uvUp, `${where}: a skipped layer uploads no pose`);
            tally.skip++;
          } else {
            const full = log.full.has(skip);
            const failed = log.failedRewrite.has(skip.instanceEntity) || log.failedRewrite.has(skip.uvInstanceEntity);
            assert.equal(full, !e.topologyStable || failed, `${where}: full pack`);
            if (full) {
              assert.equal(fillUp, (cl.prevCount | 0) > 0, `${where}: fill pose table after the pack`);
              assert.equal(uvUp, !!cl.uvFillBatch && (cl.uvPrevCount | 0) > 0, `${where}: UV pose table after the pack`);
              tally.full++;
            } else {
              assert.equal(fillUp, e.moved && e.fillCount > 0, `${where}: fill pose table`);
              assert.equal(uvUp, e.moved && !!cl.uvFillBatch && e.uvCount > 0, `${where}: UV pose table`);
              if (e.moved) tally.poseOnly++;
              else tally.packNoPose++;
            }
            refCopy(e.v, refs[L]);
          }
          if (e.presence) tally.presence++;
          assertSameRecord(refs[L], skip.prevPose, W_N, where);
        });
      }
    });
  } finally {
    delete px._ensureVertGenScratch;
    delete px._packMeshUvLayer;
    delete px._rewriteMeshCorners;
    delete px._ensureMeshUvBatch;
    px._meshPoseLists = [];
    px.lastReadFrame = -1;
    px._poseX = null;
  }
  assert.ok(layers.every((cl) => cl.uvFillBatch), 'both layers draw UV rows too');
  assert.ok(compared > W_FRAMES, `${compared} pose tables compared`);
  assert.equal(keysAtBirth.size, 4);
  for (const [batch, born] of keysAtBirth) assert.equal(keys(batch), born, `${batch.mesh.label}: no field added after construction`);
  assert.ok(tally.skip > 10 && tally.full > 10 && tally.poseOnly > 50 && tally.packNoPose > 5, JSON.stringify(tally));
});
