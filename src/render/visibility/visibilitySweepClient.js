// The WASM visibility sweep (E-76 W2a): loads visibilitySweep.wasm onto pre-render's visibility memory
// (src/util/visibilityMemory.js) and writes its table once. Pre-render's gather packs a light's occluders into
// the memory's regions (its _vp* scratch are views on them), calls the export once per light, and reads the
// polygon from the output regions; buildVisibilityPolygon, clipVisibilityToPolar and markSeenPolarOwners run
// inside the call (wasm/visibilitySweep.c). The polar bins are the memory's, bound into angularSweep.js
// (bindPolarBins), so the compound raster stamps what the kernel merges.

import { loadWasmKernel } from '../../util/wasmKernel.js';
import { VISIBILITY_SWEEP_RESULT_WORDS, VISIBILITY_SWEEP_TABLE_SLOTS } from '../../util/visibilityMemory.js';
import { POLAR_BINS, SWEEP_CAPS, copySweepTables } from './angularSweep.js';
import { engineWasmUrl } from '../../wasm/engine.js';


/** wasm/visibilitySweep.c's table, slot for slot. */
export const SWEEP_SLOTS = [
  'kind', 'cx', 'cy', 'cr', 'vertStart', 'vertCount', 'vertsX', 'vertsY',
  'outX', 'outY', 'maxVerts',
  'evKey', 'evC', 'evS', 'evOcc', 'evType', 'sort', 'maxEvents',
  'occOpen', 'occClose', 'occValid', 'seen', 'occCache',
  'active', 'maxActive',
  'consts', 'fullC', 'fullS', 'fullSegs',
  'polarDist', 'polarOwner', 'polarCos', 'polarSin', 'polarPseudo', 'polarBins',
  'rayAng', 'rayCos', 'raySin', 'rayBest',
  'ownerSeen', 'ownerSeenCap', 'ownerStamp',
  'edgeFx', 'edgeFy', 'edgeEx', 'edgeEy', 'edgeTn',
  'edge32Fx', 'edge32Fy', 'edge32Ex', 'edge32Ey', 'edge32Tn',
  'circDx', 'circDy', 'circDd', 'circR2',
  'occF32',
  'results',
];
if (SWEEP_SLOTS.length !== VISIBILITY_SWEEP_TABLE_SLOTS) throw new Error('visibilitySweep: the table and its region disagree');
/** wasm/visibilitySweep.c's result words. */
export const SWEEP_RESULTS = [
  'sweepCount', 'count', 'stamp', 'seenValid', 'eventOverflow', 'activeOverflow',
  'mergeCount', 'mergeGroup', 'mergeEdges', 'ownersMarked', 'events',
];
if (SWEEP_RESULTS.length !== VISIBILITY_SWEEP_RESULT_WORDS) throw new Error('visibilitySweep: the results and their region disagree');

/** Table slots pre-render writes per light. */
export const SWEEP_OWNER_SEEN = SWEEP_SLOTS.indexOf('ownerSeen');
export const SWEEP_OWNER_STAMP = SWEEP_SLOTS.indexOf('ownerStamp');
/** Result words pre-render reads after a call. */
export const SWEEP_R_STAMP = SWEEP_RESULTS.indexOf('stamp');
export const SWEEP_R_SEEN_VALID = SWEEP_RESULTS.indexOf('seenValid');
export const SWEEP_R_EVENT_OVERFLOW = SWEEP_RESULTS.indexOf('eventOverflow');
export const SWEEP_R_OWNERS_MARKED = SWEEP_RESULTS.indexOf('ownersMarked');

/** wasm.visibilitySweepF32 -> the export: float32 edge terms (Chrome's pick) or the double SIMD sweep. */
export const SWEEP_EXPORTS = Object.freeze({ f32: 'sweep_light_f32', simd: 'sweep_light_simd' });

/**
 * Bind the kernel to a visibility memory (createVisibilityMemory) and write its table and constant tables.
 * `maxVerts` is the polygon cap the light slots hold (lighting.maxPolygonVertices).
 * @param {{ memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }} vm
 * @param {{ maxVerts: number, f32?: boolean }} opts
 */
export async function bindVisibilitySweep(vm, { maxVerts, f32 = true }) {
  const variant = f32 ? 'f32' : 'simd';
  const exportName = SWEEP_EXPORTS[variant];
  const k = await loadWasmKernel('visibilitySweep', engineWasmUrl, vm.memory, [exportName]);
  const L = vm.layout;
  const buffer = vm.buffer;
  const { maxEvents, occCache, maxActive, fullCircleSegs } = SWEEP_CAPS;
  const angles = POLAR_BINS * 2 + 1;
  copySweepTables({
    consts: new Float64Array(buffer, L.constsByte, 3),
    fullC: new Float64Array(buffer, L.fullCByte, fullCircleSegs),
    fullS: new Float64Array(buffer, L.fullSByte, fullCircleSegs),
    polarCos: new Float64Array(buffer, L.polarCosByte, angles),
    polarSin: new Float64Array(buffer, L.polarSinByte, angles),
    polarPseudo: new Float64Array(buffer, L.polarPseudoByte, angles),
  });
  const words = {
    maxVerts: Math.min(maxVerts | 0, L.maxVerts),
    maxEvents,
    occCache,
    maxActive,
    fullSegs: fullCircleSegs,
    polarBins: POLAR_BINS,
    // Pre-render points this at the seen stamps for a light whose solids it must tell apart (N-19).
    ownerSeen: 0,
    ownerSeenCap: L.entities,
    ownerStamp: 0,
  };
  const table = new Uint32Array(buffer, L.tableByte, SWEEP_SLOTS.length);
  SWEEP_SLOTS.forEach((slot, i) => {
    const value = slot in words ? words[slot] : L[`${slot}Byte`];
    if (!(value >= 0)) throw new Error(`visibilitySweep: no region for ${slot}`);
    table[i] = value;
  });
  const results = new Uint32Array(buffer, L.resultsByte, SWEEP_RESULTS.length);
  results.fill(0);
  return {
    variant,
    /** sweep_light_*(tableByte, lightX, lightY, radius, occluders, polar): the polygon's vertex count. */
    sweep: k[exportName],
    table,
    tableByte: L.tableByte,
    results,
    resultsI32: new Int32Array(buffer, L.resultsByte, SWEEP_RESULTS.length),
    /** N-39: the occluders a vertex landed on carry results[stamp] (sweepSawOccluder). */
    seen: new Uint32Array(buffer, L.seenByte, occCache),
    occCache,
    ownerSeenByte: L.ownerSeenByte,
  };
}
