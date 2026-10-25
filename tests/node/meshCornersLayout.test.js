// E-76 W11: what wasm/meshCorners.c hard-codes, tied to the JS layout it stands for. The kernel stores a row's
// corners as three x, y pairs from float 0 and, on the UV batch, three u, v pairs from float R_UV0; it stores
// NAN_BITS where the JS stores undefined; it reads its arguments from a table whose slots its enum names and the
// client fills by MESH_CORNER_SLOTS; and it takes a UV generation slot of 0 as "none". The mesh memory sizes the
// batches' rows with MESH_FILL_ROW_BYTES and MESH_UV_ROW_BYTES, which wasmMemoryMap.js keeps as numbers of its
// own because colliderFillBatch.js loads Pixi and the main thread does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MeshGeometry } from '../../src/core/meshGeometry.js';
import {
  COLLIDER_FILL_FLOATS,
  COLLIDER_FILL_STRIDE,
  FILL_ROW,
  MESH_UV_FILL_FLOATS,
  MESH_UV_FILL_STRIDE,
} from '../../src/render/colliderFillBatch.js';
import { bindMeshCorners, MESH_CORNER_SLOTS, rewriteCornersWasm } from '../../src/render/meshCornersClient.js';
import {
  layoutRegions,
  MESH_CORNER_TABLE_SLOTS,
  MESH_FILL_ROW_BYTES,
  MESH_UV_ROW_BYTES,
  meshMemoryRegions,
} from '../../src/util/wasmMemoryMap.js';

const C = fs.readFileSync(new URL('../../wasm/meshCorners.c', import.meta.url), 'utf8');

/** The value of `#define name <number>[u]` in the C. */
function define(name) {
  const m = C.match(new RegExp(`^#define ${name} (0x[0-9a-fA-F]+|\\d+)u?\\b`, 'm'));
  assert.ok(m, `wasm/meshCorners.c defines ${name} as a number`);
  return Number(m[1]);
}

/** The C's table enum, T_UV_ON as 'uvOn', in order, without SLOT_COUNT. */
function enumSlots() {
  const m = C.match(/enum\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'wasm/meshCorners.c has its slot enum');
  const names = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(names.pop(), 'SLOT_COUNT', 'the enum ends with SLOT_COUNT');
  // The C's short names for the MeshGeometry columns.
  const column = { vx: 'vertexX', vy: 'vertexY', u: 'uvU', v: 'uvV' };
  return names.map((n) => {
    assert.match(n, /^T_[A-Z_]+$/, `slot ${n}`);
    const camel = n
      .slice(2)
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return column[camel] || camel;
  });
}

test('the kernel stores the corners at the floats the rows keep them in', () => {
  // row[0..2] at out + base: corners 0, 1 and 2 as x, y pairs from float 0.
  assert.equal(FILL_ROW.V0, 0);
  assert.equal(FILL_ROW.V1, 2);
  assert.equal(FILL_ROW.V2, 4);
  // uv[0..2] at out + base + R_UV0.
  const uv0 = define('R_UV0');
  assert.equal(uv0, FILL_ROW.UV0, 'R_UV0 is FILL_ROW.UV0');
  assert.equal(FILL_ROW.UV1, uv0 + 2);
  assert.equal(FILL_ROW.UV2, uv0 + 4);
  // The client's bound check: the last word a call stores is float 5 of a fill row, the last of a UV row.
  assert.equal(FILL_ROW.V2 + 2, 6);
  assert.ok(COLLIDER_FILL_FLOATS >= 6);
  assert.equal(MESH_UV_FILL_FLOATS, FILL_ROW.UV2 + 2);
});

test('the kernel stores undefined as the JS does', () => {
  const f = new Float32Array(1);
  f[0] = undefined;
  assert.equal(new Uint32Array(f.buffer)[0], define('NAN_BITS'));
});

test('the mesh memory sizes the rows as the batches do', () => {
  assert.equal(MESH_FILL_ROW_BYTES, COLLIDER_FILL_STRIDE);
  assert.equal(MESH_UV_ROW_BYTES, MESH_UV_FILL_STRIDE);
  const geometryBytes = MeshGeometry.getBufferSize(256, 768, 40);
  const { regions } = meshMemoryRegions(geometryBytes, 40, [{ fillRows: 70, uvRows: 33 }, { fillRows: 5, uvRows: 0 }]);
  assert.equal(regions.meshFillRows0.bytes, 70 * COLLIDER_FILL_STRIDE);
  assert.equal(regions.meshUvRows0.bytes, 33 * MESH_UV_FILL_STRIDE);
  assert.equal(regions.meshFillRows1.bytes, 5 * COLLIDER_FILL_STRIDE);
  assert.equal(regions.meshUvRows1.bytes, 0);
  assert.equal(regions.meshCornerTable.bytes, MESH_CORNER_TABLE_SLOTS * 4);
  // A UV generation slot of 0 means none: MeshGeometry holds byte 0, and no generation array starts there.
  assert.equal(regions.meshGeometry.byte, 0);
  for (const k of [0, 1]) {
    assert.ok(regions[`meshLastUvGen${k}`].byte > 0);
    assert.ok(regions[`meshFrameUvGen${k}`].byte > 0);
  }
});

