#!/usr/bin/env node
/**
 * Kernel (E-76 W11): Pixi's mesh corner rewrite in WASM (wasm/test/meshCorners.c, a test module) against the
 * shipped rewriteExplicitMeshCorners, on the meshes meshApiStressScene makes.
 *
 *   js    rewriteExplicitMeshCorners (src/render/colliderFillBatch.js), as Pixi calls it on a frame whose
 *         vertices moved: once for the fill batch (18-float rows), once for the UV batch (24-float rows)
 *   wasm  rewrite_corners, one call per batch, through rewriteCornersWasm: rewriteExplicitMeshCorners' own
 *         early return, the call's slots of the table, the call, as a product wrapper would
 *
 * The rewrite reads the MeshGeometry block (spans, counts, vertices, UVs, indices) and Pixi's batch rows,
 * instance-to-entity lists and vertex generations, so the kernel needs all of them in the memory it imports.
 * MeshGeometry.initializeArrays lays its views out from byte 0 of its buffer (as the ParticleComponent does in
 * the particle memory), so this memory starts with the block and Pixi's arrays follow it: both sides read and
 * write the same bytes. The meshes are made with the MeshRenderer calls the scene makes, and the batches are
 * filled by the shipped packColliderFill and packMeshUvFill.
 *
 * meshApiStressScene's default mix: 600 rigid fans (8 vertices, fill batch, never rewritten), 120 deform grids
 * (setPlane 24 × 16 with UVs, setVertices every tick: 768 indexed UV triangles each), 400 ropes (setRope of 8
 * points every tick: 14 triangles), 400 UV quads, 8 planes, 8 stars (ear-clipped, fill batch) and 200 outset
 * boxes (collider fill). Each frame the UV batch rewrites 97 760 of its 98 752 rows; the fill batch's 4 064 are
 * walked and skipped. The timed op is one frame's two calls with that dirty set.
 *
 * Checksum: 24 frames from the packed state. Each is a logic tick (the scene's waves and ropes; on top of them a
 * quarter of the rigid fans and a third of the stars change shape and a fifth of the grids skip the tick, so the
 * fan and 18-float paths run and meshes that could be dirty are skipped) and then Pixi's sequence (capture the
 * generations, rewrite both batches, commit), hashed over both batches' rows and the two return codes.
 * --check runs only those frames and prints the checksum (no warm-up, no timing).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/meshCornersWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/meshCornersWasmMicrobench.mjs --variant wasm [--check] [--scale 0.1] [--output path]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import {
  COLLIDER_FILL_FLOATS,
  COLLIDER_FILL_STRIDE,
  MESH_UV_FILL_FLOATS,
  MESH_UV_FILL_STRIDE,
  packColliderFill,
  packMeshUvFill,
  resetColliderFillMeshLayerWarn,
  rewriteExplicitMeshCorners,
} from '../../src/render/colliderFillBatch.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/meshCorners.wasm'));

/** meshCorners.c's table, slot for slot. */
export const MESH_CORNER_SLOTS = [
  'out', 'count', 'step', 'uvOn', 'entity', 'gen', 'genLen', 'last', 'lastLen',
  'vertOffset', 'vertCount', 'indexOffset', 'indexCount', 'geomN',
  'vertexX', 'vertexY', 'uvU', 'uvV', 'vertCap', 'indices', 'indexCap',
];
const OUT = 0;
const COUNT = 1;
const STEP = 2;
const UV_ON = 3;
const ENTITY = 4;
const GEN = 5;
const GEN_LEN = 6;
const LAST = 7;
const LAST_LEN = 8;
const VERT_OFFSET = 9;
const VERT_COUNT = 10;
const INDEX_OFFSET = 11;
const INDEX_COUNT = 12;
const GEOM_N = 13;
const VERTEX_X = 14;
const VERTEX_Y = 15;
const UV_U = 16;
const UV_V = 17;
const VERT_CAP = 18;
const INDICES = 19;
const INDEX_CAP = 20;

