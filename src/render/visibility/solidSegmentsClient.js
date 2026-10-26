// The WASM compound-solid raster (E-76 W1): loads solidSegments.wasm onto pre-render's visibility memory
// (src/util/visibilityMemory.js), where the polar bins are (angularSweep.js binds them there: bindPolarBins),
// and rasters one (light, compound solid) pair per call as collectSolidSegments does (wasm/solidSegments.c).
//
// The kernel reads each solid's outline and walk order from the memory: a solid's solid.seg and solid.chain
// are copied into the solids region when it is first rastered and again only after ensureCompoundSolid
// rebuilt it (a new fixture revision), into the slot it had when the outline still fits. A solid that grew
// takes a new slot at the region's cursor; when the cursor reaches the end, every copy is dropped at once (the
// epoch moves on) and the solids copy themselves again as they are next rastered. A solid larger than the
// whole region rasters in JS on the same bins.
//
// Pre-render passes the doubles through SOLID_ARGS, not as arguments: a call TurboFan leaves out boxes every
// double it passes (E-85). collectSolidJs is the same call to the shipped JS, for wasm.solidSegments false.

import { loadWasmKernel } from '../../util/wasmKernel.js';
import { SOLID_CTX_SLOTS, SOLID_EDGE_BYTES } from '../../util/visibilityMemory.js';
import { POLAR_BINS, ensureSolidChain, markPolarBinsActive, polarCentreTables } from './angularSweep.js';
import { engineWasmUrl } from '../../wasm/engine.js';


/** wasm/solidSegments.c's context table, slot for slot. */
export const SOLID_CTX = ['dist', 'owner', 'active', 'cos', 'sin', 'cosF', 'sinF', 'tan'];
if (SOLID_CTX.length !== SOLID_CTX_SLOTS) throw new Error('solidSegments: the context table and its region disagree');
const F32_PAD = 4;

/**
 * collectSolidSegments' doubles, written by the caller before each call: the solid's pose (entity x, y, its
 * rotation's cos and sin, the collider offset) at 0..5, the light (x, y, radius squared) at 6..8.
 */
export const SOLID_ARGS = new Float64Array(9);

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F32 = new Float32Array(0);
// Every binding's copies are of its own memory: a new binding starts a new epoch.
let epochCounter = 0;

/** The bound kernel, one per worker (pre-render), every field set here. */
const S = {
  fn: null,
  ctxByte: 0,
  active: EMPTY_I32,
  f32: EMPTY_F32,
  i32: EMPTY_I32,
  regionByte: 0,
  regionEnd: 0,
  cursor: 0,
  epoch: -1,
  /** Copies made and region resets, for tests. */
  copies: 0,
  resets: 0,
  refused: 0,
  refusedWarned: false,
};

/**
 * Bind the kernel to a visibility memory made with a fixture pool (its solids region), whose polar bins
 * angularSweep.js uses. Returns the binding, or null when the memory has no solids region.
 * @param {{ memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }} vm
 */
export async function bindSolidSegments(vm) {
  const L = vm.layout;
  if (!(L.solidBytes > 0)) return null;
  const k = await loadWasmKernel('solidSegments', engineWasmUrl, vm.memory, ['collect_solid_f32x4']);
  const buffer = vm.buffer;
  // The bins' centre rays, from angularSweep.js' own tables (index 2b + 1), so the doubles are the JS's.
  const { cos, sin } = polarCentreTables();
  new Float64Array(buffer, L.solidCosByte, POLAR_BINS).set(cos);
  new Float64Array(buffer, L.solidSinByte, POLAR_BINS).set(sin);
  const cosF = new Float32Array(buffer, L.solidCosFByte, POLAR_BINS + F32_PAD);
  const sinF = new Float32Array(buffer, L.solidSinFByte, POLAR_BINS + F32_PAD);
  for (let i = 0; i < POLAR_BINS + F32_PAD; i++) {
    cosF[i] = cos[i % POLAR_BINS];
    sinF[i] = sin[i % POLAR_BINS];
  }
  const tan = new Float64Array(buffer, L.solidTanByte, 65);
  tan[0] = 0;
  for (let i = 1; i < 64; i++) tan[i] = Math.tan((i * Math.PI) / 256);
  tan[64] = 1;
  const ctx = new Uint32Array(buffer, L.solidCtxByte, SOLID_CTX.length);
  const at = {
    dist: L.polarDistByte, owner: L.polarOwnerByte, active: L.solidActiveByte, cos: L.solidCosByte,
    sin: L.solidSinByte, cosF: L.solidCosFByte, sinF: L.solidSinFByte, tan: L.solidTanByte,
  };
  SOLID_CTX.forEach((slot, i) => {
    ctx[i] = at[slot];
  });
  S.fn = k.collect_solid_f32x4;
  S.ctxByte = L.solidCtxByte;
  S.active = new Int32Array(buffer, L.solidActiveByte, 1);
  S.active[0] = 0;
  S.f32 = new Float32Array(buffer);
  S.i32 = new Int32Array(buffer);
  S.regionByte = L.solidsByte;
  S.regionEnd = L.solidsByte + L.solidBytes;
  S.cursor = L.solidsByte;
  S.epoch = ++epochCounter;
  S.copies = 0;
  S.resets = 0;
  S.refused = 0;
  S.refusedWarned = false;
  return S;
}

