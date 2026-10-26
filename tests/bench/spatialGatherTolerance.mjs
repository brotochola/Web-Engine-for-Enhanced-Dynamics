/**
 * The tolerance of a float32 candidate gather (wasm/test/spatialGatherF32.c) against the shipped double one
 * (WASM_HYPOTHESES "Open decisions" 5, Q5). Used by spatialGatherWasmMicrobench's float32 variants for their
 * checksum and by tests/node/spatialGatherF32.test.js.
 *
 * Every variant walks the same cells in the same order (the per-entity setup stays in double), so a row is
 * the same subsequence of the same walk except where the range test disagrees: a flip, a candidate only one
 * side keeps. Float32 and double disagree on dx * dx + dy * dy < er * er only when the two sides are within
 * about 10 float32 roundings (10 * 2^-24) of each other; the tolerance is EDGE_REL = 2^-20 relative on the
 * squared range (about 5e-7 relative, or 5e-5 px at a 100 px range, on the distance). A flip at the gather's
 * edge cannot change what is published in the frame (the publish tests the narrower visual range, in double,
 * W8a); it can only lose or add a candidate that lies on the edge.
 *
 * lockstepGather wraps a spatial worker's bound gather: each call runs the reference and the variant on the
 * same input (the dedup marks restored between them) and compares each rebuilt row:
 *   - a pair only one side has must be on the edge (within EDGE_REL);
 *   - the rest of the row in the same order; the same truncation flag; the same count of cells checked;
 *   - where a row is truncated (it hit maxNeighbors), an edge flip moves the cut, so the row may differ at its
 *     end by as many candidates as it has flips.
 * `keep: 'reference'` leaves the reference's rows, flags and marks and returns its cell count, so the worker
 * evolves as with the reference alone (the bench's checksum); `keep: 'variant'` lets the variant's stand.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadWasmKernel } from '../../src/util/wasmKernel.js';

export const EDGE_REL = 2 ** -20;
export const F32_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/spatialGatherF32.wasm'));
export const F32_EXPORTS = ['gather_batch_f32', 'gather_batch_f32x4'];

/** The float32 module's exports on `memory`. */
export function loadGatherF32(memory) {
  return loadWasmKernel('spatialGatherF32', F32_URL, memory, F32_EXPORTS);
}

/**
 * The lock step's tally: calls; rows compared and the reference's candidates in them (pairs); rows identical;
 * flips (in: only the variant keeps it, out: only the reference) and the worst one's relative gap; rows that
 * differ and hit maxNeighbors (truncatedRows) and the candidates their cut moved (truncationShifts); and the
 * differences out of the tolerance (unexplained), the first few described in problems.
 */
export function newGatherStats() {
  return {
    calls: 0, rows: 0, pairs: 0, identicalRows: 0, flips: 0, flipsIn: 0, flipsOut: 0, worstRelGap: 0,
    truncatedRows: 0, truncationShifts: 0, unexplained: 0, problems: [],
  };
}

const ARG = { rebuilds: 0, rebuildByte: 1, posByte: 2, rangeByte: 3, candByte: 4, maxNeighbors: 5, skinFrac: 13, truncatedByte: 19 };

/**
 * @param {object} worker a SpatialWorker with its WASM gather bound (_wasmGather)
 * @param {{ reference?: Function, variant: Function, keep?: 'reference' | 'variant', stats: object, strict?: boolean }} opts
 *   reference: the shipped gather_batch by default; strict: any difference is a problem (f32x4 against f32)
 * @returns {() => void} restores the worker's gather
 */
