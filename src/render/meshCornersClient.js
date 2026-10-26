// The WASM mesh corner rewrite (E-76 W11): loads meshCorners.wasm onto the mesh memory (meshMemory.js) and
// runs the corner rewrite there with the bits of the JS one it replaced (rewriteExplicitMeshCorners, now
// tests/reference/meshCorners.mjs), the UV generations
// (E-118) included. The memory starts with the MeshGeometry block, where logic workers write the meshes, and
// holds Pixi's mesh batches, their instance-to-entity lists and the generation copies as regions of their
// own, so the kernel reads and writes every array where it lives. It is the only rewrite (the JS one is
// tests/reference/meshCorners.mjs): a call it cannot take is an error, which only a wiring bug makes (an array
// outside the memory or of another type, MeshGeometry columns other than the bound ones, rows or an instance list
// shorter than the call).
// E-130: a 32-bit arena (renderer.maxMeshVerts past 65535) binds the kernel's rewrite_corners_u32 export, a
// 16-bit one rewrite_corners, by the class of the columns at bind time; the call path is the same.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { MESH_CORNER_TABLE_SLOTS } from '../util/wasmMemoryMap.js';
import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS } from './colliderFillBatch.js';
import { engineWasmUrl } from '../wasm/engine.js';


/** wasm/meshCorners.c's column table, slot for slot. */
export const MESH_CORNER_SLOTS = [
  'out', 'count', 'step', 'uvOn', 'entity', 'gen', 'genLen', 'last', 'lastLen',
  'vertOffset', 'vertCount', 'indexOffset', 'indexCount', 'geomN',
  'vertexX', 'vertexY', 'uvU', 'uvV', 'vertCap', 'indices', 'indexCap',
  'uvGen', 'uvGenLen', 'lastUv', 'lastUvLen',
];
if (MESH_CORNER_SLOTS.length > MESH_CORNER_TABLE_SLOTS) throw new Error('meshCorners: the column table outgrew its region');

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
const UV_GEN = 21;
const UV_GEN_LEN = 22;
const LAST_UV = 23;
const LAST_UV_LEN = 24;

/** The MeshGeometry columns the kernel reads, with the class each must have, in a 16-bit arena. */
const GEOMETRY_COLUMNS = {
  vertOffset: Int32Array,
  vertCount: Uint16Array,
  indexOffset: Int32Array,
  indexCount: Uint32Array,
  vertexX: Float32Array,
  vertexY: Float32Array,
  uvU: Float32Array,
  uvV: Float32Array,
  indices: Uint16Array,
};
/** E-130: in a 32-bit arena (renderer.maxMeshVerts past 65535), the vertex counts and indices are Uint32. */
const GEOMETRY_COLUMNS_U32 = { ...GEOMETRY_COLUMNS, vertCount: Uint32Array, indices: Uint32Array };
/** The kernel's export for each arena width: wasm/meshCorners.c rewrite_corners and rewrite_corners_u32. */
const REWRITE_EXPORT = 'rewrite_corners';
const REWRITE_EXPORT_U32 = 'rewrite_corners_u32';

/**
 * Bind the kernel to `memory`, the MeshGeometry columns in it (`geom`: the views MeshGeometry holds, by their
 * MeshGeometry names) and a table of MESH_CORNER_SLOTS u32 at `tableByte`. The columns' slots are written
 * once, and the export of the arena's width is chosen here, once (E-130): `indexWidth` on the binding says
 * which. Throws when a column is not where the kernel can read it.
 * @param {WebAssembly.Memory} memory
 * @param {number} tableByte
 * @param {Record<string, ArrayBufferView>} geom
 */