/**
 * Bind the kernel to `memory`, the MeshGeometry columns in it (`geom`: the views MeshGeometry holds) and a
 * table of MESH_CORNER_SLOTS u32 at `tableByte`. The columns' slots are written once.
 */
export async function bindMeshCorners(memory, tableByte, geom) {
  const buffer = memory.buffer;
  const columns = {
    vertOffset: Int32Array, vertCount: Uint16Array, indexOffset: Int32Array, indexCount: Uint32Array,
    vertexX: Float32Array, vertexY: Float32Array, uvU: Float32Array, uvV: Float32Array, indices: Uint16Array,
  };
  for (const [name, Ctor] of Object.entries(columns)) {
    const view = geom[name];
    if (!(view instanceof Ctor) || view.buffer !== buffer) throw new Error(`meshCorners: MeshGeometry.${name} is not a ${Ctor.name} in the memory`);
  }
  const e = geom.vertOffset.length;
  const v = geom.vertexX.length;
  if (geom.vertCount.length !== e || geom.indexOffset.length !== e || geom.indexCount.length !== e) throw new Error('meshCorners: entity columns of different lengths');
  if (geom.vertexY.length !== v || geom.uvU.length !== v || geom.uvV.length !== v) throw new Error('meshCorners: vertex columns of different lengths');
  const { rewrite_corners: rewrite } = await loadWasmKernel('meshCorners', KERNEL_URL, memory, ['rewrite_corners']);
  const table = new Uint32Array(buffer, tableByte, MESH_CORNER_SLOTS.length);
  table[VERT_OFFSET] = geom.vertOffset.byteOffset;
  table[VERT_COUNT] = geom.vertCount.byteOffset;
  table[INDEX_OFFSET] = geom.indexOffset.byteOffset;
  table[INDEX_COUNT] = geom.indexCount.byteOffset;
  table[GEOM_N] = e;
  table[VERTEX_X] = geom.vertexX.byteOffset;
  table[VERTEX_Y] = geom.vertexY.byteOffset;
  table[UV_U] = geom.uvU.byteOffset;
  table[UV_V] = geom.uvV.byteOffset;
  table[VERT_CAP] = v;
  table[INDICES] = geom.indices.byteOffset;
  table[INDEX_CAP] = geom.indices.length;
  return { buffer, table, tableByte, rewrite, geom: { ...geom }, declined: 0 };
}

/** A Uint32Array in the kernel's memory holding at least `n` values. */
function u32In(b, a, n) {
  return a instanceof Uint32Array && a.buffer === b.buffer && a.length >= n;
}

/**
 * rewriteExplicitMeshCorners(out, count, entityOfInstance, views, stride, lastVertGen, genNow) through the
 * kernel, same arguments, same result. A call it cannot take (an array outside the memory or of another type,
 * MeshGeometry columns other than the bound ones, a row or instance list shorter than the call) goes to the
 * JS function, and `b.declined` counts it.
 */
export function rewriteCornersWasm(b, out, count, entityOfInstance, views, stride, lastVertGen, genNow) {
  const n = count | 0;
  const gen = genNow || views.meshVertGen;
  // rewriteExplicitMeshCorners' own early return.
  if (!out || n <= 0 || !entityOfInstance || !gen || !lastVertGen) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : COLLIDER_FILL_FLOATS;
  const g = b.geom;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!views.meshUvU && !!views.meshUvV;
  if (
    !(out instanceof Float32Array) || out.buffer !== b.buffer || n * step > out.length ||
    !u32In(b, entityOfInstance, n) || !u32In(b, gen, 0) || !u32In(b, lastVertGen, 0) ||
    views.meshVertOffset !== g.vertOffset || views.meshVertCount !== g.vertCount ||
    views.meshIndexOffset !== g.indexOffset || views.meshIndexCount !== g.indexCount ||
    views.meshVertexX !== g.vertexX || views.meshVertexY !== g.vertexY || views.meshIndices !== g.indices ||
    (uvOn && (views.meshUvU !== g.uvU || views.meshUvV !== g.uvV))
  ) {
    b.declined++;
    return rewriteExplicitMeshCorners(out, count, entityOfInstance, views, stride, lastVertGen, genNow);
  }
  const t = b.table;
  t[OUT] = out.byteOffset;
  t[COUNT] = n;
  t[STEP] = step;
  t[UV_ON] = uvOn ? 1 : 0;
  t[ENTITY] = entityOfInstance.byteOffset;
  t[GEN] = gen.byteOffset;
  t[GEN_LEN] = gen.length;
  t[LAST] = lastVertGen.byteOffset;
  t[LAST_LEN] = lastVertGen.length;
  return b.rewrite(b.tableByte);
}

