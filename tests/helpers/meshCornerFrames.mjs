// The mesh corner rewrite's test frames (tests/node/meshCornersWasm.test.js, meshCornersF32.test.js): one memory
// that starts with the MeshGeometry block as the product's mesh memory does, the shipped kernel bound to it, and
// random frames written straight into the columns, so they reach what the MeshRenderer API never makes (see
// meshCornersWasm.test.js for the list). setup({ width: 32, V, I }) binds a 32-bit arena (E-130,
// meshCornersWide.test.js); the frames then also hold indices and vertex counts no 16-bit column holds. With no
// options the frames are the ones they were before E-130.
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';
import { bindMeshCorners, MESH_CORNER_SLOTS } from '../../src/render/meshCornersClient.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';

export const E = 48;
export const GEN_EXTRA = 8;
export const GEN_ROOM = E + 16;
export const V = 1024;
export const I = 3072;
export const CAP = 600;
export const MAX_STEP = 30;
export const FRAMES = 800;

export function rng(seed) {
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

/**
 * @param {{ width?: number, V?: number, I?: number }} [opts] the arena: its width (32 binds Uint32 vertex counts
 *   and indices at any size) and its vertex and index capacities
 */
export async function setup(opts = {}) {
  const sv = opts.V ?? V;
  const si = opts.I ?? I;
  const layout = layoutRegions([
    { name: 'meshGeometry', owner: 'test', bytes: MeshGeometry.getBufferSize(sv, si, E, opts.width) },
    { name: 'rows', owner: 'test', bytes: CAP * MAX_STEP * 4 },
    { name: 'entity', owner: 'test', bytes: CAP * 4 },
    { name: 'gen', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'last', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'uvGen', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'lastUv', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'table', owner: 'test', bytes: MESH_CORNER_SLOTS.length * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(buffer, sv, si, E, opts.width);
  const g = MeshGeometry;
  const geom = {
    vertOffset: g.vertOffset, vertCount: g.vertCount, indexOffset: g.indexOffset, indexCount: g.indexCount,
    vertexX: g.vertexX, vertexY: g.vertexY, uvU: g.uvU, uvV: g.uvV, indices: g.indices,
  };
  const b = await bindMeshCorners(memory, R.table.byte, geom);
  const words = (view) => new Uint32Array(buffer, view.byteOffset, view.length);
  return {
    b,
    memory,
    buffer,
    V: sv,
    I: si,
    wide: g.indexWidth === 32,
    geom,
    vertGen: g.vertGen,
    uvGenLive: g.uvGen,
    corners: [words(g.vertexX), words(g.vertexY), words(g.uvU), words(g.uvV)],
    out: new Float32Array(buffer, R.rows.byte, CAP * MAX_STEP),
    outWords: new Uint32Array(buffer, R.rows.byte, CAP * MAX_STEP),
    entity: new Uint32Array(buffer, R.entity.byte, CAP),
    gen: new Uint32Array(buffer, R.gen.byte, GEN_ROOM),
    last: new Uint32Array(buffer, R.last.byte, GEN_ROOM),
    uvGen: new Uint32Array(buffer, R.uvGen.byte, GEN_ROOM),
    lastUv: new Uint32Array(buffer, R.lastUv.byte, GEN_ROOM),
  };
}

export function viewsOf(s) {
  const g = s.geom;
  return {
    meshVertOffset: g.vertOffset, meshVertCount: g.vertCount, meshIndexOffset: g.indexOffset, meshIndexCount: g.indexCount,
    meshVertexX: g.vertexX, meshVertexY: g.vertexY, meshUvU: g.uvU, meshUvV: g.uvV, meshIndices: g.indices,
    meshVertGen: s.vertGen, meshUvGen: s.uvGenLive,
  };
}

/** E-130: corner indices past any mesh that only a 32-bit column holds (2^31 and up are negative as int32). */
const WIDE_BAD_INDEX = [65535, 65536, 0x7fffffff, 0x80000000, 0xffffffff];
/** A 32-bit arena's large meshes: 65 536 vertices and up, indexed (a few triangles each). */
const BIG_VERTS = 65536;

/**
 * One frame's MeshGeometry, written into the columns. Mode 2 puts vertex spans past the column's end, mode 3
 * index spans, mode 5 corner indices past the mesh; mode 4 makes meshes under 3 vertices. Returns each
 * entity's triangle count as rewriteExplicitMeshCorners works it out (need), for the instance lists. In a
 * 32-bit arena (s.wide) some index lists name vertices past 65535 of meshes that large (when the arena holds
 * one), mode 5 puts indices of 2^16 and up past the mesh, and mode 4 gives some meshes a count of 2^31 or more.
 */
export function writeGeometry(r, s, mode) {
  const V = s.V;
  const I = s.I;
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
    if (s.wide && kind >= 0.5 && V > BIG_VERTS + 4096 && r() < 0.08) vN = BIG_VERTS + Math.floor(r() * 4096);
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
    // A count the JS reads as negative: the runs keep the mesh's own triangle count, so the count decides.
    if (s.wide && mode === 4 && r() < 0.1) g.vertCount[e] = (0x80000000 + Math.floor(r() * 1000)) >>> 0;
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
    if (mode === 5 && count >= 3 && r() < 0.3) g.indices[at + Math.floor(r() * count)] = r() < 0.7 ? vN + Math.floor(r() * 3) : s.wide ? WIDE_BAD_INDEX[Math.floor(r() * WIDE_BAD_INDEX.length)] : 65535;
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
export function writeInstances(r, s, mode, need) {
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

const STRIDES = [COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS];
const ODD_STRIDES = [3, 7, 20, 30, 0, -4];

/**
 * Frame k: the geometry, the instances, the generations, and the call's arguments (rewriteExplicitMeshCorners'
 * order). `pattern` gets the words the row region holds before each call. uvKind: which UV generations the call
 * gets (none, the live ones, a capture).
 */
export function frameCall(r, s, k, pattern) {
  const mode = k % 8;
  const need = writeGeometry(r, s, mode);
  const n = writeInstances(r, s, mode, need);
  for (let q = 0; q < GEN_ROOM; q++) s.gen[q] = r() < 0.1 ? 0 : Math.floor(r() * 4294967296);
  for (let q = 0; q < GEN_ROOM; q++) s.last[q] = r() < 0.6 ? (s.gen[q] ^ (1 + Math.floor(r() * 0xffff))) >>> 0 : s.gen[q];
  // E-118: UV generations that moved for some meshes, with their vertex generation or without it.
  for (let q = 0; q < GEN_ROOM; q++) s.uvGen[q] = r() < 0.1 ? 0 : Math.floor(r() * 4294967296);
  for (let q = 0; q < GEN_ROOM; q++) s.lastUv[q] = r() < 0.4 ? (s.uvGen[q] ^ (1 + Math.floor(r() * 0xffff))) >>> 0 : s.uvGen[q];
  for (let q = 0; q < E; q++) {
    s.vertGen[q] = s.gen[q];
    s.uvGenLive[q] = s.uvGen[q];
  }
  const genLen = mode === 6 || r() < 0.1 ? E + GEN_EXTRA : E;
  const lastLen = mode === 6 && r() < 0.5 ? E - 6 : genLen;
  const uvGenLen = mode === 6 || r() < 0.1 ? E + GEN_EXTRA : E;
  const lastUvLen = mode === 6 && r() < 0.5 ? E - 6 : uvGenLen;
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
  // No UV generations (the call before E-118), the live ones (MeshGeometry.uvGen), or a capture.
  const uvMode = r();
  let lastUvGen = s.lastUv.subarray(0, lastUvLen);
  let uvGenNow = s.uvGen.subarray(0, uvGenLen);
  let uvKind = 'captured';
  if (uvMode < 0.25) {
    lastUvGen = null;
    uvGenNow = null;
    uvKind = 'none';
  } else if (uvMode < 0.4) {
    uvGenNow = null;
    uvKind = 'live';
  }
  for (let q = 0; q < pattern.length; q++) pattern[q] = Math.floor(r() * 4294967296);
  const step = (stride | 0) > 0 ? stride | 0 : COLLIDER_FILL_FLOATS;
  const gen = genNow || views.meshVertGen;
  const uvSource = lastUvGen ? uvGenNow || views.meshUvGen : null;
  return { mode, n, views, stride, last, genNow, lastUvGen, uvGenNow, uvKind, step, gen, uvSource };
}
