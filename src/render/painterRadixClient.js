// The WASM painter sort (E-76 W10): painterRadix.wasm on the render-queue memory, where pre-render writes the
// main queue's sort keys and the sorting worker keeps its painter state (renderQueueMemoryRegions' painter
// spec, wasmMemoryMap.js painterStateRegions). A state made here has the JS painter state's shape
// (createPainterState, tests/reference/painterJs.mjs) with its arrays as views on the memory, and carries the
// kernel: packSpriteLayer sorts such a state with
// orderPainterSlotsWasm and radixSortIndicesWasm, which pass the keys and the slot list by their byte offsets
// and leave the order, prevKey, slotMoved, runHeads, runLen and moved arrays the JS sort left (its copy is
// tests/reference/painterJs.mjs), bit for bit. Keys or a slot list outside the memory, or more rows than the state
// holds, are drawn in queue order, said once (painterRefused). The order is an index list the packs read; nothing
// uploads it.
//
// The workers bind PAINTER_VARIANT; every variant stays exported for tests/node/painterRadixWasm.test.js and
// tests/bench/painterRadixWasmMicrobench.mjs. Browser-safe (no node: imports), so a Chrome kernel module can
// load it.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { PAINTER_HIST_WORDS, PAINTER_SLOTS } from '../util/wasmMemoryMap.js';
import { engineWasmUrl } from '../wasm/engine.js';

/**
 * Is `state.order` (last frame's permutation) still a valid slot set for this
 * frame? `idxE === null` means the dense range [0, ne) with no type filter
 * (a custom layer's queue is never split by type): same `ne` implies the same
 * integer set, no scan needed. A real `idxE` (the main queue's type-filtered
 * slot list, glow excluded) needs the O(n) stamp check since it is a proper
 * subset of [0, count) whose membership can shift frame to frame.
 * @param {ReturnType<typeof wasmPainterState>} state
 * @param {Uint32Array|null} idxE
 * @param {number} ne
 */
export function painterSameSet(state, idxE, ne) {
  if (!state.ready || state.n !== ne) return false;
  if (!idxE) return true;
  let gen = (state.gen + 1) | 0;
  if (gen === 0) {
    state.stamp.fill(0);
    gen = 1;
  }
  state.gen = gen;
  const stamp = state.stamp;
  for (let i = 0; i < ne; i++) stamp[idxE[i]] = gen;
  const order = state.order;
  for (let i = 0; i < ne; i++) {
    if (stamp[order[i]] !== gen) return false;
  }
  return true;
}


export const PAINTER_RADIX_URL = engineWasmUrl;
export { PAINTER_HIST_WORDS, PAINTER_SLOTS };
/** Radix variants: each has radix_sort_*, painter_order_* and reinsert_*. */
export const CORES = ['scalar', 'kv8', 'kv11', 'adaptive', 'simd'];
/**
 * Every variant; 'inplace' is the scalar radix with reinsert_inplace (its own merge), 'simd_inplace' the simd
 * radix with that merge (reinsert_simd_inplace).
 */
export const VARIANTS = [...CORES, 'inplace', 'simd_inplace'];
/** The variants whose reinsert merges inside `order` (they leave `merge` unwritten). */
export const INPLACE_VARIANTS = ['inplace', 'simd_inplace'];
/**
 * What the workers bind. Chrome chose simd's radix (predator-rebuild +247 %, stress-rebuild +163 %, stress-move
 * +54 %, reinsert +95 %; inplace's reinsert +102 %); simd_inplace is that radix with inplace's merge, which
 * writes no `merge` and copies nothing back. Both halves are bit-exact on their own; the pair is untimed.
 */
export const PAINTER_VARIANT = 'simd_inplace';
export const KERNEL_EXPORTS = [
  ...CORES.map((c) => `radix_sort_${c}`),
  ...CORES.map((c) => `painter_order_${c}`),
  ...VARIANTS.map((v) => `reinsert_${v}`),
];