// meshApiStressScene's shapes and cohorts (its defaults; `scale` is its `count` query).
const FAN_VERTS = 8;
const ROPE_POINTS = 8;
const ROPE_HALF_WIDTH = 6;
const DEFORM_SX = 24;
const DEFORM_SY = 16;
const DEFORM_VERTS = (DEFORM_SX + 1) * (DEFORM_SY + 1);
const PLANE_SX = 4;
const PLANE_SY = 3;
const MAX_VERTS = 65535;
const MAX_INDICES = 524288;
const COLS = 96;
const SPACING = 56;
const FRAMES = 24;

function mix(scale) {
  const n = (fallback) => Math.round(fallback * scale);
  return { rigid: n(600), deform: n(120), rope: n(400), uv: n(400), plane: n(8), poly: n(8), fill: n(200) };
}

function fanPositions(n, radius, scale = 1) {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xy[i * 2] = Math.cos(a) * radius * scale;
    xy[i * 2 + 1] = Math.sin(a) * radius * scale;
  }
  return xy;
}

function starPoints(outer, inner, points, scale = 1) {
  const xy = new Float32Array(points * 4);
  let o = 0;
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = ((i & 1) === 0 ? outer : inner) * scale;
    xy[o++] = Math.cos(a) * r;
    xy[o++] = Math.sin(a) * r;
  }
  return xy;
}

