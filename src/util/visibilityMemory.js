// The visibility memory (E-76 W2a): pre-render's per-light visibility scratch in a WebAssembly.Memory of its
// own, where visibilitySweep.wasm reads it. Every region is worker-local: the occluders the light's gather
// packs, the polygon it gets back, the polar bins of compound solids (angularSweep.js views them there through
// bindPolarBins, so its raster and the kernel stamp and read the same bytes), the per-entity seen stamps of
// N-19, and the kernel's scratch and constant tables. Nothing else reads it, so it lives and dies with
// pre-render's initialize(); it is shared only because the kernels' import is (scripts/buildWasm.mjs links
// every module with --shared-memory, and a shared import does not link to an unshared memory).
//
// Sizes: the gather's caps (pre-render's 1024 occluders a light, MAX_POLYGON_VERTICES each), the polygon cap
// (lighting.maxPolygonVertices), angularSweep.js' own event, cache and active caps (SWEEP_CAPS: the kernel
// gives up where the JS does), the entity count (seen stamps). The per-light scratch is reused light after
// light, so lighting.maxLights does not size anything here.
//
// W1 adds solidSegments.wasm's context table and bin tables, and the compound solids' copies of their
// outline (solid.seg) and walk order (solid.chain), 20 bytes an edge. An outline edge is a fixture's edge
// seen once, so every solid together holds at most the fixture pool's vertices: physics.maxFixturePoolSize x
// MAX_POLYGON_VERTICES edges, and the region holds that many, so every outline fits (a scene whose memory would
// pass 2 GB gets no visibility memory). No fixture pool, no compound solid, no W1 regions.