/** The radix a variant's rebuild and radix exports use. */
export function variantCore(variant) {
  if (variant === 'inplace') return 'scalar';
  if (variant === 'simd_inplace') return 'simd';
  return variant;
}

/** The three exports one variant calls. */
export function variantExports(variant) {
  const core = variantCore(variant);
  return [`radix_sort_${core}`, `painter_order_${core}`, `reinsert_${variant}`];
}

/** The kernel's exports on `memory` (every variant's, or `exportNames`). */
export function loadPainterRadix(memory, url = engineWasmUrl, exportNames = KERNEL_EXPORTS) {
  return loadWasmKernel('painterRadix', url, memory, exportNames);
}

/**
 * One variant's functions in the shipped functions' shapes, for states on `buffer` (the kernel memory's).
 * Arrays are byte offsets into the memory (`idxEByte` 0 for the JS `null`); `keysByte` is the float32 sort
 * key column. A state's `kernel` is this object.
 * @param {Record<string, Function>} kernel loadPainterRadix's exports
 * @param {string} variant one of VARIANTS
 * @param {SharedArrayBuffer | ArrayBuffer | null} [buffer]
 */
export function painterRadixVariant(kernel, variant, buffer = null) {
  if (!VARIANTS.includes(variant)) throw new Error(`painterRadix: no variant ${variant}`);
  const core = variantCore(variant);
  const radix = kernel[`radix_sort_${core}`];
  const order = kernel[`painter_order_${core}`];
  const reinsert = kernel[`reinsert_${variant}`];
  return {
    variant,
    buffer,
    radix,
    order,
    reinsert,
    /** radixSortIndicesBySortKey(idx, n, keys, state.scratch, state.hist). */
    radixSort: (state, idxByte, n, keysByte) => radix(state.table, idxByte, n, keysByte),
    /** radixPainterOrder(state, idxE, ne, keys): the order, n and ready. */
    painterOrder(state, idxEByte, ne, keysByte) {
      const live = order(state.table, idxEByte, ne, keysByte);
      state.n = ne;
      state.ready = live !== 0;
      return state.order;
    },
    /** reinsertChangedSlots(state.order, n, keys, state.prevKey, …): the changed count or -1. */
    reinsertChanged: (state, n, keysByte) => reinsert(state.table, n, keysByte),
  };
}

function slotBytes(slot, rows) {
  if (slot === 'slotMoved') return rows;
  if (slot === 'hist') return PAINTER_HIST_WORDS * 4;
  return rows * 4;
}

/**
 * A cold painter state on the regions `layout` names (wasmMemoryMap.js painterStateLayout): createPainterState's
 * fields in its order, its arrays views on `buffer` and zeroed, `stamp` a private array (painterSameSet reads it
 * here), the table written, and `kernel` the variant that sorts it.
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @param {{ rows: number, tableByte: number } & Record<string, number>} layout
 * @param {ReturnType<typeof painterRadixVariant> | null} [kernel]
 */
export function wasmPainterState(buffer, layout, kernel = null) {
  const n = Math.max(1, layout.rows | 0);
  const table = new Uint32Array(buffer, layout.tableByte, PAINTER_SLOTS.length);
  for (let i = 0; i < PAINTER_SLOTS.length; i++) {
    const slot = PAINTER_SLOTS[i];
    const byte = layout[`${slot}Byte`];
    table[i] = byte;
    new Uint8Array(buffer, byte, slotBytes(slot, n)).fill(0);
  }
  const u32 = (slot, len = n) => new Uint32Array(buffer, layout[`${slot}Byte`], len);
  return {
    order: u32('order'),
    scratch: u32('scratch'),
    moved: u32('moved'),
    merge: u32('merge'),
    prevKey: u32('prevKey'),
    stamp: new Int32Array(n),
    slotMoved: new Uint8Array(buffer, layout.slotMovedByte, n),
    runHeads: u32('runHeads'),
    runLen: u32('runLen'),
    hist: u32('hist', PAINTER_HIST_WORDS),
    ready: false,
    n: 0,
    gen: 0,
    frame: 0,
    kernel,
    table: layout.tableByte,
  };
}

