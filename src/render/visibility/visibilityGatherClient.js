// The WASM visibility gather (E-76 W2b): loads visibilityGather.wasm onto the render-queue memory (Phase 4: Box2D's
// block), where the scene keeps every column one light's neighbour walk reads (Transform, Collider, LightOccluder,
// RigidBody and the published poses, Grid's neighbour rows) and pre-render's visibility regions it packs into
// (visibilityMemory.js, placed there). gather_light does _buildVisibilityPolygonsSwept's neighbour loop for one
// light; the compound solids and the self-lit candidates come back as event records, in neighbour order, for the
// JS (the W1 raster and the self-lit list).

import { loadWasmKernel } from '../../util/wasmKernel.js';
import { GATHER_EVENT_BYTES, GATHER_TABLE_SLOTS } from '../../util/wasmMemoryMap.js';
import { ShapeType } from '../../box2d/box2dConstants.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./visibilityGather.wasm', import.meta.url);

/** wasm/visibilityGather.c's column table, slot for slot. */
export const GATHER_SLOTS = [
  'nRows', 'nStride',
  'tActive', 'tX', 'tY', 'tRotC', 'tRotS',
  'oActive', 'oBlock',
  'cActive', 'cShape', 'cRadius', 'cWidth', 'cHeight', 'cOffX', 'cOffY', 'cPolyCount', 'cPolyX', 'cPolyY',
  'cCentroidX', 'cCentroidY', 'cFixtures',
  'fHeads',
  'bActive', 'pX', 'pY', 'pRotC', 'pRotS', 'qX', 'qY', 'qRotC', 'qRotS', 'bInterpolate',
  'vKind', 'vCx', 'vCy', 'vCr', 'vVertStart', 'vVertCount', 'vVertsX', 'vVertsY', 'vMaxOccluders',
  'eEvents', 'eSelfLit', 'results',
];
if (GATHER_SLOTS.length > GATHER_TABLE_SLOTS) throw new Error('visibilityGather: the column table outgrew its region');
const SLOT = Object.fromEntries(GATHER_SLOTS.map((name, k) => [name, k]));

// The kernel's shape codes (visibilityGather.c) are ShapeType's.
if (ShapeType.Box !== 0 || ShapeType.Circle !== 1 || ShapeType.Polygon !== 2 || ShapeType.Chain !== 3) {
  throw new Error('visibilityGather: ShapeType changed; wasm/visibilityGather.c holds the old codes');
}

/** Event kinds: an occluder packed while the self-lit list is on, a compound solid in reach. */
export const GATHER_EV_OCCLUDER = 0;
export const GATHER_EV_SOLID = 1;
/** An event record in i32 words and in doubles (the pose starts at double 2). */
export const GATHER_EVENT_I32 = GATHER_EVENT_BYTES >> 2;
export const GATHER_EVENT_F64 = GATHER_EVENT_BYTES >> 3;

/**
 * Bind the kernel to the render-queue memory: the gather's regions there (renderQueueMemoryRegions' collect
 * visibility part) and the visibility memory placed in it (createVisibilityMemory's place), whose scratch it fills.
 * @param {WebAssembly.Memory} memory
 * @param {{ tableByte: number, resultsByte: number, eventsByte: number, events: number }} v
 * @param {{ layout: Record<string, number> }} vm
 */
export async function bindVisibilityGather(memory, v, vm) {
  const k = await loadWasmKernel('visibilityGather', wasmUrl, memory, ['gather_light', 'gather_light_u32']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, v.tableByte, GATHER_SLOTS.length);
  table.fill(0);
  const L = vm.layout;
  table[SLOT.vKind] = L.kindByte;
  table[SLOT.vCx] = L.cxByte;
  table[SLOT.vCy] = L.cyByte;
  table[SLOT.vCr] = L.crByte;
  table[SLOT.vVertStart] = L.vertStartByte;
  table[SLOT.vVertCount] = L.vertCountByte;
  table[SLOT.vVertsX] = L.vertsXByte;
  table[SLOT.vVertsY] = L.vertsYByte;
  table[SLOT.vMaxOccluders] = L.maxOccluders;
  table[SLOT.eEvents] = v.eventsByte;
  table[SLOT.results] = v.resultsByte;
  return {
    buffer,
    gather16: k.gather_light,
    gather32: k.gather_light_u32,
    /** gather_light(tableByte, light, lx, ly, radius, alpha): the occluders packed. The export for the rows' width. */
    gather: k.gather_light,
    table,
    tableByte: v.tableByte,
    /** [0] occluders, [1] vertices, [2] events, [3] 1 when the occluder cap stopped the walk. */
    results: new Int32Array(buffer, v.resultsByte, 4),
    eventsI32: new Int32Array(buffer, v.eventsByte, v.events * GATHER_EVENT_I32),
    eventsF64: new Float64Array(buffer, v.eventsByte, v.events * GATHER_EVENT_F64),
    events: v.events,
  };
}