import { POLAR_BINS, SWEEP_CAPS } from '../render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from './configDefaults.js';
import { NULL_GUARD_BYTES, alignToLine, layoutRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 32768 pages (2 GB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 32768;
/** visibilitySweep.c's table slots and result words (visibilitySweepClient.js names them). */
export const VISIBILITY_SWEEP_TABLE_SLOTS = 58;
export const VISIBILITY_SWEEP_RESULT_WORDS = 11;
/** Doubles at the sweep's consts region. */
const SWEEP_CONSTS = 3;
/** solidSegments.c's context table slots (solidSegmentsClient.js names them). */
export const SOLID_CTX_SLOTS = 8;
/** One outline edge's copy: four floats of solid.seg and its solid.chain entry. */
export const SOLID_EDGE_BYTES = 20;
/** The float cos/sin tables carry four entries past the last bin (four-lane loads at bin 511). */
const SOLID_F32_PAD = 4;

/** The gather's occluder cap a light (pre-render's _vpMaxOccluders), and its vertex pool at MAX_POLYGON_VERTICES each. */
export const VISIBILITY_MAX_OCCLUDERS = 1024;

/**
 * The visibility memory's options for a scene: the gather's caps, the polygon cap (lighting.maxPolygonVertices,
 * 128 when unset), the entity count and, with wasm.solidSegments, the fixture pool. The main thread sizes the
 * region in Box2D's block from these (W2b) and pre-render places the memory with the same.
 * @param {{ maxVerts: number, entities: number, fixtures: number }} scene
 */
export function visibilityMemoryOpts({ maxVerts, entities, fixtures }) {
  return {
    maxOccluders: VISIBILITY_MAX_OCCLUDERS,
    poolVerts: VISIBILITY_MAX_OCCLUDERS * MAX_POLYGON_VERTICES,
    maxVerts: maxVerts | 0,
    entities: entities | 0,
    fixtures: fixtures | 0,
  };
}

/** The solids region for a fixture pool: every outline edge it can make, capped. */
export function solidRegionBytes(fixtures) {
  const edges = Math.max(0, fixtures | 0) * MAX_POLYGON_VERTICES;
  return alignToLine(edges * SOLID_EDGE_BYTES);
}

/**
 * The visibility memory's regions, in order, each on a cache line.
 * @param {{ maxOccluders: number, poolVerts: number, maxVerts: number, entities: number, fixtures?: number }} opts
 *   fixtures: the fixture pool (ColliderFixture.maxCount); 0 leaves the compound raster's regions out
 */
export function visibilityMemoryRegions({ maxOccluders, poolVerts, maxVerts, entities, fixtures = 0 }) {
  const occ = Math.max(1, maxOccluders | 0);
  const pool = Math.max(4, poolVerts | 0);
  const out = Math.max(1, maxVerts | 0);
  const owners = Math.max(1, entities | 0);
  const solidBytes = solidRegionBytes(fixtures);
  const { maxEvents, occCache, maxActive, fullCircleSegs } = SWEEP_CAPS;
  const angles = POLAR_BINS * 2 + 1;
  const list = [{ name: 'guard', owner: 'nobody (address 0)', bytes: NULL_GUARD_BYTES }];
  const add = (name, bytes) => list.push({ name, owner: 'pre-render', bytes });
  add('table', VISIBILITY_SWEEP_TABLE_SLOTS * 4);
  add('results', VISIBILITY_SWEEP_RESULT_WORDS * 4);
  // The light's gather (pre-render's _vp* scratch) and its polygon.
  add('kind', occ);
  add('cx', occ * 4);
  add('cy', occ * 4);
  add('cr', occ * 4);
  add('vertStart', occ * 4);
  add('vertCount', occ);
  add('vertsX', pool * 4);
  add('vertsY', pool * 4);
  add('outX', out * 4);
  add('outY', out * 4);
  // The polar bins (angularSweep.js' _polarDist / _polarOwner) and the seen stamps (_selfLitSeen).
  add('polarDist', POLAR_BINS * 4);
  add('polarOwner', POLAR_BINS * 4);
  add('ownerSeen', owners * 4);
  // The sweep's scratch.
  add('evKey', maxEvents * 8);
  add('evC', maxEvents * 8);
  add('evS', maxEvents * 8);
  add('evOcc', maxEvents * 4);
  add('evType', maxEvents);
  add('sort', maxEvents * 4);
  add('occOpen', occCache * 8);
  add('occClose', occCache * 8);
  add('occValid', occCache);
  add('seen', occCache * 4);
  add('active', maxActive * 4);
  add('rayAng', POLAR_BINS * 8);
  add('rayCos', POLAR_BINS * 8);
  add('raySin', POLAR_BINS * 8);
  add('rayBest', POLAR_BINS * 8);
  for (const name of ['edgeFx', 'edgeFy', 'edgeEx', 'edgeEy', 'edgeTn']) add(name, pool * 8);
  for (const name of ['edge32Fx', 'edge32Fy', 'edge32Ex', 'edge32Ey', 'edge32Tn']) add(name, pool * 4);
  for (const name of ['circDx', 'circDy', 'circDd', 'circR2']) add(name, occ * 8);
  add('occF32', occ);
  // angularSweep.js' constant tables (copySweepTables).
  add('consts', SWEEP_CONSTS * 8);
  add('fullC', fullCircleSegs * 8);
  add('fullS', fullCircleSegs * 8);
  add('polarCos', angles * 8);
  add('polarSin', angles * 8);
  add('polarPseudo', angles * 8);
  if (solidBytes > 0) {
    // W1: the compound raster's context, its active word, its bin tables, the solids' copies.
    add('solidCtx', SOLID_CTX_SLOTS * 4);
    add('solidActive', 4);
    add('solidCos', POLAR_BINS * 8);
    add('solidSin', POLAR_BINS * 8);
    add('solidCosF', (POLAR_BINS + SOLID_F32_PAD) * 4);
    add('solidSinF', (POLAR_BINS + SOLID_F32_PAD) * 4);
    add('solidTan', 65 * 8);
    add('solids', solidBytes);
  }
  const map = layoutRegions(list);
  return { ...map, sizes: { occ, pool, out, owners, solidBytes } };
}

/** The bytes the visibility regions take, laid in another memory (W2b: Box2D's block). */
export function visibilityMemoryBytes(opts) {
  return visibilityMemoryRegions(opts).bytes;
}

/**
 * The memory, its layout and the JS views pre-render binds its scratch to. null when it would pass the
 * module's page limit or cannot be made (no SharedArrayBuffer): pre-render then sweeps in JS.
 * @param {{ maxOccluders: number, poolVerts: number, maxVerts: number, entities: number, fixtures?: number }} opts
 * @param {null | { memory: WebAssembly.Memory, baseByte: number }} [place] W2b: lay the regions in that memory
 *   from baseByte (64-aligned), where the gather kernel reads the components too, instead of a memory of their own
 */
export function createVisibilityMemory(opts, place = null) {
  const map = visibilityMemoryRegions(opts);
  const base = place ? place.baseByte | 0 : 0;
  let memory;
  if (place) {
    if ((base & 63) !== 0 || base + map.bytes > place.memory.buffer.byteLength) return null;
    memory = place.memory;
  } else {
    if (map.pages > WASM_MAX_PAGES) return null;
    try {
      memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
    } catch {
      return null;
    }
  }
  const buffer = memory.buffer;
  const r = map.regions;
  const { occ, pool, out, owners, solidBytes } = map.sizes;
  const view = (Ctor, name, n) => new Ctor(buffer, base + r[name].byte, n);
  const layout = { maxOccluders: occ, poolVerts: pool, maxVerts: out, entities: owners, solidBytes, baseByte: base };
  for (const [name, region] of Object.entries(r)) layout[`${name}Byte`] = base + region.byte;
  return {
    memory,
    buffer,
    // Plain numbers: byte offsets (<region>Byte) and the sizes.
    layout,
    views: {
      kind: view(Uint8Array, 'kind', occ),
      cx: view(Float32Array, 'cx', occ),
      cy: view(Float32Array, 'cy', occ),
      cr: view(Float32Array, 'cr', occ),
      vertStart: view(Int32Array, 'vertStart', occ),
      vertCount: view(Uint8Array, 'vertCount', occ),
      vertsX: view(Float32Array, 'vertsX', pool),
      vertsY: view(Float32Array, 'vertsY', pool),
      outX: view(Float32Array, 'outX', out),
      outY: view(Float32Array, 'outY', out),
      polarDist: view(Float32Array, 'polarDist', POLAR_BINS),
      polarOwner: view(Int32Array, 'polarOwner', POLAR_BINS),
      ownerSeen: view(Uint32Array, 'ownerSeen', owners),
    },
  };
}