/** Back to a cold state: its arrays 0 (the ordinal buffers are scratch every call writes first). */
export function resetWasmPainterState(state) {
  for (const value of Object.values(state)) if (ArrayBuffer.isView(value)) value.fill(0);
  state.ready = false;
  state.n = 0;
  state.gen = 0;
  state.frame = 0;
}

/**
 * The kernel for one painter state of the render-queue memory (createRenderQueueMemory's layout.preRenderPainter
 * or layout.pixiPainter): PAINTER_VARIANT's exports.
 * @param {WebAssembly.Memory} memory
 * @param {{ rows: number, tableByte: number, idxEntityByte: number, idxGlowByte: number } & Record<string, number>} layout
 */
export async function bindPainterRadix(memory, layout, variant = PAINTER_VARIANT) {
  const exports = await loadPainterRadix(memory, engineWasmUrl, variantExports(variant));
  return { kernel: painterRadixVariant(exports, variant, memory.buffer), layout };
}

/** A cold painter state on the binding's regions, sorted by its kernel. */
export function createWasmPainterState(binding) {
  return wasmPainterState(binding.kernel.buffer, binding.layout, binding.kernel);
}

/** The binding's slot list `which` ('entity': the rows without glow; 'glow'), `rows` long, in the memory. */
export function painterSlotList(binding, which, rows) {
  const byte = which === 'glow' ? binding.layout.idxGlowByte : binding.layout.idxEntityByte;
  return new Uint32Array(binding.kernel.buffer, byte, rows);
}

/**
 * orderPainterSlots(state, idxE, ne, keysU32) through the state's kernel: the same order, the same arrays, the
 * same return. `idxE` is the slot list's view (null: the dense [0, ne)).
 * @param {ReturnType<typeof wasmPainterState>} state
 * @param {Uint32Array | null} idxE
 * @param {number} ne
 * @param {Uint32Array} keysU32
 */
export function orderPainterSlotsWasm(state, idxE, ne, keysU32) {
  const k = state.kernel;
  if (keysU32.buffer !== k.buffer || (idxE !== null && idxE.buffer !== k.buffer) || ne > state.order.length) {
    painterRefused(ne > state.order.length ? `${ne} rows for a state of ${state.order.length}` : 'its keys or slot list are outside the render-queue memory');
    return idxE;
  }
  if (ne <= 0) return idxE;
  if (ne < 2) {
    if (idxE) return idxE;
    state.order[0] = 0;
    return state.order;
  }
  state.frame = (state.frame + 1) | 0;
  const keysByte = keysU32.byteOffset;
  const idxEByte = idxE !== null ? idxE.byteOffset : 0;
  if (!painterSameSet(state, idxE, ne)) return k.painterOrder(state, idxEByte, ne, keysByte);
  if (k.reinsert(state.table, ne, keysByte) < 0) return k.painterOrder(state, idxEByte, ne, keysByte);
  return state.order;
}

let painterRefusedWarned = false;

/** A call painterRadix.wasm cannot take: its rows stay in queue order, the reason said once. */
function painterRefused(reason) {
  if (painterRefusedWarned) return;
  painterRefusedWarned = true;
  console.error(`[PAINTER] painterRadix.wasm cannot sort a queue (${reason}): it is drawn in queue order`);
}

/** The stable radix by key (tests/reference/painterJs.mjs radixSortIndicesBySortKey) through the state's kernel. */
export function radixSortIndicesWasm(state, idx, n, keysU32) {
  if ((n | 0) < 2) return;
  const k = state.kernel;
  if (keysU32.buffer !== k.buffer || idx.buffer !== k.buffer || n > state.order.length) {
    painterRefused(n > state.order.length ? `${n} rows for a state of ${state.order.length}` : 'its keys or list are outside the render-queue memory');
    return;
  }
  k.radix(state.table, idx.byteOffset, n, keysU32.byteOffset);
}
