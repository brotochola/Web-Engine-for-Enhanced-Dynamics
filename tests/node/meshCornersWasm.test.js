// E-76 W11: the mesh corner rewrite kernel (wasm/meshCorners.c, through the client's rewriteCornersWasm)
// against the shipped rewriteExplicitMeshCorners, in one memory that starts with the MeshGeometry block as the
// product's mesh memory does. Random frames are written straight into the columns, so they reach what the
// MeshRenderer API never makes: fans and index lists, with and without the UV batch's corners, generations
// equal and not, entities with no mesh, ids past the geometry columns, past the generations and past 2^31
// (negative as int32), drawn generations shorter than the captured ones, runs a triangle short or long, runs
// of one entity split in two, meshes under 3 vertices, corner indices past the mesh, spans that run past the
// vertex or index column (undefined reads: NaN corners, index 0), strides that overlap rows, no UV columns,
// the live generations instead of a capture, and empty calls. E-118: the UV generations too, absent, live or
// captured, short or long, moved with the vertex generation, without it, or not at all. Corners hold NaN with
// payloads, both zeros, infinities and subnormals. Each frame: the same return code, and every word of the row
// region (the corners and the pose, paint and depth words the rewrite must leave alone) bit for bit.
// Signaling NaNs are left out: V8 quiets them on some JS tiers and not others, and the API stores finite values.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS, rewriteExplicitMeshCorners } from '../../src/render/colliderFillBatch.js';
import { rewriteCornersWasm } from '../../src/render/meshCornersClient.js';
import { MESH_CORNER_VARIANTS, setupMeshCornersKernel } from '../bench/meshCornersWasmMicrobench.mjs';
import { E, FRAMES, GEN_ROOM, I, V, frameCall, rng, setup, viewsOf, writeGeometry, writeInstances } from '../helpers/meshCornerFrames.mjs';

/**
 * What the JS should do with this frame, run by run, in its order: the return code and the branches taken,
 * for the coverage tally. Checked against the JS's own code, so a mirror that drifts fails loudly. `uvGen`
 * is the UV generation array the call resolves (captured or live), null for none.
 */
function expected(s, views, n, step, gen, last, uvGen, lastUv, tally) {
  const g = s.geom;
  const ent = s.entity;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!views.meshUvU && !!views.meshUvV;
  const uvG = uvOn && lastUv ? uvGen : null;
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
    const vertDirty = i >= 0 && i < gen.length && gen[i] !== (i < last.length ? last[i] : 0);
    const uvDirty = uvG !== null && i >= 0 && i < uvG.length && uvG[i] !== (i < lastUv.length ? lastUv[i] : 0);
    if (uvG !== null && i >= 0 && i < uvG.length && i >= lastUv.length) tally.lastUvShort++;
    k = end;
    if (!vertDirty && !uvDirty) {
      if (i >= 0 && i < gen.length) tally.clean++;
      continue;
    }
    if (!vertDirty) tally.uvOnly++;
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
    const uvRun = uvOn && (uvG === null || uvDirty);
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
      tally[uvRun ? 'indexedUv' : 'indexed']++;
      if (pastIndices) tally.pastIndices++;
      if (pastVerts) tally.pastVerts++;
    } else {
      tally[uvRun ? 'fanUv' : 'fan']++;
      if (pastVerts) tally.pastVerts++;
    }
    if (uvOn && uvG !== null) tally[uvDirty ? 'uvWritten' : 'uvSkipped']++;
  }
  return n > 0 ? 1 : 0;
}

