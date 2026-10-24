// E-76 W11: the mesh corner rewrite kernel (wasm/test/meshCorners.c, a test module, through the bench's
// rewriteCornersWasm) against the shipped rewriteExplicitMeshCorners, in one memory that starts with the
// MeshGeometry block as meshCornersWasmMicrobench lays it out. Random frames are written straight into the
// columns, so they reach what the MeshRenderer API never makes: fans and index lists, with and without the UV
// batch's corners, generations equal and not, entities with no mesh, ids past the geometry columns, past the
// generations and past 2^31 (negative as int32), drawn generations shorter than the captured ones, runs a
// triangle short or long, runs of one entity split in two, meshes under 3 vertices, corner indices past the
// mesh, spans that run past the vertex or index column (undefined reads: NaN corners, index 0), strides that
// overlap rows, no UV columns, the live generations instead of a capture, and empty calls. Corners hold NaN with
// payloads, both zeros, infinities and subnormals. Each frame: the same return code, and every word of the row
// region (the corners and the pose, paint and depth words the rewrite must leave alone) bit for bit.
// Signaling NaNs are left out: V8 quiets them on some JS tiers and not others, and the API stores finite values.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS, rewriteExplicitMeshCorners } from '../../src/render/colliderFillBatch.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { bindMeshCorners, MESH_CORNER_SLOTS, rewriteCornersWasm, setupMeshCornersKernel } from '../bench/meshCornersWasmMicrobench.mjs';

const E = 48;
const GEN_EXTRA = 8;
const GEN_ROOM = E + 16;
const V = 1024;
const I = 3072;
const CAP = 600;
const MAX_STEP = 30;
const FRAMES = 800;

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

const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);
/** NaN (canonical, negative, with a payload), both zeros, both infinities, subnormals. */
const SPECIAL = [0x7fc00000, 0xffc00000, 0x7fc0beef, 0x80000000, 0x00000000, 0x7f800000, 0xff800000, 0x00000001, 0x807fffff];

function cornerBits(r) {
  if (r() < 0.08) return SPECIAL[Math.floor(r() * SPECIAL.length)];
  f32[0] = (r() - 0.5) * 400;
  return f32Bits[0];
}