test('the table slots are the C enum, in order', () => {
  assert.deepEqual(MESH_CORNER_SLOTS, enumSlots());
  assert.ok(MESH_CORNER_SLOTS.length <= MESH_CORNER_TABLE_SLOTS, 'the table fits its region');
});

test('the client writes each slot the value its name says', async () => {
  const E = 8;
  const V = 64;
  const I = 96;
  const layout = layoutRegions([
    { name: 'meshGeometry', owner: 'test', bytes: MeshGeometry.getBufferSize(V, I, E) },
    { name: 'rows', owner: 'test', bytes: 4 * MESH_UV_FILL_STRIDE },
    { name: 'entity', owner: 'test', bytes: 4 * 4 },
    { name: 'gen', owner: 'test', bytes: E * 4 },
    { name: 'last', owner: 'test', bytes: (E + 2) * 4 },
    { name: 'uvGen', owner: 'test', bytes: (E + 1) * 4 },
    { name: 'lastUv', owner: 'test', bytes: (E + 3) * 4 },
    { name: 'table', owner: 'test', bytes: MESH_CORNER_TABLE_SLOTS * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(buffer, V, I, E);
  const g = MeshGeometry;
  assert.ok(g.uvGen.byteOffset > 0, 'MeshGeometry.uvGen does not start at byte 0');
  const geom = {
    vertOffset: g.vertOffset, vertCount: g.vertCount, indexOffset: g.indexOffset, indexCount: g.indexCount,
    vertexX: g.vertexX, vertexY: g.vertexY, uvU: g.uvU, uvV: g.uvV, indices: g.indices,
  };
  const b = await bindMeshCorners(memory, R.table.byte, geom);
  const slot = (name) => b.table[MESH_CORNER_SLOTS.indexOf(name)];
  for (const name of Object.keys(geom)) assert.equal(slot(name), geom[name].byteOffset, `${name}`);
  assert.equal(slot('geomN'), E);
  assert.equal(slot('vertCap'), V);
  assert.equal(slot('indexCap'), I);

  const out = new Float32Array(buffer, R.rows.byte, 4 * MESH_UV_FILL_FLOATS);
  const entity = new Uint32Array(buffer, R.entity.byte, 4);
  const gen = new Uint32Array(buffer, R.gen.byte, E);
  const last = new Uint32Array(buffer, R.last.byte, E + 2);
  const uvGen = new Uint32Array(buffer, R.uvGen.byte, E + 1);
  const lastUv = new Uint32Array(buffer, R.lastUv.byte, E + 3);
  const views = {
    meshVertOffset: g.vertOffset, meshVertCount: g.vertCount, meshIndexOffset: g.indexOffset, meshIndexCount: g.indexCount,
    meshVertexX: g.vertexX, meshVertexY: g.vertexY, meshUvU: g.uvU, meshUvV: g.uvV, meshIndices: g.indices,
    meshVertGen: g.vertGen, meshUvGen: g.uvGen,
  };
  // Nothing moved: the kernel walks the runs and writes no row.
  assert.equal(rewriteCornersWasm(b, out, 3, entity, views, MESH_UV_FILL_FLOATS, last, gen, lastUv, uvGen), 1);
  assert.equal(b.calls, 1);
  assert.equal(slot('out'), out.byteOffset);
  assert.equal(slot('count'), 3);
  assert.equal(slot('step'), MESH_UV_FILL_FLOATS);
  assert.equal(slot('uvOn'), 1);
  assert.equal(slot('entity'), entity.byteOffset);
  assert.equal(slot('gen'), gen.byteOffset);
  assert.equal(slot('genLen'), E);
  assert.equal(slot('last'), last.byteOffset);
  assert.equal(slot('lastLen'), E + 2);
  assert.equal(slot('uvGen'), uvGen.byteOffset);
  assert.equal(slot('uvGenLen'), E + 1);
  assert.equal(slot('lastUv'), lastUv.byteOffset);
  assert.equal(slot('lastUvLen'), E + 3);

  // The fill batch: no UV corners, no UV generations.
  assert.equal(rewriteCornersWasm(b, out, 2, entity, views, COLLIDER_FILL_FLOATS, last, gen), 1);
  assert.equal(slot('step'), COLLIDER_FILL_FLOATS);
  assert.equal(slot('uvOn'), 0);
  for (const name of ['uvGen', 'uvGenLen', 'lastUv', 'lastUvLen']) assert.equal(slot(name), 0, `${name} none`);
});
