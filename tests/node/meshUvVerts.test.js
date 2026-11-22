// E-453: a MESH layer's UV batch draws each mesh's vertices once, through an index buffer (packMeshUvVerts,
// MeshUvFillBatch), where its rows (packMeshUvFill) gave every triangle its 3 corners again; its rewrite is the corner
// kernel's rewrite_verts (rewriteVertsWasm; JS reference tests/reference/meshUvVerts.mjs). What this holds:
// - the layout: the batch's attributes, both shaders' fields and the kernel's floats are MESH_UV_VERT's;
// - the pack: its records, indices and spans, and its triangles against the rows the batch drew before: the same
//   triangles in the same order, corner for corner, with the same pose, paint and entity (the indexed path draws the
//   same triangles), on random scenes made through MeshGeometry;
// - the paint refill and the rewrite against a repack, edit after edit, through the MeshGeometry API;
// - the kernel against the reference, bit for bit, on random frames written straight into the columns (meshes torn
//   past their columns, counts and indices past the mesh, runs that do not match, spans that do not, ids past the
//   columns and the span table, the generations), on 16-bit and 32-bit arenas;
// - the batch's uploads: the index buffer's view, the instance count, the ranges, WebGL's vertex array unbound first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import {
  MESH_UV_FILL_FLOATS,
  MESH_UV_VERT,
  MESH_UV_VERT_FLOATS,
  packMeshUvFill,
  packMeshUvVerts,
  packMeshUvVertsPaint,
  packedMeshUvIndices,
} from '../../src/render/colliderFillBatch.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';
import {
  bindMeshCorners,
  MESH_CORNER_SLOTS,
  rewriteVertsWasm,
  rewrittenFirstIndex,
  rewrittenFirstRow,
  rewrittenPastIndex,
  rewrittenPastRow,
} from '../../src/render/meshCornersClient.js';
import { MESH_NO_TEXTURE } from '../../src/components/meshRenderer.js';
import { SPRITE_TILE_MODE } from '../../src/util/configDefaults.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { expandMeshUvVerts, rewriteMeshUvVerts } from '../reference/meshUvVerts.mjs';
import { rng } from '../helpers/meshCornerFrames.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

const shader = (name) => readEngineShader(name);
const F = MESH_UV_VERT_FLOATS;

function words(view) {
  return new Uint32Array(view.buffer, view.byteOffset, view.length);
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let q = 0; q < n; q++) if (a[q] !== b[q]) return q;
  return -1;
}

/** A pack target of its own (MeshUvFillBatch's fields): `cap` records, `indexCap` indices, a span table of `entities`. */
function target(cap, indexCap, entities) {
  const verts = new Float32Array(cap * F);
  return {
    verts,
    vertsU32: new Uint32Array(verts.buffer),
    capacity: cap,
    vertexEntity: new Uint32Array(cap),
    indices: new Uint32Array(indexCap),
    indexCapacity: indexCap,
    indexSpan: new Uint32Array(entities * 2),
  };
}

// ---- layout ----

/** The record floats a shader's `name = aVert0.xy;` (GLSL or WGSL) reads, in order. */
function vertFloats(source, name, what) {
  const m = source.match(new RegExp(`\\b${name} = ([^;]+);`));
  assert.ok(m, `${what}: no ${name} = ...;`);
  const out = [];
  for (const part of m[1].matchAll(/aVert(\d)\.([xyzw]+)/g)) {
    for (const c of part[2]) out.push(Number(part[1]) * 4 + 'xyzw'.indexOf(c));
  }
  return out;
}

// What each name the shaders give a record's fields reads: [MESH_UV_VERT field, floats].
const VERT_NAMES = {
  local: ['XY', 2],
  aUV: ['UV', 2],
  aInstXY: ['POS', 2],
  aInstRotCS: ['ROT', 2],
  aInstTintBits: ['TINT_BITS', 1],
  aInstReach: ['REACH', 1],
  aInstTexId: ['TEX_ID', 1],
  aInstBody: ['BODY', 1],
  aInstTileInv: ['TILE_INV', 2],
  aInstTileOff: ['TILE_OFF', 2],
};

function wgslBatch(opts = {}) {
  return new MeshUvFillBatch({
    capacity: 8,
    indexCapacity: 12,
    entities: 4,
    useWebGpu: true,
    shaders: { meshUvFill: shader('meshUvFill.wgsl') },
    ...opts,
  });
}