const FAN = fanPositions(FAN_VERTS, 18);
const QUAD_XY = new Float32Array([-16, -12, 16, -12, 16, 12, -16, 12]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const STAR = starPoints(22, 9, 5);

/** MeshApiDeform._wave */
function wave(xy, time, phase) {
  const vx = DEFORM_SX + 1;
  const vy = DEFORM_SY + 1;
  let p = 0;
  for (let j = 0; j < vy; j++) {
    const y = -20 + 40 * (j / DEFORM_SY);
    for (let i = 0; i < vx; i++) {
      const u = i / DEFORM_SX;
      xy[p++] = -32 + 64 * u;
      xy[p++] = y + Math.sin(u * 6.283 + time * 3 + phase) * 3;
    }
  }
  return xy;
}

/** MeshApiRope._writeRope */
function ropePoints(pts, time, phase) {
  const mid = (ROPE_POINTS - 1) * 0.5;
  for (let i = 0; i < ROPE_POINTS; i++) {
    pts[i * 2] = (i - mid) * 8;
    pts[i * 2 + 1] = Math.sin(i * 0.7 + time * 3 + phase) * 10;
  }
  return pts;
}

/**
 * The scene's meshes in a memory that starts with the MeshGeometry block, packed by the shipped packs, and
 * the kernel bound to it.
 * @param {{ scale?: number }} [opts]
 */
export async function setupMeshCornersKernel(opts = {}) {
  const c = mix(opts.scale ?? 1);
  const first = {};
  let total = 0;
  for (const name of ['rigid', 'deform', 'rope', 'uv', 'plane', 'poly', 'fill']) {
    first[name] = total;
    total += c[name];
  }
  const n = total;
  const fillCap = c.rigid * (FAN_VERTS - 2) + c.poly * 8 + c.fill * 2;
  const deformTris = DEFORM_SX * DEFORM_SY * 2;
  const ropeTris = (ROPE_POINTS - 1) * 2;
  const uvCap = c.deform * deformTris + c.rope * ropeTris + c.uv * 2 + c.plane * PLANE_SX * PLANE_SY * 2;

  const layout = layoutRegions([
    { name: 'meshGeometry', owner: 'every worker (MeshGeometry)', bytes: MeshGeometry.getBufferSize(MAX_VERTS, MAX_INDICES, n) },
    { name: 'fillRows', owner: 'pixi', bytes: fillCap * COLLIDER_FILL_STRIDE },
    { name: 'uvRows', owner: 'pixi', bytes: uvCap * MESH_UV_FILL_STRIDE },
    { name: 'fillEntity', owner: 'pixi', bytes: fillCap * 4 },
    { name: 'uvEntity', owner: 'pixi', bytes: uvCap * 4 },
    { name: 'frameVertGen', owner: 'pixi', bytes: n * 4 },
    { name: 'lastVertGen', owner: 'pixi', bytes: n * 4 },
    { name: 'table', owner: 'pixi', bytes: MESH_CORNER_SLOTS.length * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  resetColliderFillMeshLayerWarn();
  MeshGeometry.initializeArrays(buffer, MAX_VERTS, MAX_INDICES, n);

  // The scene's spawns, in its pool order.
  const api = [];
  for (let i = 0; i < n; i++) api.push(new MeshRenderer(i));
  const deformXY = [];
  const ropePts = [];
  for (let k = 0; k < c.rigid; k++) api[first.rigid + k].setMesh(FAN);
  for (let k = 0; k < c.deform; k++) {
    const mr = api[first.deform + k];
    mr.setPlane(64, 40, DEFORM_SX, DEFORM_SY);
    deformXY.push(new Float32Array(DEFORM_VERTS * 2));
    mr.setVertices(wave(deformXY[k], 0, k * 0.17));
  }
  for (let k = 0; k < c.rope; k++) {
    ropePts.push(ropePoints(new Float32Array(ROPE_POINTS * 2), 0, k * 0.13));
    api[first.rope + k].setRope(ropePts[k], ROPE_HALF_WIDTH);
  }
  for (let k = 0; k < c.uv; k++) api[first.uv + k].setMesh(QUAD_XY, QUAD_IDX, QUAD_UV);
  for (let k = 0; k < c.plane; k++) api[first.plane + k].setPlane(80, 48, PLANE_SX, PLANE_SY);
  for (let k = 0; k < c.poly; k++) api[first.poly + k].setPolygon(STAR);

  // Pixi's collider-fill views (_ensureColliderFillViews): the MeshRenderer, Collider and pose columns the
  // packs read, and the MeshGeometry block.
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n).fill(1),
    meshVisible: new Uint8Array(n).fill(1),
    meshLayerMask: new Uint16Array(n).fill(1),
    meshTint: new Uint32Array(n).fill(0xf0c14a),
    meshAlpha: new Float32Array(n).fill(1),
    meshVisualOutset: new Float32Array(n),
    meshBits: 1,
    fixtureCount: new Uint16Array(n),
    primaryShapeType: new Uint8Array(n),
    primaryWidth: new Float32Array(n),
    primaryHeight: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    meshVertOffset: MeshGeometry.vertOffset,
    meshVertCount: MeshGeometry.vertCount,
    meshIndexOffset: MeshGeometry.indexOffset,
    meshIndexCount: MeshGeometry.indexCount,
    meshHasUv: MeshGeometry.hasUv,
    meshVertexX: MeshGeometry.vertexX,
    meshVertexY: MeshGeometry.vertexY,
    meshUvU: MeshGeometry.uvU,
    meshUvV: MeshGeometry.uvV,
    meshIndices: MeshGeometry.indices,
    meshGeomRevision: MeshGeometry.revision,
    meshVertGen: MeshGeometry.vertGen,
    meshVertEpoch: MeshGeometry.vertEpoch,
    instanceEntity: null,
    outU32: null,
    layerHasVertexUv: 0,
  };
  for (let i = 0; i < n; i++) {
    views.x[i] = 200 + (i % COLS) * SPACING;
    views.y[i] = 200 + ((i / COLS) | 0) * SPACING;
    const a = i * 0.37;
    views.rotC[i] = Math.cos(a);
    views.rotS[i] = Math.sin(a);
  }
  for (let k = 0; k < c.fill; k++) {
    const i = first.fill + k;
    views.primaryWidth[i] = 40;
    views.primaryHeight[i] = 28;
    views.meshVisualOutset[i] = 6;
  }

  const fillRows = new Float32Array(buffer, R.fillRows.byte, fillCap * COLLIDER_FILL_FLOATS);
  const uvRows = new Float32Array(buffer, R.uvRows.byte, uvCap * MESH_UV_FILL_FLOATS);
  const fillWords = new Uint32Array(buffer, R.fillRows.byte, fillRows.length);
  const uvWords = new Uint32Array(buffer, R.uvRows.byte, uvRows.length);
  const fillEntity = new Uint32Array(buffer, R.fillEntity.byte, fillCap);
  const uvEntity = new Uint32Array(buffer, R.uvEntity.byte, uvCap);
  views.instanceEntity = fillEntity;
  views.outU32 = fillWords;
  const fillCount = packColliderFill(fillRows, fillCap, 0, views);
  views.instanceEntity = uvEntity;
  views.outU32 = uvWords;
  const uvCount = packMeshUvFill(uvRows, uvCap, 0, views);
  if (fillCount !== fillCap || uvCount !== uvCap) throw new Error(`packed ${fillCount}/${fillCap} fill and ${uvCount}/${uvCap} UV rows`);

  // Pixi's generations: drawn by the full pack (_commitVertGen), captured each frame (_captureVertGen).
  const frameVertGen = new Uint32Array(buffer, R.frameVertGen.byte, n);
  const lastVertGen = new Uint32Array(buffer, R.lastVertGen.byte, n);
  lastVertGen.set(MeshGeometry.vertGen);
  const b = await bindMeshCorners(memory, R.table.byte, {
    vertOffset: MeshGeometry.vertOffset, vertCount: MeshGeometry.vertCount, indexOffset: MeshGeometry.indexOffset,
    indexCount: MeshGeometry.indexCount, vertexX: MeshGeometry.vertexX, vertexY: MeshGeometry.vertexY,
    uvU: MeshGeometry.uvU, uvV: MeshGeometry.uvV, indices: MeshGeometry.indices,
  });

  const rewriters = {
    js: rewriteExplicitMeshCorners,
    wasm: (out, count, ent, v, stride, last, genNow) => rewriteCornersWasm(b, out, count, ent, v, stride, last, genNow),
  };

  /** Pixi's rewrite of both batches on a frame whose vertices moved (the `!full && vertsMoved` branch). */
  const rewriteFrame = (rewrite) => {
    const fill = rewrite(fillRows, fillCount, fillEntity, views, COLLIDER_FILL_FLOATS, lastVertGen, frameVertGen);
    const uv = rewrite(uvRows, uvCount, uvEntity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen);
    return fill * 4 + uv;
  };

  const fanScaled = new Float32Array(FAN_VERTS * 2);
  const starScaled = new Float32Array(STAR.length);
  /** One logic tick: the scene's ticks, and the fans, stars and skipped grids that widen the checksum. */
  const logicTick = (f) => {
    const time = (f + 1) / 60;
    for (let k = 0; k < c.deform; k++) {
      if ((k + f) % 5 !== 0) api[first.deform + k].setVertices(wave(deformXY[k], time, k * 0.17));
    }
    for (let k = 0; k < c.rope; k++) api[first.rope + k].setRope(ropePoints(ropePts[k], time, k * 0.13), ROPE_HALF_WIDTH);
    for (let k = 0; k < c.rigid; k++) {
      if ((k + f) % 4 !== 0) continue;
      const s = 1 + 0.25 * Math.sin(time * 3 + k);
      for (let q = 0; q < FAN.length; q++) fanScaled[q] = FAN[q] * s;
      api[first.rigid + k].setVertices(fanScaled);
    }
    for (let k = 0; k < c.poly; k++) {
      if ((k + f) % 3 !== 0) continue;
      const s = 1 + 0.2 * Math.cos(time * 2 + k);
      for (let q = 0; q < STAR.length; q++) starScaled[q] = STAR[q] * s;
      api[first.poly + k].setVertices(starScaled);
    }
  };

  /** FRAMES frames of logic then Pixi; the hash of both batches' rows and the codes after each. */
  const checksumFrames = (variant) => {
    const rewrite = rewriters[variant];
    let h = 2166136261;
    for (let f = 0; f < FRAMES; f++) {
      logicTick(f);
      frameVertGen.set(MeshGeometry.vertGen);
      const codes = rewriteFrame(rewrite);
      lastVertGen.set(frameVertGen);
      h = Math.imul(h ^ codes, 16777619) >>> 0;
      h = Math.imul(h ^ checksumInts(fillWords, fillCount * COLLIDER_FILL_FLOATS), 16777619) >>> 0;
      h = Math.imul(h ^ checksumInts(uvWords, uvCount * MESH_UV_FILL_FLOATS), 16777619) >>> 0;
    }
    return h;
  };

  /** The timed state: the scene's dirty set, every grid and rope, against the generations drawn. */
  const sceneDirty = () => {
    frameVertGen.set(MeshGeometry.vertGen);
    lastVertGen.set(frameVertGen);
    for (let k = 0; k < c.deform; k++) lastVertGen[first.deform + k] = ~frameVertGen[first.deform + k] >>> 0;
    for (let k = 0; k < c.rope; k++) lastVertGen[first.rope + k] = ~frameVertGen[first.rope + k] >>> 0;
    return c.deform * deformTris + c.rope * ropeTris;
  };

  /** Short calls for a normal compile: the first four ropes of the UV batch, the first rigid fans of the fill. */
  const ropeRow = c.deform * deformTris;
  const ropeRows = Math.min(4, c.rope) * ropeTris;
  const shortUv = { rows: uvRows.subarray(ropeRow * MESH_UV_FILL_FLOATS), entity: uvEntity.subarray(ropeRow), count: ropeRows };
  const shortFill = Math.min(8, c.rigid) * (FAN_VERTS - 2);
  const shortFrame = (rewrite) => {
    rewrite(fillRows, shortFill, fillEntity, views, COLLIDER_FILL_FLOATS, lastVertGen, frameVertGen);
    rewrite(shortUv.rows, shortUv.count, shortUv.entity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen);
  };

  return {
    cohorts: c, n, fillCount, uvCount, b, views, rewriters, rewriteFrame, checksumFrames, sceneDirty, shortFrame,
  };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const k = await setupMeshCornersKernel({ scale: Number(args.scale ?? 1) });
  const rewrite = k.rewriters[variant];

  const checksum = k.checksumFrames(variant);
  if (variant === 'wasm' && k.b.declined) throw new Error(`the kernel declined ${k.b.declined} calls`);
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} fill ${k.fillCount} uv ${k.uvCount} rows, ${FRAMES} frames`);
    return;
  }

  const rewritten = k.sceneDirty();
  const op = () => k.rewriteFrame(rewrite);
  if (op() !== 4 + 1) throw new Error('the scene frame does not rewrite both batches');
  // Normal compiles, not OSR: short calls over a few meshes of each batch.
  let tier = null;
  if (variant === 'wasm') tier = await warmWasm(k.b.rewrite, () => k.shortFrame(rewrite));
  else warmNormalCompile(() => k.shortFrame(rewrite));
  const cases = {
    rewrite: timeIt(`mesh corners ${variant} (${k.fillCount} fill + ${k.uvCount} UV rows, ${rewritten} rewritten)`, op, { iterations: 20, warmup: 10 }),
  };
  const report = {
    feature: 'mesh-corners-wasm',
    variant,
    functions: ['rewriteExplicitMeshCorners', 'meshCorners.rewrite_corners'],
    cohorts: k.cohorts,
    rows: { fill: k.fillCount, uv: k.uvCount, rewritten },
    checksum,
    declined: k.b.declined,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} rows ${k.fillCount} + ${k.uvCount}${tier ? ` tier ${tier}` : ''} rewrite ${cases.rewrite.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