/** Drop the binding (a scene without it): collectSolidWasm is not called then. */
export function unbindSolidSegments() {
  S.fn = null;
  S.epoch = ++epochCounter;
}

/** The binding's counters since it was made: outline copies, region restarts, solids it could not raster. */
export function solidSegmentsStats() {
  return { bound: S.fn !== null, copies: S.copies, resets: S.resets, refused: S.refused };
}

/** A compound solid the kernel cannot raster: it casts no shadow, and pre-render says why once. */
function refuseSolid(reason) {
  S.refused++;
  if (S.refusedWarned) return;
  S.refusedWarned = true;
  console.error(`[PRE_RENDER] solidSegments.wasm cannot raster a compound solid (${reason}): it casts no shadow`);
}

/**
 * The solid's seg and chain in the solids region, copied if this epoch has no copy of this revision.
 * Returns false when the outline does not fit in the region at all.
 */
function placeSolid(solid) {
  if (solid.wasmEpoch === S.epoch && solid.wasmRevision === solid.revision && solid.chainValid) return true;
  ensureSolidChain(solid);
  const n = solid.segCount;
  if (n * SOLID_EDGE_BYTES > S.regionEnd - S.regionByte) return false;
  let segByte = solid.wasmSegByte;
  let cap = solid.wasmCap;
  if (solid.wasmEpoch !== S.epoch || n > cap) {
    // A new slot: the solid's outline grew, or this epoch has no slot for it.
    const bytes = (n * SOLID_EDGE_BYTES + 15) & ~15;
    if (S.cursor + bytes > S.regionEnd) {
      S.epoch = ++epochCounter;
      S.cursor = S.regionByte;
      S.resets++;
    }
    segByte = S.cursor;
    cap = n;
    S.cursor += bytes;
  }
  const chainByte = segByte + cap * 16;
  const f32 = S.f32;
  const seg = solid.seg;
  const s0 = segByte >> 2;
  for (let i = 0; i < n * 4; i++) f32[s0 + i] = seg[i];
  const i32 = S.i32;
  const chain = solid.chain;
  const c0 = chainByte >> 2;
  for (let i = 0; i < n; i++) i32[c0 + i] = chain[i];
  solid.wasmSegByte = segByte;
  solid.wasmChainByte = chainByte;
  solid.wasmCap = cap;
  solid.wasmRevision = solid.revision;
  solid.wasmEpoch = S.epoch;
  S.copies++;
  return true;
}

/**
 * The swept light loop's compound raster when the kernel is not bound: a scene with no fixture pool has no compound
 * solid, so none comes; one that does is refused. The JS raster it replaced is tests/reference/visibilitySweepJs.mjs.
 */
export function collectSolidRefused(solid) {
  if (!solid || solid.segCount <= 0) return 0;
  refuseSolid(`no binding, a solid of ${solid.segCount} edges`);
  return 0;
}

/**
 * collectSolidSegments on SOLID_ARGS through solidSegments.wasm: the same hit (> 0 as the JS's; the count
 * past the first may differ, as the walk order may), the same bins stamped, the bins marked active.
 */
export function collectSolidWasm(solid, owner) {
  if (!solid || solid.segCount <= 0) return 0;
  if (!placeSolid(solid)) {
    refuseSolid(`an outline of ${solid.segCount} edges is larger than the solids region`);
    return 0;
  }
  const a = SOLID_ARGS;
  const hit = S.fn(S.ctxByte, solid.wasmSegByte, solid.wasmChainByte, solid.segCount,
    a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], owner);
  const active = S.active;
  if (active[0] !== 0) {
    active[0] = 0;
    markPolarBinsActive();
  }
  return hit;
}