export function lockstepGather(worker, { reference, variant, keep = 'reference', stats, strict = false }) {
  const g = worker._wasmGather;
  const shipped = g.gather;
  const ref = reference || shipped;
  const buffer = g.marker.buffer;
  const count = worker.globalEntityCount | 0;
  const markerBefore = new Int32Array(g.marker.length);
  const markerRef = new Int32Array(g.marker.length);
  const problem = (s) => {
    stats.unexplained++;
    if (stats.problems.length < 8) stats.problems.push(s);
  };
  g.gather = (...args) => {
    const n = args[ARG.rebuilds];
    const maxN = args[ARG.maxNeighbors];
    const stride = 1 + maxN;
    const list = new Uint16Array(buffer, args[ARG.rebuildByte], n);
    const cand = new Uint16Array(buffer, args[ARG.candByte], count * stride);
    const truncated = new Uint8Array(buffer, args[ARG.truncatedByte], count);
    const pos = new Float32Array(buffer, args[ARG.posByte], count * 4);
    const range = new Float32Array(buffer, args[ARG.rangeByte], count);
    const skinFrac = args[ARG.skinFrac];

    markerBefore.set(g.marker);
    const cellsRef = ref(...args);
    const rows = new Array(n);
    const flags = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const a = list[k];
      rows[k] = cand.slice(a * stride, a * stride + 1 + cand[a * stride]);
      flags[k] = truncated[a];
    }
    markerRef.set(g.marker);
    g.marker.set(markerBefore);
    const cellsVar = variant(...args);
    stats.calls++;

    /** dx * dx + dy * dy against er * er in double, as the shipped gather has them: the relative gap. */
    const relGap = (a, b) => {
      const vr = range[a];
      const searchRange = vr + 2 * (vr * skinFrac);
      const er = searchRange + pos[b * 4 + 2];
      const dx = pos[b * 4] - pos[a * 4];
      const dy = pos[b * 4 + 1] - pos[a * 4 + 1];
      return Math.abs(dx * dx + dy * dy - er * er) / (er * er);
    };
    let cutFlips = 0;
    for (let k = 0; k < n; k++) {
      const a = list[k];
      const rr = rows[k];
      const refCount = rr[0];
      const varCount = cand[a * stride];
      stats.rows++;
      stats.pairs += refCount;
      let same = refCount === varCount && flags[k] === truncated[a];
      for (let q = 1; same && q <= refCount; q++) same = rr[q] === cand[a * stride + q];
      if (same) {
        stats.identicalRows++;
        continue;
      }
      if (strict) {
        problem(`entity ${a}: the row differs (${refCount} against ${varCount} candidates)`);
        continue;
      }
      const refIds = Array.from(rr.subarray(1));
      const varIds = Array.from(cand.subarray(a * stride + 1, a * stride + 1 + varCount));
      const inRef = new Set(refIds);
      const inVar = new Set(varIds);
      const only = [...varIds.filter((b) => !inRef.has(b)).map((b) => [b, 'in']), ...refIds.filter((b) => !inVar.has(b)).map((b) => [b, 'out'])];
      const cut = flags[k] || truncated[a];
      if (cut) stats.truncatedRows++;
      let edge = 0;
      const off = [];
      for (const [b, side] of only) {
        const gap = relGap(a, b);
        if (gap <= EDGE_REL) {
          edge++;
          stats.flips++;
          if (side === 'in') stats.flipsIn++;
          else stats.flipsOut++;
          if (gap > stats.worstRelGap) stats.worstRelGap = gap;
        } else {
          off.push([b, gap]);
        }
      }
      if (cut) {
        cutFlips += edge;
        // An edge flip moves the cut at maxNeighbors by one candidate.
        if (off.length > edge) problem(`entity ${a}: ${off.length} candidates off the edge in a truncated row with ${edge} flips`);
        else stats.truncationShifts += off.length;
        continue;
      }
      if (off.length) problem(`entity ${a}: candidate ${off[0][0]} is ${off[0][1]} relative off its range edge`);
      if (flags[k] !== truncated[a]) problem(`entity ${a}: truncation flag ${truncated[a]} against ${flags[k]}`);
      const restRef = refIds.filter((b) => inVar.has(b));
      const restVar = varIds.filter((b) => inRef.has(b));
      if (restRef.some((b, q) => b !== restVar[q])) problem(`entity ${a}: the shared candidates in another order`);
    }
    if (cellsVar !== cellsRef && !cutFlips) problem(`cells checked ${cellsVar} against ${cellsRef}`);

    if (keep === 'reference') {
      for (let k = 0; k < n; k++) {
        const a = list[k];
        cand.set(rows[k], a * stride);
        truncated[a] = flags[k];
      }
      g.marker.set(markerRef);
      return cellsRef;
    }
    return cellsVar;
  };
  return () => {
    g.gather = shipped;
  };
}