export async function bindMeshCorners(memory, tableByte, geom) {
  const buffer = memory.buffer;
  const wide = geom.indices instanceof Uint32Array;
  const columns = wide ? GEOMETRY_COLUMNS_U32 : GEOMETRY_COLUMNS;
  for (const [name, Ctor] of Object.entries(columns)) {
    const view = geom[name];
    if (!(view instanceof Ctor) || view.buffer !== buffer) throw new Error(`meshCorners: MeshGeometry.${name} is not a ${Ctor.name} in the memory`);
  }
  const e = geom.vertOffset.length;
  const v = geom.vertexX.length;
  if (geom.vertCount.length !== e || geom.indexOffset.length !== e || geom.indexCount.length !== e) throw new Error('meshCorners: entity columns of different lengths');
  if (geom.vertexY.length !== v || geom.uvU.length !== v || geom.uvV.length !== v) throw new Error('meshCorners: vertex columns of different lengths');
  const exportName = wide ? REWRITE_EXPORT_U32 : REWRITE_EXPORT;
  const rewrite = (await loadWasmKernel('meshCorners', engineWasmUrl, memory, [exportName]))[exportName];
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
  const bound = {};
  for (const name of Object.keys(columns)) bound[name] = geom[name];
  return { buffer, table, tableByte, rewrite, geom: bound, calls: 0, indexWidth: wide ? 32 : 16 };
}

/** A Uint32Array in the kernel's memory holding at least `n` values. */
function u32In(b, a, n) {
  return a instanceof Uint32Array && a.buffer === b.buffer && a.length >= n;
}

/**
 * rewriteExplicitMeshCorners(out, count, entityOfInstance, views, stride, lastVertGen, genNow, lastUvGen,
 * uvGenNow) through the kernel: same arguments, same result, same bits. `b.calls` counts the calls the kernel
 * ran; a call it cannot take throws.
 */
export function rewriteCornersWasm(b, out, count, entityOfInstance, views, stride, lastVertGen, genNow, lastUvGen, uvGenNow) {
  const n = count | 0;
  const gen = genNow || views.meshVertGen;
  // rewriteExplicitMeshCorners' own early return.
  if (!out || n <= 0 || !entityOfInstance || !gen || !lastVertGen) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : COLLIDER_FILL_FLOATS;
  const g = b.geom;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!views.meshUvU && !!views.meshUvV;
  // E-118: the UV generations as the JS picks them. Byte 0 is the MeshGeometry block, never a generation
  // array, so the table takes 0 as "none".
  const uvGen = uvOn && lastUvGen ? (uvGenNow || views.meshUvGen || null) : null;
  if (
    !(out instanceof Float32Array) || out.buffer !== b.buffer ||
    (n - 1) * step + (uvOn ? MESH_UV_FILL_FLOATS : 6) > out.length ||
    !u32In(b, entityOfInstance, n) || !u32In(b, gen, 0) || !u32In(b, lastVertGen, 0) ||
    views.meshVertOffset !== g.vertOffset || views.meshVertCount !== g.vertCount ||
    views.meshIndexOffset !== g.indexOffset || views.meshIndexCount !== g.indexCount ||
    views.meshVertexX !== g.vertexX || views.meshVertexY !== g.vertexY || views.meshIndices !== g.indices ||
    (uvOn && (views.meshUvU !== g.uvU || views.meshUvV !== g.uvV)) ||
    (uvGen !== null && (!u32In(b, uvGen, 0) || uvGen.byteOffset === 0 || !u32In(b, lastUvGen, 0)))
  ) {
    throw new Error(
      'meshCorners: a call the kernel cannot take (rows, instance list, generations or MeshGeometry columns that are ' +
        'not the ones bound in the mesh memory)',
    );
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
  if (uvGen !== null) {
    t[UV_GEN] = uvGen.byteOffset;
    t[UV_GEN_LEN] = uvGen.length;
    t[LAST_UV] = lastUvGen.byteOffset;
    t[LAST_UV_LEN] = lastUvGen.length;
  } else {
    t[UV_GEN] = 0;
    t[UV_GEN_LEN] = 0;
    t[LAST_UV] = 0;
    t[LAST_UV_LEN] = 0;
  }
  b.calls++;
  return b.rewrite(b.tableByte);
}
