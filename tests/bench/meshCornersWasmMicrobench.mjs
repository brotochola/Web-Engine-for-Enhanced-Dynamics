#!/usr/bin/env node
/**
 * Kernel (E-76 W11, E-118): Pixi's mesh corner rewrite in WASM (wasm/meshCorners.c, src/render/meshCorners.wasm)
 * against the shipped rewriteExplicitMeshCorners, on the meshes meshApiStressScene makes.
 *
 *   js          rewriteExplicitMeshCorners (src/render/colliderFillBatch.js), as Pixi called it before E-118 on
 *               a frame whose vertices moved: once for the fill batch (18-float rows), once for the UV batch
 *               (24-float rows), without the UV generations, so every rewritten UV row stores its UVs
 *   js-uvgen    the same calls with the UV generations (E-118): a UV row stores its UVs only when its mesh's UV
 *               generation moved (the ropes), not when only its positions did (the deform grids)
 *   wasm        rewrite_corners through the shipped client's rewriteCornersWasm (meshCornersClient.js), one call
 *               per batch, without the UV generations
 *   wasm-uvgen  the same with the UV generations
 *   wasm-f32, wasm-f32-uvgen      rewrite_corners_f32 (tests/fixtures/wasm/meshCornersF32.wasm, from
 *               wasm/test/meshCornersF32.c) through the same client: one float load and store per coordinate
 *   wasm-f32x4, wasm-f32x4-uvgen  rewrite_corners_f32x4: two corners per f32x4 store from lane loads, the third
 *               a 64-bit lane store
 *
 * The rewrite computes nothing, so the float32 variants copy the same bits: their checksum is the exact one
 * (nothing to quantise), and runKernelVariants compares them with wasm (or wasm-uvgen) as it compares js.
 *
 * The rewrite reads the MeshGeometry block (spans, counts, vertices, UVs, indices) and Pixi's batch rows,
 * instance-to-entity lists and generations, so the kernel needs all of them in the memory it imports. The
 * memory is laid out as the product's mesh memory (wasmMemoryMap.js meshMemoryRegions, one MESH layer): the
 * MeshGeometry block at byte 0 (MeshGeometry.initializeArrays lays its views out from byte 0 of its buffer),
 * then the kernel's table and the layer's rows, lists and generation copies, sized to the rows packed here.
 * The meshes are made with the MeshRenderer calls the scene makes, and the batches are filled by the shipped
 * packColliderFill and packMeshUvFill.
 *
 * meshApiStressScene's default mix: 600 rigid fans (8 vertices, fill batch, never rewritten), 120 deform grids
 * (setPlane 24 × 16 with UVs, setVertices every tick: 768 indexed UV triangles each), 400 ropes (setRope of 8
 * points every tick: 14 triangles, UVs written each time), 400 UV quads, 8 planes, 8 stars (ear-clipped, fill
 * batch) and 200 outset boxes (collider fill). Each frame the UV batch rewrites 97 760 of its 98 752 rows, the
 * ropes' 5 600 with their UVs; the fill batch's 4 064 are walked and skipped. The timed op is one frame's two
 * calls with that dirty set.
 *
 * Checksum: 24 frames from the packed state. Each is a logic tick (the scene's waves and ropes; on top of them a
 * quarter of the rigid fans and a third of the stars change shape and a fifth of the grids skip the tick, so the
 * fan and 18-float paths run and meshes that could be dirty are skipped) and then Pixi's sequence (capture the
 * generations, rewrite both batches, commit), hashed over both batches' rows and the two return codes. Every
 * variant must give the same checksum: the UV generations change which stores run, not what the rows hold.
 * --check runs only those frames and prints the checksum (no warm-up, no timing).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/meshCornersWasmMicrobench.mjs --variants js,js-uvgen --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/meshCornersWasmMicrobench.mjs --variants wasm,wasm-f32,wasm-f32x4 --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/meshCornersWasmMicrobench.mjs --variants wasm-uvgen,wasm-f32-uvgen,wasm-f32x4-uvgen --rounds 5
 *   node tests/bench/meshCornersWasmMicrobench.mjs --variant wasm-uvgen [--check] [--scale 0.1] [--output path]
 */