test('the corner kernel writes what rewriteExplicitMeshCorners writes, frame after frame', async (t) => {
  const s = await setup();
  const r = rng(0x3e5c);
  const tally = {
    clean: 0, negative: 0, pastGen: 0, lastShort: 0, pastGeometry: 0, noMesh: 0, need: 0, underThree: 0, badIndex: 0,
    fan: 0, fanUv: 0, indexed: 0, indexedUv: 0, pastVerts: 0, pastIndices: 0, longRun: 0,
    uvOnly: 0, uvWritten: 0, uvSkipped: 0, lastUvShort: 0,
  };
  const codes = { 0: 0, 1: 0, '-1': 0 };
  const uvCalls = { none: 0, live: 0, captured: 0 };
  const pattern = new Uint32Array(s.outWords.length);
  for (let k = 0; k < FRAMES; k++) {
    const { mode, n, views, stride, last, genNow, lastUvGen, uvGenNow, uvKind, step, gen, uvSource } = frameCall(r, s, k, pattern);
    uvCalls[uvKind]++;

    s.outWords.set(pattern);
    const jsCode = rewriteExplicitMeshCorners(s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
    const jsWords = s.outWords.slice();
    assert.equal(expected(s, views, n, step, gen, last, uvSource, lastUvGen, tally), jsCode, `frame ${k} (mode ${mode}): the test's mirror of the JS`);
    s.outWords.set(pattern);
    const declined = s.b.declined;
    const code = rewriteCornersWasm(s.b, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
    assert.equal(s.b.declined, declined, `frame ${k}: the kernel took the call`);
    assert.equal(code, jsCode, `frame ${k} (mode ${mode}, ${n} instances, stride ${stride}): return code`);
    const at = s.outWords.findIndex((w, q) => w !== jsWords[q]);
    assert.equal(at, -1, `frame ${k} (mode ${mode}, stride ${stride}): rows differ at word ${at} (row ${Math.floor(at / step)}, float ${at % step}): kernel 0x${(s.outWords[at] >>> 0).toString(16)}, JS 0x${(jsWords[at] >>> 0).toString(16)}`);
    codes[jsCode]++;
  }
  for (const [branch, hits] of Object.entries(tally)) assert.ok(hits > 0, `no frame reached ${branch}`);
  for (const [code, hits] of Object.entries(codes)) assert.ok(hits > 0, `no frame returned ${code}`);
  for (const [kind, hits] of Object.entries(uvCalls)) assert.ok(hits > 0, `no frame called with ${kind} UV generations`);
  t.diagnostic(`${FRAMES} frames; codes ${JSON.stringify(codes)}; UV generations ${JSON.stringify(uvCalls)}; runs ${JSON.stringify(tally)}`);
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
  // E-118: UV generations the kernel cannot read.
  const uvGen = s.uvGen.subarray(0, E);
  rewriteCornersWasm(s.b, s.out, n, s.entity, views, MESH_UV_FILL_FLOATS, last, gen, new Uint32Array(E), uvGen);
  assert.equal(s.b.declined, 4, 'drawn UV generations outside the memory');
  rewriteCornersWasm(s.b, s.out, n, s.entity, views, MESH_UV_FILL_FLOATS, last, gen, s.lastUv.subarray(0, E), new Uint32Array(s.buffer, 0, E));
  assert.equal(s.b.declined, 5, 'UV generations at byte 0, which the table reads as none');
  rewriteCornersWasm(s.b, s.out, n, s.entity, views, MESH_UV_FILL_FLOATS, last, gen, s.lastUv.subarray(0, E), Array.from(uvGen));
  assert.equal(s.b.declined, 6, 'UV generations that are not a Uint32Array');
  // On the fill batch the UV generations are not read, so they cannot decline the call.
  rewriteCornersWasm(s.b, s.out, n, s.entity, views, COLLIDER_FILL_FLOATS, last, gen, new Uint32Array(E), uvGen);
  assert.equal(s.b.declined, 6, 'the fill batch ignores them');
  assert.equal(rewriteCornersWasm(s.b, s.out, 0, s.entity, views, COLLIDER_FILL_FLOATS, last, gen), 0);
  assert.equal(rewriteCornersWasm(s.b, s.out, n, s.entity, { ...views, meshVertGen: null }, COLLIDER_FILL_FLOATS, last, null), 0);
  assert.equal(s.b.declined, 6, 'the early returns never reach the kernel or the JS');
});

test('the bench scene hashes the same through every variant', async () => {
  const hashes = {};
  for (const variant of Object.keys(MESH_CORNER_VARIANTS)) {
    const k = await setupMeshCornersKernel({ scale: 0.125 });
    hashes[variant] = k.checksumFrames(variant);
    if (MESH_CORNER_VARIANTS[variant].wasm) {
      assert.equal(k.b.declined, 0, `${variant}: the kernel took every call`);
      assert.ok(k.b.calls > 0, `${variant}: the kernel ran`);
    }
    assert.ok(k.uvCount > 10000 && k.fillCount > 400, `${k.fillCount} fill and ${k.uvCount} UV rows`);
  }
  assert.deepEqual(new Set(Object.values(hashes)).size, 1, `checksums ${JSON.stringify(hashes)}`);
});