test('the UV batch reads a vertex record as 4 vec4 a vertex through its index buffer, and its shaders and the kernel read each field where MESH_UV_VERT puts it', () => {
  assert.equal(F, 16);
  const batch = wgslBatch();
  const attrs = batch.geometry.attributes;
  const wgslAttrs = batch.shader.gpuProgram.attributeData;
  const names = Object.keys(attrs).sort();
  assert.deepEqual(names, ['aVert0', 'aVert1', 'aVert2', 'aVert3']);
  assert.deepEqual(Object.keys(wgslAttrs).sort(), names);
  for (let k = 0; k < 4; k++) {
    const a = attrs[`aVert${k}`];
    assert.equal(a.format, 'float32x4', `aVert${k}`);
    assert.equal(wgslAttrs[`aVert${k}`].format, 'float32x4', `aVert${k} in the WGSL`);
    assert.ok(!a.instance, `aVert${k}: one a vertex`);
    assert.equal(a.stride, F * 4, `aVert${k}`);
    assert.equal(a.offset, k * 16, `aVert${k}`);
    assert.equal(a.buffer, batch.buffer, `aVert${k}`);
  }
  assert.equal(batch.geometry.indexBuffer, batch.indexBuffer);
  assert.ok(batch.indexBuffer.data instanceof Uint32Array, 'Uint32 indices');
  for (const file of ['meshUvFill.vert.glsl', 'meshUvFill.wgsl']) {
    const source = shader(file);
    assert.ok(!/aRow\d|aTri\b|gl_VertexID|vertex_index/.test(source), `${file}: no row and no corner left`);
    for (const [name, [field, n]] of Object.entries(VERT_NAMES)) {
      const want = Array.from({ length: n }, (_, i) => MESH_UV_VERT[field] + i);
      assert.deepEqual(vertFloats(source, name, file), want, `${file}: ${name} reads MESH_UV_VERT.${field}`);
    }
  }
  const C = fs.readFileSync(new URL('../../wasm/meshCorners.c', import.meta.url), 'utf8');
  const define = (name) => {
    const m = C.match(new RegExp(`^#define ${name} (\\d+)u?\\b`, 'm'));
    assert.ok(m, `wasm/meshCorners.c defines ${name}`);
    return Number(m[1]);
  };
  assert.equal(define('V_FLOATS'), F, 'the kernel steps a record as MESH_UV_VERT_FLOATS');
  assert.equal(define('V_REACH'), MESH_UV_VERT.REACH, 'and writes the reach where the shaders read it');
  // verts_run stores x, y as one pair at float 0 and u, v as one at float 2.
  assert.equal(MESH_UV_VERT.XY, 0);
  assert.equal(MESH_UV_VERT.UV, 2);
});

// ---- scenes through MeshGeometry ----

/** MeshGeometry on a buffer of its own and the views Pixi's packs read (_ensureColliderFillViews). */
function geometryScene(E, V, I, width) {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const buffer = new SharedArrayBuffer(MeshGeometry.getBufferSize(V, I, E, width));
  MeshGeometry.initializeArrays(buffer, V, I, E, width);
  const g = MeshGeometry;
  return {
    entityCount: E,
    meshActive: new Uint8Array(E),
    meshVisible: new Uint8Array(E),
    meshLayerMask: new Uint16Array(E),
    meshTint: new Uint32Array(E),
    meshAlpha: new Float32Array(E),
    meshBits: 3,
    x: new Float32Array(E),
    y: new Float32Array(E),
    rotC: new Float32Array(E),
    rotS: new Float32Array(E),
    meshTextureId: new Uint16Array(E).fill(MESH_NO_TEXTURE),
    meshTileMode: new Uint8Array(E),
    meshRepeatX: new Float32Array(E),
    meshRepeatY: new Float32Array(E),
    meshTileOffU: new Uint16Array(E),
    meshTileOffV: new Uint16Array(E),
    meshFloorScale: new Float32Array(E),
    meshVertOffset: g.vertOffset,
    meshVertCount: g.vertCount,
    meshIndexOffset: g.indexOffset,
    meshIndexCount: g.indexCount,
    meshHasUv: g.hasUv,
    meshVertexX: g.vertexX,
    meshVertexY: g.vertexY,
    meshUvU: g.uvU,
    meshUvV: g.uvV,
    meshIndices: g.indices,
    meshVertGen: g.vertGen,
    meshUvGen: g.uvGen,
    instanceEntity: null,
    outU32: null,
    layerHasVertexUv: 0,
  };
}

/** A mesh: vN vertices, an index list or a fan (indices null), UVs. */
function randomMesh(r, vN = 3 + Math.floor(r() * 12)) {
  const positions = Array.from({ length: vN * 2 }, () => (r() - 0.5) * 120);
  const uvs = Array.from({ length: vN * 2 }, () => r());
  let indices = null;
  if (r() < 0.6) {
    const tris = 1 + Math.floor(r() * 10);
    indices = Array.from({ length: tris * 3 }, () => Math.floor(r() * vN));
  }
  return { vN, positions, indices, uvs };
}

function paintEntity(r, views, e) {
  views.meshTint[e] = Math.floor(r() * 0x1000000);
  views.meshAlpha[e] = r() < 0.1 ? -0.5 : r() < 0.1 ? 1.5 : r();
  views.x[e] = (r() - 0.5) * 4000;
  views.y[e] = (r() - 0.5) * 3000;
  const a = r() * Math.PI * 2;
  views.rotC[e] = r() < 0.1 ? 0 : Math.cos(a);
  views.rotS[e] = r() < 0.1 ? 0 : Math.sin(a);
  views.meshTextureId[e] = r() < 0.5 ? MESH_NO_TEXTURE : Math.floor(r() * 40);
  views.meshTileMode[e] = r() < 0.5 ? SPRITE_TILE_MODE.WORLD : SPRITE_TILE_MODE.STRETCH;
  views.meshRepeatX[e] = r() < 0.5 ? 0 : 1 + r() * 4;
  views.meshRepeatY[e] = r() < 0.5 ? 0 : 1 + r() * 4;
  views.meshTileOffU[e] = Math.floor(r() * 65536);
  views.meshTileOffV[e] = Math.floor(r() * 65536);
  views.meshFloorScale[e] = r() < 0.3 ? 0.4 + r() : 0;
}