import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import {
  COLLIDER_FILL_FLOATS,
  MESH_UV_FILL_FLOATS,
  packColliderFill,
  packMeshUvFill,
  resetColliderFillMeshLayerWarn,
  rewriteExplicitMeshCorners,
} from '../../src/render/colliderFillBatch.js';
import { bindMeshCorners, rewriteCornersWasm } from '../../src/render/meshCornersClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { meshMemoryRegions } from '../../src/util/wasmMemoryMap.js';
import { checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const F32_URL = new URL('../fixtures/wasm/meshCornersF32.wasm', import.meta.url);
const F32_EXPORTS = ['rewrite_corners_f32', 'rewrite_corners_f32x4'];

/**
 * The variants: which rewrite, whether Pixi hands it the UV generations (E-118), and for the float32 variants
 * which export of the meshCornersF32 test module the client calls instead of rewrite_corners.
 */
export const MESH_CORNER_VARIANTS = {
  js: { wasm: false, uvGen: false },
  'js-uvgen': { wasm: false, uvGen: true },
  wasm: { wasm: true, uvGen: false },
  'wasm-uvgen': { wasm: true, uvGen: true },
  'wasm-f32': { wasm: true, uvGen: false, fn: 'rewrite_corners_f32' },
  'wasm-f32-uvgen': { wasm: true, uvGen: true, fn: 'rewrite_corners_f32' },
  'wasm-f32x4': { wasm: true, uvGen: false, fn: 'rewrite_corners_f32x4' },
  'wasm-f32x4-uvgen': { wasm: true, uvGen: true, fn: 'rewrite_corners_f32x4' },
};

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
 * The scene's meshes in a memory laid out as the product's mesh memory, packed by the shipped packs, and the
 * kernel bound to it.
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

  const layout = meshMemoryRegions(MeshGeometry.getBufferSize(MAX_VERTS, MAX_INDICES, n), n, [{ fillRows: fillCap, uvRows: uvCap }]);
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
    meshUvGen: MeshGeometry.uvGen,
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

  const fillRows = new Float32Array(buffer, R.meshFillRows0.byte, fillCap * COLLIDER_FILL_FLOATS);
  const uvRows = new Float32Array(buffer, R.meshUvRows0.byte, uvCap * MESH_UV_FILL_FLOATS);
  const fillWords = new Uint32Array(buffer, R.meshFillRows0.byte, fillRows.length);
  const uvWords = new Uint32Array(buffer, R.meshUvRows0.byte, uvRows.length);
  const fillEntity = new Uint32Array(buffer, R.meshFillEntity0.byte, fillCap);
  const uvEntity = new Uint32Array(buffer, R.meshUvEntity0.byte, uvCap);
  views.instanceEntity = fillEntity;
  views.outU32 = fillWords;
  const fillCount = packColliderFill(fillRows, fillCap, 0, views);
  views.instanceEntity = uvEntity;
  views.outU32 = uvWords;
  const uvCount = packMeshUvFill(uvRows, uvCap, 0, views);
  if (fillCount !== fillCap || uvCount !== uvCap) throw new Error(`packed ${fillCount}/${fillCap} fill and ${uvCount}/${uvCap} UV rows`);

  // Pixi's generations: drawn by the full pack (_commitVertGen, _commitUvGen), captured each frame
  // (_captureVertGen, _captureUvGen).
  const frameVertGen = new Uint32Array(buffer, R.meshFrameVertGen0.byte, n);
  const lastVertGen = new Uint32Array(buffer, R.meshLastVertGen0.byte, n);
  const frameUvGen = new Uint32Array(buffer, R.meshFrameUvGen0.byte, n);
  const lastUvGen = new Uint32Array(buffer, R.meshLastUvGen0.byte, n);
  lastVertGen.set(MeshGeometry.vertGen);
  lastUvGen.set(MeshGeometry.uvGen);
  const b = await bindMeshCorners(memory, R.meshCornerTable.byte, {
    vertOffset: MeshGeometry.vertOffset, vertCount: MeshGeometry.vertCount, indexOffset: MeshGeometry.indexOffset,
    indexCount: MeshGeometry.indexCount, vertexX: MeshGeometry.vertexX, vertexY: MeshGeometry.vertexY,
    uvU: MeshGeometry.uvU, uvV: MeshGeometry.uvV, indices: MeshGeometry.indices,
  });

  const wasmRewrite = (out, count, ent, v, stride, last, genNow, lastUv, uvNow) => rewriteCornersWasm(b, out, count, ent, v, stride, last, genNow, lastUv, uvNow);
  // The float32 variants: the same client and table, another export (their calls and declines counted apart).
  const f32 = await loadWasmKernel('meshCornersF32', F32_URL, memory, F32_EXPORTS);
  const bindings = {};
  const rewriters = {};
  /** The binding a variant's rewrite goes through. */
  const bindingOf = (variant) => {
    const fn = MESH_CORNER_VARIANTS[variant]?.fn;
    if (!fn) return b;
    bindings[fn] ??= { ...b, rewrite: f32[fn], calls: 0, declined: 0 };
    return bindings[fn];
  };
  /** A variant's rewrite function, with rewriteExplicitMeshCorners' arguments. */
  const rewriteOf = (variant) => {
    const spec = MESH_CORNER_VARIANTS[variant];
    if (!spec.wasm) return rewriteExplicitMeshCorners;
    if (!spec.fn) return wasmRewrite;
    const bound = bindingOf(variant);
    rewriters[spec.fn] ??= (out, count, ent, v, stride, last, genNow, lastUv, uvNow) => rewriteCornersWasm(bound, out, count, ent, v, stride, last, genNow, lastUv, uvNow);
    return rewriters[spec.fn];
  };
  /** Pixi's rewrite of both batches on a frame whose vertices moved (the `!full && vertsMoved` branch). */
  const rewriteFrameWith = (rewrite, uvGen) => {
    const fill = rewrite(fillRows, fillCount, fillEntity, views, COLLIDER_FILL_FLOATS, lastVertGen, frameVertGen);
    const uv = uvGen
      ? rewrite(uvRows, uvCount, uvEntity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen, lastUvGen, frameUvGen)
      : rewrite(uvRows, uvCount, uvEntity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen);
    return fill * 4 + uv;
  };
  /** One frame's two calls for `variant`, as the timed op runs them. */
  const frameOp = (variant) => {
    const spec = MESH_CORNER_VARIANTS[variant];
    if (!spec) throw new Error(`unknown variant ${variant}`);
    const rewrite = rewriteOf(variant);
    return () => rewriteFrameWith(rewrite, spec.uvGen);
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
    const op = frameOp(variant);
    let h = 2166136261;
    for (let f = 0; f < FRAMES; f++) {
      logicTick(f);
      frameVertGen.set(MeshGeometry.vertGen);
      frameUvGen.set(MeshGeometry.uvGen);
      const codes = op();
      lastVertGen.set(frameVertGen);
      lastUvGen.set(frameUvGen);
      h = Math.imul(h ^ codes, 16777619) >>> 0;
      h = Math.imul(h ^ checksumInts(fillWords, fillCount * COLLIDER_FILL_FLOATS), 16777619) >>> 0;
      h = Math.imul(h ^ checksumInts(uvWords, uvCount * MESH_UV_FILL_FLOATS), 16777619) >>> 0;
    }
    return h;
  };

  /**
   * The timed state: the scene's dirty set, every grid and rope, against the generations drawn. The ropes'
   * UV generations moved too (setRope writes UVs); the grids' did not (setVertices).
   */
  const sceneDirty = () => {
    frameVertGen.set(MeshGeometry.vertGen);
    lastVertGen.set(frameVertGen);
    frameUvGen.set(MeshGeometry.uvGen);
    lastUvGen.set(frameUvGen);
    for (let k = 0; k < c.deform; k++) lastVertGen[first.deform + k] = ~frameVertGen[first.deform + k] >>> 0;
    for (let k = 0; k < c.rope; k++) {
      lastVertGen[first.rope + k] = ~frameVertGen[first.rope + k] >>> 0;
      lastUvGen[first.rope + k] = ~frameUvGen[first.rope + k] >>> 0;
    }
    return { rewritten: c.deform * deformTris + c.rope * ropeTris, withUv: c.rope * ropeTris };
  };

  /**
   * Short calls for a normal compile, over the timed state's generations: the first rigid fans of the fill
   * batch (clean, a walk) and the first four ropes of the UV batch (their UVs). The JS variants also run the
   * fill batch's first fans and stars with every mesh dirty (a private generation copy), so the fan loop and
   * the indexed loop without UVs (the grids' loop under js-uvgen) have their feedback before the timing.
   */
  const ropeRow = c.deform * deformTris;
  const ropeRows = Math.min(4, c.rope) * ropeTris;
  const shortUv = { rows: uvRows.subarray(ropeRow * MESH_UV_FILL_FLOATS), entity: uvEntity.subarray(ropeRow), count: ropeRows };
  const shortFill = Math.min(8, c.rigid) * (FAN_VERTS - 2);
  const starRow = c.rigid * (FAN_VERTS - 2);
  const starRows = Math.min(2, c.poly) * 8;
  const shortStars = { rows: fillRows.subarray(starRow * COLLIDER_FILL_FLOATS), entity: fillEntity.subarray(starRow), count: starRows };
  const warmLast = new Uint32Array(n);
  const shortFrame = (variant) => {
    const spec = MESH_CORNER_VARIANTS[variant];
    const rewrite = rewriteOf(variant);
    rewrite(fillRows, shortFill, fillEntity, views, COLLIDER_FILL_FLOATS, lastVertGen, frameVertGen);
    if (spec.uvGen) {
      rewrite(shortUv.rows, shortUv.count, shortUv.entity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen, lastUvGen, frameUvGen);
    } else {
      rewrite(shortUv.rows, shortUv.count, shortUv.entity, views, MESH_UV_FILL_FLOATS, lastVertGen, frameVertGen);
    }
    if (spec.wasm) return;
    // The rows these rewrite already hold what they write: the state the timing reads does not change.
    for (let i = 0; i < n; i++) warmLast[i] = ~frameVertGen[i] >>> 0;
    rewrite(fillRows, shortFill, fillEntity, views, COLLIDER_FILL_FLOATS, warmLast, frameVertGen);
    rewrite(shortStars.rows, shortStars.count, shortStars.entity, views, COLLIDER_FILL_FLOATS, warmLast, frameVertGen);
  };

  return {
    cohorts: c, n, fillCount, uvCount, b, bindingOf, views, frameOp, checksumFrames, sceneDirty, shortFrame,
  };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  const spec = MESH_CORNER_VARIANTS[variant];
  if (!spec) throw new Error(`unknown variant ${variant} (${Object.keys(MESH_CORNER_VARIANTS).join(', ')})`);
  const k = await setupMeshCornersKernel({ scale: Number(args.scale ?? 1) });

  const checksum = k.checksumFrames(variant);
  const bound = k.bindingOf(variant);
  if (spec.wasm && bound.declined) throw new Error(`the kernel declined ${bound.declined} calls`);
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} fill ${k.fillCount} uv ${k.uvCount} rows, ${FRAMES} frames`);
    return;
  }

  const dirty = k.sceneDirty();
  const op = k.frameOp(variant);
  if (op() !== 4 + 1) throw new Error('the scene frame does not rewrite both batches');
  // Normal compiles, not OSR: short calls over a few meshes of each batch.
  let tier = null;
  if (spec.wasm) tier = await warmWasm(bound.rewrite, () => k.shortFrame(variant));
  else warmNormalCompile(() => k.shortFrame(variant));
  const uvRows = spec.uvGen ? dirty.withUv : dirty.rewritten;
  const cases = {
    rewrite: timeIt(`mesh corners ${variant} (${k.fillCount} fill + ${k.uvCount} UV rows, ${dirty.rewritten} rewritten, ${uvRows} with UVs)`, op, { iterations: 20, warmup: 10 }),
  };
  const report = {
    feature: 'mesh-corners-wasm',
    variant,
    functions: ['rewriteExplicitMeshCorners', spec.fn ? `meshCornersF32.${spec.fn}` : 'meshCorners.rewrite_corners'],
    cohorts: k.cohorts,
    rows: { fill: k.fillCount, uv: k.uvCount, rewritten: dirty.rewritten, withUv: uvRows },
    checksum,
    declined: bound.declined,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} rows ${k.fillCount} + ${k.uvCount}${tier ? ` tier ${tier}` : ''} rewrite ${cases.rewrite.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
