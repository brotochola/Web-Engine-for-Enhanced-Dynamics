// The WASM flowfield (E-76 W14): loads navFlowfield.wasm onto the navigation memory, where NavGrid's buffer
// sits at byte 0 and the particle worker's flowfield scratch after it (navigationMemoryRegions).
// compute_flowfield is computeFlowfield's search, walls' pass and smoothing for one target cell, with the
// JS's distances, directions and vectors; the slot (allocateFlowfieldSlot, the copy of the vectors, READY)
// stays JS.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { NAV_MAX_BUCKETS, NAV_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./navFlowfield.wasm', import.meta.url);

/** wasm/navFlowfield.c's column table, slot for slot. */
export const FLOWFIELD_SLOTS = ['walk', 'width', 'height', 'maxDist', 'state', 'dist', 'dir', 'next', 'prev', 'head', 'sums', 'quotient', 'out'];
if (FLOWFIELD_SLOTS.length > NAV_TABLE_SLOTS) throw new Error('navFlowfield: the column table outgrew its region');
const SLOT = Object.fromEntries(FLOWFIELD_SLOTS.map((name, k) => [name, k]));

/**
 * Bind the kernel to the navigation memory and write its table, which holds for the grid's life: the
 * walkability NavGrid views, the grid, the last distance bucket and the scratch regions.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} nav createNavigationMemory's layout
 * @param {{ walkability: Uint8Array, gridWidth: number, gridHeight: number, maxDistance: number }} grid
 */
export async function bindNavFlowfield(memory, nav, grid) {
  const buffer = memory.buffer;
  if (!grid.walkability || grid.walkability.buffer !== buffer) throw new Error('navFlowfield: the walkability is not in the memory');
  if (grid.gridWidth * grid.gridHeight !== nav.cells) throw new Error('navFlowfield: the grid does not match the memory');
  if (!(grid.maxDistance >= 0 && grid.maxDistance < NAV_MAX_BUCKETS)) throw new Error('navFlowfield: the distance buckets outgrow their region');
  const k = await loadWasmKernel('navFlowfield', wasmUrl, memory, ['compute_flowfield']);
  const t = new Uint32Array(buffer, nav.tableByte, FLOWFIELD_SLOTS.length);
  t[SLOT.walk] = grid.walkability.byteOffset;
  t[SLOT.width] = grid.gridWidth;
  t[SLOT.height] = grid.gridHeight;
  t[SLOT.maxDist] = grid.maxDistance;
  t[SLOT.state] = nav.stateByte;
  t[SLOT.dist] = nav.distByte;
  t[SLOT.dir] = nav.dirByte;
  t[SLOT.next] = nav.nextByte;
  t[SLOT.prev] = nav.prevByte;
  t[SLOT.head] = nav.headByte;
  t[SLOT.sums] = nav.sumsByte;
  t[SLOT.quotient] = nav.quotientByte;
  t[SLOT.out] = nav.vectorsByte;
  return {
    compute: k.compute_flowfield,
    tableByte: nav.tableByte,
    vectors: new Int8Array(buffer, nav.vectorsByte, nav.cells * 2),
  };
}