async function setup() {
  const layout = layoutRegions([
    { name: 'meshGeometry', owner: 'test', bytes: MeshGeometry.getBufferSize(V, I, E) },
    { name: 'rows', owner: 'test', bytes: CAP * MAX_STEP * 4 },
    { name: 'entity', owner: 'test', bytes: CAP * 4 },
    { name: 'gen', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'last', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'table', owner: 'test', bytes: MESH_CORNER_SLOTS.length * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(buffer, V, I, E);
  const g = MeshGeometry;
  const geom = {
    vertOffset: g.vertOffset, vertCount: g.vertCount, indexOffset: g.indexOffset, indexCount: g.indexCount,
    vertexX: g.vertexX, vertexY: g.vertexY, uvU: g.uvU, uvV: g.uvV, indices: g.indices,
  };
  const b = await bindMeshCorners(memory, R.table.byte, geom);
  const words = (view) => new Uint32Array(buffer, view.byteOffset, view.length);
  return {
    b,
    geom,
    vertGen: g.vertGen,
    corners: [words(g.vertexX), words(g.vertexY), words(g.uvU), words(g.uvV)],
    out: new Float32Array(buffer, R.rows.byte, CAP * MAX_STEP),
    outWords: new Uint32Array(buffer, R.rows.byte, CAP * MAX_STEP),
    entity: new Uint32Array(buffer, R.entity.byte, CAP),
    gen: new Uint32Array(buffer, R.gen.byte, GEN_ROOM),
    last: new Uint32Array(buffer, R.last.byte, GEN_ROOM),
  };
}

function viewsOf(s) {
  const g = s.geom;
  return {
    meshVertOffset: g.vertOffset, meshVertCount: g.vertCount, meshIndexOffset: g.indexOffset, meshIndexCount: g.indexCount,
    meshVertexX: g.vertexX, meshVertexY: g.vertexY, meshUvU: g.uvU, meshUvV: g.uvV, meshIndices: g.indices,
    meshVertGen: s.vertGen,
  };
}

/**
 * One frame's MeshGeometry, written into the columns. Mode 2 puts vertex spans past the column's end, mode 3
 * index spans, mode 5 corner indices past the mesh; mode 4 makes meshes under 3 vertices. Returns each
 * entity's triangle count as rewriteExplicitMeshCorners works it out (need), for the instance lists.
 */
function writeGeometry(r, s, mode) {
  for (const w of s.corners) for (let q = 0; q < V; q++) w[q] = cornerBits(r);
  const g = s.geom;
  let vAt = 0;
  let iAt = 0;
  const need = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const kind = r();
    g.indexCount[e] = Math.floor(r() * 4294967296); // read only for an index list
    if (kind < 0.12) {
      g.vertOffset[e] = -1 - Math.floor(r() * 3);
      g.vertCount[e] = Math.floor(r() * 9);
      g.indexOffset[e] = r() < 0.5 ? -1 : Math.floor(r() * I);
      continue;
    }
    let vN = 3 + Math.floor(r() * 13);
    if (mode === 4 && r() < 0.25) vN = Math.floor(r() * 3);
    if (vAt + vN > V) vAt = 0;
    let vOff = vAt;
    vAt += vN;
    if (mode === 2 && r() < 0.3) {
      const past = r();
      vOff = past < 0.6 ? V - vN + 1 + Math.floor(r() * vN) : past < 0.9 ? V + Math.floor(r() * 64) : 0x7fffff00;
    }
    g.vertOffset[e] = vOff;
    g.vertCount[e] = vN;
    if (kind < 0.5) {
      // A fan: no index list, whatever indexCount holds.
      g.indexOffset[e] = -1 - Math.floor(r() * 4);
      need[e] = vN >= 3 ? vN - 2 : 0;
      continue;
    }
    // An empty list (need 0) fails any run; keep it rare so most frames run to their end.
    const tris = r() < 0.03 ? 0 : 1 + Math.floor(r() * 9);
    const extra = r() < 0.1 ? 1 + Math.floor(r() * 2) : 0;
    const count = tris * 3 + extra;
    if (iAt + count > I) iAt = 0;
    let at = iAt;
    iAt += count;
    for (let q = 0; q < count; q++) g.indices[at + q] = Math.floor(r() * Math.max(1, vN));
    if (mode === 5 && count >= 3 && r() < 0.3) g.indices[at + Math.floor(r() * count)] = r() < 0.7 ? vN + Math.floor(r() * 3) : 65535;
    if (mode === 3 && count >= 3 && r() < 0.35) {
      const past = r();
      at = past < 0.7 ? I - count + 1 + Math.floor(r() * count) : past < 0.9 ? I + Math.floor(r() * 16) : 0x7ffffff0;
      // Indices that do lie in the column, below the mesh's vertex count.
      for (let q = at; q < I && q < at + count; q++) g.indices[q] = Math.floor(r() * Math.max(1, vN));
    }
    g.indexOffset[e] = at;
    g.indexCount[e] = count;
    need[e] = tris;
  }
  return need;
}

/** The instance-to-entity list: runs of each entity's triangle count, and what the mode adds. */
function writeInstances(r, s, mode, need) {
  if (mode === 7 && r() < 0.1) return 0;
  const target = 40 + Math.floor(r() * (CAP - 40));
  const ent = s.entity;
  let n = 0;
  let prev = -1;
  while (n < target) {
    const p = r();
    let id = Math.floor(r() * E);
    if (mode === 6 && p < 0.1) id = E + Math.floor(r() * GEN_EXTRA);
    else if (mode === 6 && p < 0.2) id = E + 16 + Math.floor(r() * 1000);
    else if (mode === 6 && p < 0.3) id = (0x80000000 + Math.floor(r() * 1000)) >>> 0;
    else if (mode === 4 && p < 0.06 && prev >= 0) id = prev; // the same entity again: one run, too long
    else if (id === prev) id = (id + 1) % E;
    let len = id < E && need[id] > 0 ? need[id] : 1 + Math.floor(r() * 4);
    if (mode === 4 && id < E && r() < 0.08) len = Math.max(1, len + (r() < 0.5 ? 1 : -1));
    if (n + len > CAP) break;
    ent.fill(id, n, n + len);
    n += len;
    prev = id;
  }
  return n;
}

/**
 * What the JS should do with this frame, run by run, in its order: the return code and the branches taken,
 * for the coverage tally. Checked against the JS's own code, so a mirror that drifts fails loudly.
 */
function expected(s, views, n, step, gen, last, tally) {
  const g = s.geom;
  const ent = s.entity;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!views.meshUvU && !!views.meshUvV;
  let k = 0;
  while (k < n) {
    const id = ent[k];
    const i = id | 0;
    let end = k + 1;
    while (end < n && ent[end] === id) end++;
    const run = end - k;
    if (run > 4) tally.longRun++;
    if (i < 0) tally.negative++;
    else if (i >= gen.length) tally.pastGen++;
    else if (i >= last.length) tally.lastShort++;
    const dirty = i >= 0 && i < gen.length && gen[i] !== (i < last.length ? last[i] : 0);
    k = end;
    if (!dirty) {
      if (i >= 0 && i < gen.length) tally.clean++;
      continue;
    }
    if (i >= E) {
      tally.pastGeometry++;
      return -1;
    }
    const vOff = g.vertOffset[i];
    if (vOff < 0) {
      tally.noMesh++;
      continue;
    }
    const vN = g.vertCount[i];
    const iAt = g.indexOffset[i];
    const want = iAt >= 0 ? Math.floor(g.indexCount[i] / 3) : vN >= 3 ? vN - 2 : 0;
    if (want !== run) {
      tally.need++;
      return -1;
    }
    if (vN < 3) {
      tally.underThree++;
      return -1;
    }
    const pastVerts = vOff + vN > V;
    if (iAt >= 0) {
      const pastIndices = iAt + 3 * run > I;
      for (let q = 0; q < 3 * run; q++) {
        const o = iAt + q;
        const ix = o < I ? g.indices[o] : 0;
        if (ix >= vN) {
          tally.badIndex++;
          return -1;
        }
      }
      tally[uvOn ? 'indexedUv' : 'indexed']++;
      if (pastIndices) tally.pastIndices++;
      if (pastVerts) tally.pastVerts++;
    } else {
      tally[uvOn ? 'fanUv' : 'fan']++;
      if (pastVerts) tally.pastVerts++;
    }
  }
  return n > 0 ? 1 : 0;
}

const STRIDES = [COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS];
const ODD_STRIDES = [3, 7, 20, 30, 0, -4];

test('the corner kernel writes what rewriteExplicitMeshCorners writes, frame after frame', async (t) => {
  const s = await setup();
  const r = rng(0x3e5c);
  const tally = {
    clean: 0, negative: 0, pastGen: 0, lastShort: 0, pastGeometry: 0, noMesh: 0, need: 0, underThree: 0, badIndex: 0,
    fan: 0, fanUv: 0, indexed: 0, indexedUv: 0, pastVerts: 0, pastIndices: 0, longRun: 0,
  };
  const codes = { 0: 0, 1: 0, '-1': 0 };
  const pattern = new Uint32Array(s.outWords.length);
  for (let k = 0; k < FRAMES; k++) {
    const mode = k % 8;
    const need = writeGeometry(r, s, mode);
    const n = writeInstances(r, s, mode, need);
    for (let q = 0; q < GEN_ROOM; q++) s.gen[q] = r() < 0.1 ? 0 : Math.floor(r() * 4294967296);
    for (let q = 0; q < GEN_ROOM; q++) s.last[q] = r() < 0.6 ? (s.gen[q] ^ (1 + Math.floor(r() * 0xffff))) >>> 0 : s.gen[q];
    for (let q = 0; q < E; q++) s.vertGen[q] = s.gen[q];
    const genLen = mode === 6 || r() < 0.1 ? E + GEN_EXTRA : E;
    const lastLen = mode === 6 && r() < 0.5 ? E - 6 : genLen;
    let views = viewsOf(s);
    let genNow = s.gen.subarray(0, genLen);
    let stride = STRIDES[k & 1 ? 0 : 1];
    if (mode === 1) stride = COLLIDER_FILL_FLOATS;
    if (mode === 7) {
      stride = ODD_STRIDES[Math.floor(r() * ODD_STRIDES.length)];
      if (r() < 0.4) genNow = null; // the live generations, MeshGeometry.vertGen
      if (r() < 0.4) views = { ...views, meshUvU: null };
    }
    const last = s.last.subarray(0, lastLen);
    for (let q = 0; q < pattern.length; q++) pattern[q] = Math.floor(r() * 4294967296);
    const step = (stride | 0) > 0 ? stride | 0 : COLLIDER_FILL_FLOATS;
    const gen = genNow || views.meshVertGen;

    s.outWords.set(pattern);
    const jsCode = rewriteExplicitMeshCorners(s.out, n, s.entity, views, stride, last, genNow);
    const jsWords = s.outWords.slice();
    assert.equal(expected(s, views, n, step, gen, last, tally), jsCode, `frame ${k} (mode ${mode}): the test's mirror of the JS`);
    s.outWords.set(pattern);
    const declined = s.b.declined;
    const code = rewriteCornersWasm(s.b, s.out, n, s.entity, views, stride, last, genNow);
    assert.equal(s.b.declined, declined, `frame ${k}: the kernel took the call`);
    assert.equal(code, jsCode, `frame ${k} (mode ${mode}, ${n} instances, stride ${stride}): return code`);
    const at = s.outWords.findIndex((w, q) => w !== jsWords[q]);
    assert.equal(at, -1, `frame ${k} (mode ${mode}, stride ${stride}): rows differ at word ${at} (row ${Math.floor(at / step)}, float ${at % step}): kernel 0x${(s.outWords[at] >>> 0).toString(16)}, JS 0x${(jsWords[at] >>> 0).toString(16)}`);
    codes[jsCode]++;
  }
  for (const [branch, hits] of Object.entries(tally)) assert.ok(hits > 0, `no frame reached ${branch}`);
  for (const [code, hits] of Object.entries(codes)) assert.ok(hits > 0, `no frame returned ${code}`);
  t.diagnostic(`${FRAMES} frames; codes ${JSON.stringify(codes)}; runs ${JSON.stringify(tally)}`);
});

test('a call the kernel cannot take goes to the JS, and an empty one returns 0', async () => {
  const s = await setup();
  const r = rng(11);
  const need = writeGeometry(r, s, 0);
  const n = writeInstances(r, s, 0, need);
  for (let q = 0; q < GEN_ROOM; q++) s.gen[q] = q + 1;
  s.last.fill(0);
  const views = viewsOf(s);
  const gen = s.gen.subarray(0, E);
  const last = s.last.subarray(0, E);
  const outside = new Float32Array(s.out.length);
  const jsOut = new Float32Array(s.out.length);
  const jsCode = rewriteExplicitMeshCorners(jsOut, n, s.entity, views, MESH_UV_FILL_FLOATS, last, gen);
  assert.equal(rewriteCornersWasm(s.b, outside, n, s.entity, views, MESH_UV_FILL_FLOATS, last, gen), jsCode);
  assert.deepEqual(new Uint32Array(outside.buffer), new Uint32Array(jsOut.buffer), 'rows outside the memory: the JS wrote them');
  assert.equal(s.b.declined, 1);
  const copied = { ...views, meshVertexX: new Float32Array(s.geom.vertexX) };
  rewriteCornersWasm(s.b, s.out, n, s.entity, copied, MESH_UV_FILL_FLOATS, last, gen);
  assert.equal(s.b.declined, 2, 'vertices other than the bound column');
  rewriteCornersWasm(s.b, s.out, s.entity.length + 1, s.entity, views, COLLIDER_FILL_FLOATS, last, gen);
  assert.equal(s.b.declined, 3, 'a count past the instance list');
  assert.equal(rewriteCornersWasm(s.b, s.out, 0, s.entity, views, COLLIDER_FILL_FLOATS, last, gen), 0);
  assert.equal(rewriteCornersWasm(s.b, s.out, n, s.entity, { ...views, meshVertGen: null }, COLLIDER_FILL_FLOATS, last, null), 0);
  assert.equal(s.b.declined, 3, 'the early returns never reach the kernel or the JS');
});

test('the bench scene hashes the same through the JS and the kernel', async () => {
  const js = await setupMeshCornersKernel({ scale: 0.125 });
  const hashJs = js.checksumFrames('js');
  const k = await setupMeshCornersKernel({ scale: 0.125 });
  const hashWasm = k.checksumFrames('wasm');
  assert.equal(k.b.declined, 0);
  assert.equal(hashWasm, hashJs);
  assert.ok(k.uvCount > 10000 && k.fillCount > 400, `${k.fillCount} fill and ${k.uvCount} UV rows`);
});