/**
 * The column table for this frame (the published pose generations move each frame) and b.gather for the
 * neighbour rows' width. False when a column the gather reads is not in the memory, or a row could hold more
 * neighbours than the event records: the JS gather runs instead.
 */
export function writeGatherColumns(b, worker, Grid, Transform, Collider, LightOccluder, ColliderFixture, selfLit) {
  const t = b.table;
  const buffer = b.buffer;
  let ok = true;
  // A column the scene has must be in the memory; one it lacks is 0, which the kernel reads as absent.
  const put = (slot, a, required) => {
    if (!a) {
      t[SLOT[slot]] = 0;
      if (required) ok = false;
    } else if (a.buffer === buffer) {
      t[SLOT[slot]] = a.byteOffset;
    } else {
      ok = false;
    }
  };
  const rows = Grid.neighborData;
  const stride = Grid._stride | 0;
  put('nRows', rows, true);
  if (!(stride > 0) || stride - 1 > b.events) ok = false;
  t[SLOT.nStride] = stride;
  b.gather = rows instanceof Uint32Array ? b.gather32 : b.gather16;
  put('tActive', Transform.active, true);
  put('tX', Transform.x, true);
  put('tY', Transform.y, true);
  put('tRotC', Transform.rotC, false);
  put('tRotS', Transform.rotS, false);
  put('oActive', LightOccluder.active, true);
  put('oBlock', LightOccluder.block, false);
  put('cActive', Collider.active, true);
  put('cShape', Collider.shapeType, true);
  put('cRadius', Collider.radius, true);
  put('cWidth', Collider.width, true);
  put('cHeight', Collider.height, true);
  put('cOffX', Collider.offsetX, true);
  put('cOffY', Collider.offsetY, true);
  put('cPolyCount', Collider.polyCount, true);
  put('cPolyX', Collider.polyVertexX, true);
  put('cPolyY', Collider.polyVertexY, true);
  put('cCentroidX', Collider.polyCentroidX, false);
  put('cCentroidY', Collider.polyCentroidY, false);
  // The fixture counts and the pool's head list's length: the JS takes a collider for a compound solid only
  // with both; the kernel reads the counts, and the heads only for their length.
  const heads = ColliderFixture.head;
  put('cFixtures', heads ? Collider.fixtureCount : null, false);
  t[SLOT.fHeads] = heads ? heads.length : 0;
  const bodies = worker._poseX && worker._rbActive ? worker._rbActive : null;
  const live = bodies !== null;
  put('bActive', bodies, false);
  put('pX', live ? worker._poseX : null, live);
  put('pY', live ? worker._poseY : null, live);
  put('pRotC', live ? worker._poseRotC : null, live);
  put('pRotS', live ? worker._poseRotS : null, live);
  // The generation before it: none until the second publish (0, and the kernel does not interpolate).
  const prev = live && Boolean(worker._prevPoseX);
  put('qX', prev ? worker._prevPoseX : null, false);
  put('qY', prev ? worker._prevPoseY : null, prev);
  put('qRotC', prev ? worker._prevPoseRotC : null, prev);
  put('qRotS', prev ? worker._prevPoseRotS : null, prev);
  t[SLOT.bInterpolate] = worker.interpolatePhysicsPose ? 1 : 0;
  t[SLOT.eSelfLit] = selfLit ? 1 : 0;
  return ok;
}