/** Every entity: a mesh (most with UVs, some fans, some without UVs: the fill batch's), its paint, its pose, its masks. */
function populate(r, views) {
  const E = views.entityCount;
  const meshes = [];
  for (let e = 0; e < E; e++) {
    const p = r();
    let mesh = null;
    if (p > 0.12) {
      mesh = randomMesh(r);
      assert.ok(MeshGeometry.replace(e, mesh.positions, mesh.indices, p < 0.88 ? mesh.uvs : null), `mesh ${e}`);
    }
    meshes.push(mesh);
    views.meshActive[e] = r() < 0.92 ? 1 : 0;
    views.meshVisible[e] = r() < 0.92 ? 1 : 0;
    views.meshLayerMask[e] = r() < 0.85 ? 1 : 2;
    paintEntity(r, views, e);
  }
  return meshes;
}

test('packMeshUvVerts writes each mesh vertex once, MESH_UV_VERT field by field, its triangles in order and its span', () => {
  const views = geometryScene(4, 64, 64);
  views.meshActive.fill(1);
  views.meshVisible.fill(1);
  views.meshLayerMask.fill(1);
  // Entity 1: a quad, two indexed triangles; entity 2: a fan of 5; entity 3: no UVs (the fill batch's).
  MeshGeometry.replace(1, [1, 2, 3, 4, 5, 6, 7, 8], [0, 1, 2, 0, 2, 3], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  MeshGeometry.replace(2, [3, 0, 0, 4, -3, 0, -1, -2, 2, -2], null, [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5]);
  MeshGeometry.replace(3, [0, 0, 1, 0, 1, 1]);
  views.meshTint[1] = 0x123456;
  views.meshAlpha[1] = 0.5;
  views.x[1] = 30;
  views.y[1] = 40;
  views.rotC[1] = 0.6;
  views.rotS[1] = 0.8;
  views.meshTextureId[1] = 7;
  views.meshTileMode[1] = SPRITE_TILE_MODE.WORLD;
  views.meshRepeatX[1] = 4;
  views.meshRepeatY[1] = 2;
  views.meshTileOffU[1] = 13107;
  views.meshTileOffV[1] = 26214;
  views.meshTint[2] = 0xff0000;
  views.meshAlpha[2] = 1;
  views.x[2] = -5;
  views.y[2] = 7;
  views.rotC[2] = 1;
  views.meshFloorScale[2] = 0.7;
  const t = target(16, 30, 4);
  t.indices.fill(0xdead);
  assert.equal(packMeshUvVerts(t, 0, views), 9);
  assert.equal(packedMeshUvIndices(), 15);
  assert.deepEqual(Array.from(t.vertexEntity.subarray(0, 9)), [1, 1, 1, 1, 2, 2, 2, 2, 2]);
  // The quad's two triangles, then the fan's three, as indices of the records.
  assert.deepEqual(Array.from(t.indices.subarray(0, 15)), [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 4, 7, 8]);
  assert.equal(t.indices[15], 0xdead, 'nothing past them');
  assert.deepEqual(Array.from(t.indexSpan.subarray(2, 6)), [0, 6, 6, 9]);
  const u32 = t.vertsU32;
  const at = (k, field, i = 0) => t.verts[k * F + MESH_UV_VERT[field] + i];
  const quadReach = Math.fround(Math.sqrt(7 * 7 + 8 * 8));
  for (let v = 0; v < 4; v++) {
    assert.equal(at(v, 'XY'), Math.fround(1 + 2 * v), `quad vertex ${v} x`);
    assert.equal(at(v, 'XY', 1), Math.fround(2 + 2 * v), `quad vertex ${v} y`);
    assert.equal(at(v, 'UV'), Math.fround(0.1 + 0.2 * v), `quad vertex ${v} u`);
    assert.equal(at(v, 'UV', 1), Math.fround(0.2 + 0.2 * v), `quad vertex ${v} v`);
    assert.deepEqual([at(v, 'POS'), at(v, 'POS', 1), at(v, 'ROT'), at(v, 'ROT', 1)], [30, 40, Math.fround(0.6), Math.fround(0.8)]);
    assert.equal(u32[v * F + MESH_UV_VERT.TINT_BITS], 0x80123456);
    assert.equal(at(v, 'REACH'), quadReach, 'the farthest vertex of the quad');
    assert.equal(at(v, 'TEX_ID'), 7);
    assert.equal(at(v, 'BODY'), 1);
    assert.deepEqual([at(v, 'TILE_INV'), at(v, 'TILE_INV', 1)], [0.25, 0.5]);
    assert.deepEqual([at(v, 'TILE_OFF'), at(v, 'TILE_OFF', 1)], [Math.fround(13107 / 65535), Math.fround(26214 / 65535)]);
  }
  for (let v = 4; v < 9; v++) {
    assert.equal(u32[v * F + MESH_UV_VERT.TINT_BITS], 0xffff0000);
    assert.equal(at(v, 'REACH'), 4, 'the fan reaches 4');
    assert.equal(at(v, 'TEX_ID'), -1);
    assert.equal(at(v, 'BODY'), 2);
    assert.equal(at(v, 'TILE_OFF'), Math.fround(0.7), "a volume's floor scale in the tile offset");
  }
});

test('the indexed batch draws the triangles the rows drew: the same triangles in the same order, corner for corner', () => {
  const r = rng(0xe453);
  let triangles = 0;
  for (let round = 0; round < 40; round++) {
    const E = 30 + Math.floor(r() * 50);
    const views = geometryScene(E, 2048, 4096);
    populate(r, views);
    const capRows = 2048;
    const rows = new Float32Array(capRows * MESH_UV_FILL_FLOATS);
    views.instanceEntity = new Uint32Array(capRows);
    views.outU32 = new Uint32Array(rows.buffer);
    const nRows = packMeshUvFill(rows, capRows, 0, views);
    const t = target(2048, capRows * 3, E);
    const n = packMeshUvVerts(t, 0, views);
    const m = packedMeshUvIndices();
    assert.equal(m, nRows * 3, `round ${round}: a triangle a row`);
    const drawn = new Uint32Array(expandMeshUvVerts(t.verts, t.indices, m).buffer);
    const rowWords = new Uint32Array(rows.buffer, 0, nRows * MESH_UV_FILL_FLOATS);
    for (let q = 0; q < rowWords.length; q++) {
      if (q % MESH_UV_FILL_FLOATS === 11) continue; // the depth: the records carry none, and the draw tests none
      assert.equal(drawn[q], rowWords[q], `round ${round}: row ${Math.floor(q / MESH_UV_FILL_FLOATS)}, float ${q % MESH_UV_FILL_FLOATS}`);
    }
    // Each record is its entity's, a mesh's vertices once, in its order, and the span holds what the pack wrote.
    let k = 0;
    while (k < n) {
      const e = t.vertexEntity[k];
      const vN = MeshGeometry.vertCount[e];
      for (let v = 0; v < vN; v++) {
        assert.equal(t.vertexEntity[k + v], e);
        assert.equal(t.verts[(k + v) * F], MeshGeometry.vertexX[MeshGeometry.vertOffset[e] + v]);
      }
      const at = t.indexSpan[e * 2];
      const count = t.indexSpan[e * 2 + 1];
      for (let j = 0; j < count; j++) assert.ok(t.indices[at + j] >= k && t.indices[at + j] < k + vN, 'an index of its own records');
      k += vN;
    }
    triangles += nRows;
  }
  assert.ok(triangles > 2000, `${triangles} triangles compared`);
});

test('packMeshUvVerts stops at a mesh past its records or a triangle past its indices, the earlier ones kept', () => {
  const views = geometryScene(4, 64, 64);
  views.meshActive.fill(1);
  views.meshVisible.fill(1);
  views.meshLayerMask.fill(1);
  for (let e = 0; e < 3; e++) MeshGeometry.replace(e, [0, 0, 4, 0, 4, 4, 0, 4], [0, 1, 2, 0, 2, 3], [0, 0, 1, 0, 1, 1, 0, 1]);
  // Room for two meshes' records: the third ends the pack.
  let t = target(10, 30, 4);
  assert.equal(packMeshUvVerts(t, 0, views), 8);
  assert.equal(packedMeshUvIndices(), 12);
  // Room for 2 and a half meshes' triangles: the third mesh keeps its first and the pack ends.
  t = target(16, 15, 4);
  assert.equal(packMeshUvVerts(t, 0, views), 12);
  assert.equal(packedMeshUvIndices(), 15);
  assert.deepEqual(Array.from(t.indexSpan.subarray(4, 6)), [12, 3]);
  // No room: nothing.
  t = target(16, 2, 4);
  assert.equal(packMeshUvVerts(t, 0, views), 0);
  assert.equal(packedMeshUvIndices(), 0);
});

test('packMeshUvVertsPaint writes what a repack writes', () => {
  const r = rng(0x9a17);
  for (let round = 0; round < 30; round++) {
    const E = 40;
    const views = geometryScene(E, 1024, 2048);
    populate(r, views);
    const t = target(1024, 6144, E);
    const n = packMeshUvVerts(t, 0, views);
    // New paint and poses for some entities.
    for (let e = 0; e < E; e++) if (r() < 0.5) paintEntity(r, views, e);
    packMeshUvVertsPaint(t, n, views);
    const fresh = target(1024, 6144, E);
    assert.equal(packMeshUvVerts(fresh, 0, views), n);
    const at = firstDiff(words(t.verts).subarray(0, n * F), words(fresh.verts).subarray(0, n * F));
    assert.equal(at, -1, `round ${round}: record ${Math.floor(at / F)}, float ${at % F}`);
  }
});

/** The rewrite's arguments as Pixi passes them: the generations it drew, this frame's capture. */
function generations(views, drawn) {
  return {
    genNow: views.meshVertGen.slice(),
    uvGenNow: views.meshUvGen.slice(),
    lastVertGen: drawn.vert,
    lastUvGen: drawn.uv,
  };
}

test('the rewrite of the records gives what a repack gives, edit after edit through MeshGeometry', () => {
  const r = rng(0x5e7);
  const E = 60;
  const views = geometryScene(E, 2048, 4096);
  const meshes = populate(r, views);
  const t = target(2048, 8192, E);
  let n = packMeshUvVerts(t, 0, views);
  let m = packedMeshUvIndices();
  let drawn = { vert: views.meshVertGen.slice(), uv: views.meshUvGen.slice() };
  let revision = MeshGeometry.revision[0];
  const tally = { done: 0, repack: 0, topology: 0, records: 0, indicesWritten: 0 };
  for (let f = 0; f < 400; f++) {
    // Now and then a new topology: Pixi repacks (the revision moved).
    const topology = r() < 0.08 ? Math.floor(r() * E) : -1;
    for (let e = 0; e < E; e++) {
      const mesh = meshes[e];
      if (e === topology) {
        const next = randomMesh(r);
        meshes[e] = next;
        MeshGeometry.replace(e, next.positions, next.indices, next.uvs);
        continue;
      }
      if (!mesh || MeshGeometry.vertOffset[e] < 0 || r() < 0.6) continue;
      const p = r();
      if (p < 0.45) {
        mesh.positions = mesh.positions.map((v) => v + (r() - 0.5) * 6);
        MeshGeometry.writeVertices(e, mesh.positions);
      } else if (p < 0.7) {
        // Heights in U (DX-SUNMESH), on a mesh with UVs (one without gets them: a new topology).
        if (MeshGeometry.hasUv[e]) MeshGeometry.writeHeights(e, Array.from({ length: mesh.vN }, () => r() * 80));
      } else {
        // The same shape again: new indices (as many), new UVs, in place.
        if (mesh.indices) mesh.indices = mesh.indices.map(() => Math.floor(r() * mesh.vN));
        mesh.uvs = mesh.uvs.map(() => r());
        MeshGeometry.replace(e, mesh.positions, mesh.indices, MeshGeometry.hasUv[e] ? mesh.uvs : null);
      }
    }
    const g = generations(views, drawn);
    if (MeshGeometry.revision[0] !== revision) {
      revision = MeshGeometry.revision[0];
      n = packMeshUvVerts(t, 0, views);
      m = packedMeshUvIndices();
      tally.topology++;
    } else {
      const res = rewriteMeshUvVerts(t, n, views, g.lastVertGen, g.genNow, g.lastUvGen, g.uvGenNow);
      if (res.result < 0) {
        n = packMeshUvVerts(t, 0, views);
        m = packedMeshUvIndices();
        tally.repack++;
      } else {
        tally.done++;
        tally.records += Math.max(0, res.pastRow - res.firstRow);
        tally.indicesWritten += Math.max(0, res.pastIndex - res.firstIndex);
      }
    }
    drawn = { vert: g.genNow, uv: g.uvGenNow };
    const fresh = target(2048, 8192, E);
    assert.equal(packMeshUvVerts(fresh, 0, views), n, `frame ${f}: records`);
    assert.equal(packedMeshUvIndices(), m, `frame ${f}: indices`);
    const atV = firstDiff(words(t.verts).subarray(0, n * F), words(fresh.verts).subarray(0, n * F));
    assert.equal(atV, -1, `frame ${f}: record ${Math.floor(atV / F)}, float ${atV % F}`);
    const atI = firstDiff(t.indices.subarray(0, m), fresh.indices.subarray(0, m));
    assert.equal(atI, -1, `frame ${f}: index ${atI}`);
  }
  assert.ok(tally.done > 300 && tally.records > 10000 && tally.indicesWritten > 10000, JSON.stringify(tally));
});

test('the rewrite answers -1 when the records or the triangles no longer match the mesh, before it writes the run', () => {
  const views = geometryScene(3, 64, 64);
  views.meshActive.fill(1);
  views.meshVisible.fill(1);
  views.meshLayerMask.fill(1);
  MeshGeometry.replace(0, [0, 0, 4, 0, 4, 4, 0, 4], [0, 1, 2, 0, 2, 3], [0, 0, 1, 0, 1, 1, 0, 1]);
  MeshGeometry.replace(1, [0, 0, 2, 0, 2, 2, 0, 2], null, [0, 0, 1, 0, 1, 1, 0, 1]);
  const t = target(16, 30, 3);
  const n = packMeshUvVerts(t, 0, views);
  assert.equal(n, 8);
  const before = words(t.verts).slice();
  const last = new Uint32Array(3);
  const lastUv = new Uint32Array(3);
  const call = () => rewriteMeshUvVerts(t, n, views, last, new Uint32Array([1, 0, 0]), lastUv, new Uint32Array(3)).result;
  // An index past the mesh.
  MeshGeometry.indices[MeshGeometry.indexOffset[0] + 4] = 4;
  assert.equal(call(), -1);
  assert.equal(firstDiff(words(t.verts), before), -1, 'nothing of the run written');
  MeshGeometry.indices[MeshGeometry.indexOffset[0] + 4] = 2;
  // Another triangle count than the span's.
  MeshGeometry.indexCount[0] = 3;
  assert.equal(call(), -1);
  MeshGeometry.indexCount[0] = 6;
  // Another vertex count than the run's.
  MeshGeometry.vertCount[0] = 5;
  assert.equal(call(), -1);
  MeshGeometry.vertCount[0] = 4;
  // A span table that does not cover the entity.
  const short = { ...t, indexSpan: t.indexSpan.subarray(0, 0) };
  assert.equal(rewriteMeshUvVerts(short, n, views, last, new Uint32Array([1, 0, 0]), lastUv, new Uint32Array(3)).result, -1);
  // A mesh torn past its column.
  const off = MeshGeometry.vertOffset[0];
  MeshGeometry.vertOffset[0] = MeshGeometry.vertexX.length - 2;
  assert.equal(call(), -1);
  MeshGeometry.vertOffset[0] = off;
  // A cleared mesh is left as it was (the revision that cleared it repacks).
  MeshGeometry.vertOffset[0] = -1;
  assert.equal(call(), 1);
  assert.equal(firstDiff(words(t.verts), before), -1);
  MeshGeometry.vertOffset[0] = off;
  assert.equal(call(), 1);
});

// ---- the batch's uploads ----

test("the batch's uploads: the records and indices it draws, the index buffer a view of its count, WebGL's vertex array unbound first", () => {
  const log = [];
  const bufferSystem = { updateBuffer: (b) => log.push(['send', b === batch.indexBuffer ? 'indices' : 'records', b._updateOffset, b._updateSize]) };
  const geometrySystem = { unbind: () => log.push(['unbind']) };
  const batch = wgslBatch({ bufferSystem, geometrySystem, capacity: 8, indexCapacity: 12 });
  for (let q = 0; q < batch.verts.length; q++) batch.verts[q] = q;
  batch.indices.set([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  assert.equal(batch.upload(8, 6), 6);
  assert.equal(batch.geometry.instanceCount, 1);
  assert.equal(batch.mesh.visible, true);
  assert.equal(batch.indexCount, 6);
  assert.equal(batch.indexBuffer.data.length, 6, 'Pixi draws data.length indices');
  assert.deepEqual(Array.from(batch.indexBuffer.data), [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(log, [['send', 'records', 0, 8 * F * 4], ['unbind'], ['send', 'indices', 0, 24]]);
  log.length = 0;
  // More indices: a longer view of the same array.
  assert.equal(batch.upload(8, 12), 12);
  assert.equal(batch.indexBuffer.data.length, 12);
  assert.equal(batch.indexBuffer.data.buffer, batch.indexData.buffer);
  // The rewrite's ranges.
  log.length = 0;
  batch.uploadRange(2, 4);
  batch.indices[7] = 3;
  batch.uploadIndexRange(6, 9);
  assert.equal(batch.indexData[7], 3);
  assert.deepEqual(log, [['send', 'records', 2 * F * 4, 2 * F * 4], ['unbind'], ['send', 'indices', 24, 12]]);
  log.length = 0;
  batch.uploadIndexRange(10, 40);
  assert.deepEqual(log, [['unbind'], ['send', 'indices', 40, 8]], 'clipped to the indices drawn');
  // Nothing to draw.
  assert.equal(batch.upload(0, 0), 0);
  assert.equal(batch.geometry.instanceCount, 0);
  assert.equal(batch.mesh.visible, false);
  assert.equal(batch.indexCount, 0);
  assert.equal(batch.upload(8, 2), 0, 'no whole triangle');
});

// ---- the kernel against the reference ----

const KE = 48;
const KV = 1024;
const KI = 3072;
const KCAP = 900;
const KDRAW = 4096;
const GEN_ROOM = KE + 16;
const SPECIAL = [0x7fc00000, 0xffc00000, 0x7fc0beef, 0x80000000, 0x00000000, 0x7f800000, 0xff800000, 0x00000001, 0x807fffff];
const WIDE_BAD = [65535, 65536, 0x7fffffff, 0x80000000, 0xffffffff];

async function kernelSetup(width) {
  const layout = layoutRegions([
    { name: 'meshGeometry', owner: 'test', bytes: MeshGeometry.getBufferSize(KV, KI, KE, width) },
    { name: 'table', owner: 'test', bytes: MESH_CORNER_SLOTS.length * 4 },
    { name: 'verts', owner: 'test', bytes: KCAP * F * 4 },
    { name: 'entity', owner: 'test', bytes: KCAP * 4 },
    { name: 'draw', owner: 'test', bytes: KDRAW * 4 },
    { name: 'span', owner: 'test', bytes: GEN_ROOM * 8 },
    { name: 'gen', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'last', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'uvGen', owner: 'test', bytes: GEN_ROOM * 4 },
    { name: 'lastUv', owner: 'test', bytes: GEN_ROOM * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(buffer, KV, KI, KE, width);
  const g = MeshGeometry;
  const geom = {
    vertOffset: g.vertOffset, vertCount: g.vertCount, indexOffset: g.indexOffset, indexCount: g.indexCount,
    vertexX: g.vertexX, vertexY: g.vertexY, uvU: g.uvU, uvV: g.uvV, indices: g.indices,
  };
  const b = await bindMeshCorners(memory, R.table.byte, geom);
  const verts = new Float32Array(buffer, R.verts.byte, KCAP * F);
  return {
    b,
    geom,
    wide: width === 32,
    t: {
      verts,
      vertsU32: words(verts),
      vertexEntity: new Uint32Array(buffer, R.entity.byte, KCAP),
      indices: new Uint32Array(buffer, R.draw.byte, KDRAW),
      indexSpan: new Uint32Array(buffer, R.span.byte, GEN_ROOM * 2),
    },
    corners: [words(g.vertexX), words(g.vertexY), words(g.uvU), words(g.uvV)],
    vertGen: g.vertGen,
    uvGenLive: g.uvGen,
    gen: new Uint32Array(buffer, R.gen.byte, GEN_ROOM),
    last: new Uint32Array(buffer, R.last.byte, GEN_ROOM),
    uvGen: new Uint32Array(buffer, R.uvGen.byte, GEN_ROOM),
    lastUv: new Uint32Array(buffer, R.lastUv.byte, GEN_ROOM),
  };
}

const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);
function cornerBits(r) {
  if (r() < 0.06) return SPECIAL[Math.floor(r() * SPECIAL.length)];
  f32[0] = (r() - 0.5) * 400;
  return f32Bits[0];
}

/**
 * One frame, written straight into the columns: the meshes (mode 1 tears vertex spans past the column, mode 2 index
 * spans, mode 3 puts indices past the mesh, mode 4 makes runs a record short or long and meshes under 3 vertices, mode 5
 * spans of another triangle count, mode 6 ids past the columns and a span table short of them), the records' entities
 * and spans, the generations. Returns the call's arguments.
 */
function kernelFrame(r, s, k) {
  const mode = k % 8;
  const g = s.geom;
  for (const w of s.corners) for (let q = 0; q < KV; q++) w[q] = cornerBits(r);
  const tris = new Int32Array(KE);
  let vAt = 0;
  let iAt = 0;
  for (let e = 0; e < KE; e++) {
    const kind = r();
    g.indexCount[e] = Math.floor(r() * 4294967296);
    if (kind < 0.1) {
      g.vertOffset[e] = -1 - Math.floor(r() * 3);
      g.vertCount[e] = Math.floor(r() * 9);
      g.indexOffset[e] = r() < 0.5 ? -1 : Math.floor(r() * KI);
      continue;
    }
    let vN = 3 + Math.floor(r() * 14);
    if (mode === 4 && r() < 0.2) vN = Math.floor(r() * 3);
    if (vAt + vN > KV) vAt = 0;
    let vOff = vAt;
    vAt += vN;
    if (mode === 1 && r() < 0.3) vOff = r() < 0.7 ? KV - vN + 1 + Math.floor(r() * vN) : KV + Math.floor(r() * 64);
    g.vertOffset[e] = vOff;
    g.vertCount[e] = vN;
    if (s.wide && mode === 4 && r() < 0.1) g.vertCount[e] = (0x80000000 + Math.floor(r() * 1000)) >>> 0;
    if (kind < 0.45) {
      g.indexOffset[e] = -1 - Math.floor(r() * 4);
      tris[e] = vN >= 3 ? vN - 2 : 0;
      continue;
    }
    const nt = r() < 0.04 ? 0 : 1 + Math.floor(r() * 9);
    const count = nt * 3 + (r() < 0.1 ? 1 + Math.floor(r() * 2) : 0);
    if (iAt + count > KI) iAt = 0;
    let at = iAt;
    iAt += count;
    for (let q = 0; q < count; q++) g.indices[at + q] = Math.floor(r() * Math.max(1, vN));
    if (mode === 3 && count >= 3 && r() < 0.3) {
      g.indices[at + Math.floor(r() * count)] = r() < 0.7 ? vN + Math.floor(r() * 3) : s.wide ? WIDE_BAD[Math.floor(r() * WIDE_BAD.length)] : 65535;
    }
    if (mode === 2 && count >= 3 && r() < 0.35) {
      at = r() < 0.7 ? KI - count + 1 + Math.floor(r() * count) : KI + Math.floor(r() * 16);
      for (let q = at; q < KI && q < at + count; q++) g.indices[q] = Math.floor(r() * Math.max(1, vN));
    }
    g.indexOffset[e] = at;
    g.indexCount[e] = count;
    tris[e] = nt;
  }
  // The records: a run of each entity's vertex count, and its span (its triangles' indices, where the draw has room).
  const ent = s.t.vertexEntity;
  const span = s.t.indexSpan;
  for (let q = 0; q < span.length; q++) span[q] = Math.floor(r() * 4294967296);
  const target = 40 + Math.floor(r() * (KCAP - 40));
  let n = 0;
  let drawAt = 0;
  let prev = -1;
  while (n < target) {
    let id = Math.floor(r() * KE);
    const p = r();
    if (mode === 6 && p < 0.1) id = KE + Math.floor(r() * 8);
    else if (mode === 6 && p < 0.2) id = (0x80000000 + Math.floor(r() * 1000)) >>> 0;
    else if (id === prev) id = (id + 1) % KE;
    const vN = id < KE ? g.vertCount[id] : 0;
    let len = id < KE && vN >= 1 && vN < 64 ? vN : 1 + Math.floor(r() * 4);
    if (mode === 4 && r() < 0.08) len = Math.max(1, len + (r() < 0.5 ? 1 : -1));
    if (n + len > KCAP) break;
    ent.fill(id, n, n + len);
    if (id < GEN_ROOM) {
      let count = id < KE ? tris[id] * 3 : 3;
      if (drawAt + count > KDRAW) drawAt = 0;
      span[id * 2] = drawAt;
      if (mode === 5 && r() < 0.3) count += r() < 0.5 ? 3 : -3;
      span[id * 2 + 1] = count >>> 0;
      drawAt += Math.max(0, count);
    }
    n += len;
    prev = id;
  }
  for (let q = 0; q < GEN_ROOM; q++) s.gen[q] = r() < 0.1 ? 0 : Math.floor(r() * 4294967296);
  for (let q = 0; q < GEN_ROOM; q++) s.last[q] = r() < 0.6 ? (s.gen[q] ^ (1 + Math.floor(r() * 0xffff))) >>> 0 : s.gen[q];
  for (let q = 0; q < GEN_ROOM; q++) s.uvGen[q] = r() < 0.1 ? 0 : Math.floor(r() * 4294967296);
  for (let q = 0; q < GEN_ROOM; q++) s.lastUv[q] = r() < 0.4 ? (s.uvGen[q] ^ (1 + Math.floor(r() * 0xffff))) >>> 0 : s.uvGen[q];
  for (let q = 0; q < KE; q++) {
    s.vertGen[q] = s.gen[q];
    s.uvGenLive[q] = s.uvGen[q];
  }
  const genLen = mode === 6 || r() < 0.1 ? KE + 8 : KE;
  const lastLen = mode === 6 && r() < 0.5 ? KE - 6 : genLen;
  const views = {
    meshVertOffset: g.vertOffset, meshVertCount: g.vertCount, meshIndexOffset: g.indexOffset, meshIndexCount: g.indexCount,
    meshVertexX: g.vertexX, meshVertexY: g.vertexY, meshUvU: g.uvU, meshUvV: g.uvV, meshIndices: g.indices,
    meshVertGen: s.vertGen, meshUvGen: s.uvGenLive,
  };
  let genNow = s.gen.subarray(0, genLen);
  if (r() < 0.1) genNow = null;
  let lastUvGen = s.lastUv.subarray(0, mode === 6 && r() < 0.5 ? KE - 6 : KE + 8);
  let uvGenNow = s.uvGen.subarray(0, mode === 6 || r() < 0.1 ? KE + 8 : KE);
  const uvMode = r();
  if (uvMode < 0.25) {
    lastUvGen = null;
    uvGenNow = null;
  } else if (uvMode < 0.4) {
    uvGenNow = null;
  }
  // The span table covers every entity, or (mode 6) fewer than the columns.
  const spanEntities = mode === 6 && r() < 0.5 ? KE - 10 : GEN_ROOM;
  const t = { ...s.t, indexSpan: s.t.indexSpan.subarray(0, spanEntities * 2) };
  return { mode, n, t, views, last: s.last.subarray(0, lastLen), genNow, lastUvGen, uvGenNow };
}

for (const width of [16, 32]) {
  test(`rewrite_verts${width === 32 ? '_u32' : ''} writes what rewriteMeshUvVerts writes, frame after frame`, async () => {
    const s = await kernelSetup(width);
    assert.equal(s.b.indexWidth, width);
    const r = rng(width === 32 ? 0xe4532 : 0xe453);
    const codes = { 0: 0, 1: 0, '-1': 0 };
    let written = 0;
    let indexRuns = 0;
    const recordWords = words(s.t.verts);
    const drawWords = s.t.indices;
    const patternV = new Uint32Array(recordWords.length);
    const patternI = new Uint32Array(drawWords.length);
    for (let k = 0; k < 900; k++) {
      const { mode, n, t, views, last, genNow, lastUvGen, uvGenNow } = kernelFrame(r, s, k);
      for (let q = 0; q < patternV.length; q++) patternV[q] = Math.floor(r() * 4294967296);
      for (let q = 0; q < patternI.length; q++) patternI[q] = Math.floor(r() * 4294967296);
      recordWords.set(patternV);
      drawWords.set(patternI);
      const js = rewriteMeshUvVerts(t, n, views, last, genNow, lastUvGen, uvGenNow);
      const jsRecords = recordWords.slice();
      const jsDraw = drawWords.slice();
      recordWords.set(patternV);
      drawWords.set(patternI);
      const code = rewriteVertsWasm(s.b, t, n, views, last, genNow, lastUvGen, uvGenNow);
      assert.equal(code, js.result, `frame ${k} (mode ${mode}, ${n} records): return code`);
      const atV = firstDiff(recordWords, jsRecords);
      assert.equal(atV, -1, `frame ${k} (mode ${mode}): record ${Math.floor(atV / F)}, float ${atV % F}: kernel 0x${(recordWords[atV] >>> 0).toString(16)}, JS 0x${(jsRecords[atV] >>> 0).toString(16)}`);
      const atI = firstDiff(drawWords, jsDraw);
      assert.equal(atI, -1, `frame ${k} (mode ${mode}): index ${atI}: kernel ${drawWords[atI]}, JS ${jsDraw[atI]}`);
      if (code > 0) {
        assert.deepEqual(
          [rewrittenFirstRow(s.b), rewrittenPastRow(s.b), rewrittenFirstIndex(s.b), rewrittenPastIndex(s.b)],
          [js.firstRow, js.pastRow, js.firstIndex, js.pastIndex],
          `frame ${k}: the ranges written`,
        );
        written += Math.max(0, js.pastRow - js.firstRow);
        if (js.pastIndex > js.firstIndex) indexRuns++;
      }
      codes[code]++;
    }
    assert.ok(codes[1] > 150 && codes[-1] > 100, `codes ${JSON.stringify(codes)}`);
    assert.ok(written > 20000 && indexRuns > 100, `${written} records, ${indexRuns} calls that wrote indices`);
  });
}
