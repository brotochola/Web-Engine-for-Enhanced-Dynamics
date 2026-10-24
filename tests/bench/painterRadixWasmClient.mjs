/**
 * The JavaScript side of the painter sort kernel (E-76 W10; wasm/test/painterRadix.c, a test module,
 * tests/fixtures/wasm/painterRadix.wasm): a painter state laid out in a shared WebAssembly.Memory, and one
 * variant's exports bound to the shipped functions' shapes. Used by tests/node/painterRadixWasm.test.js
 * and tests/bench/painterRadixWasmMicrobench.mjs; what a product wrapper would do once the sort is wired.
 * Browser-safe (no node: imports), so a Chrome kernel module can load it.
 *
 * A state is createPainterState's arrays as views on the memory, plus the kernel's histograms (the JS
 * module's radixHist4) and two ordinal buffers, and a table of their byte offsets (painterRadix.c P_*).
 * `stamp`, `ready`, `n`, `gen` and `frame` stay JavaScript: painterSameSet is the shipped function.
 */
import { painterSameSet } from '../../src/util/sortIndexByKey.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';

export const KERNEL_URL = new URL('../fixtures/wasm/painterRadix.wasm', import.meta.url);

/** painterRadix.c's table, slot for slot. */
export const PAINTER_SLOTS = ['order', 'scratch', 'moved', 'merge', 'prevKey', 'slotMoved', 'runHeads', 'runLen', 'hist', 'ordsA', 'ordsB'];
/** painterRadix.c HIST_WORDS: three 11-bit histograms. */
export const HIST_WORDS = 6144;
/** Radix variants: each has radix_sort_*, painter_order_* and reinsert_*. */
export const CORES = ['scalar', 'kv8', 'kv11', 'adaptive', 'simd'];
/** Every variant; 'inplace' is the scalar radix with reinsert_inplace (its own merge). */
export const VARIANTS = [...CORES, 'inplace'];
export const KERNEL_EXPORTS = [
  ...CORES.map((c) => `radix_sort_${c}`),
  ...CORES.map((c) => `painter_order_${c}`),
  ...VARIANTS.map((v) => `reinsert_${v}`),
];

/** Bytes of each state array for `capacity` rows (createPainterState sizes rows and slots alike). */
function arrayBytes(name, capacity) {
  if (name === 'slotMoved') return capacity;
  if (name === 'hist') return HIST_WORDS * 4;
  return capacity * 4;
}

/**
 * The regions of one painter state, names prefixed, for layoutRegions (src/util/wasmMemoryMap.js).
 * @param {string} prefix
 * @param {number} capacity createPainterState's maxItems
 * @param {string} [owner]
 */
export function painterStateRegions(prefix, capacity, owner = 'the worker that sorts the queue') {
  const n = Math.max(1, capacity | 0);
  return [
    ...PAINTER_SLOTS.map((name) => ({ name: `${prefix}${name}`, owner, bytes: arrayBytes(name, n) })),
    { name: `${prefix}table`, owner, bytes: PAINTER_SLOTS.length * 4 },
  ];
}

/**
 * A createPainterState-shaped object on the memory's regions (painterStateRegions), its table written.
 * `table` is the table's byte offset, what every export takes first.
 * @param {ArrayBuffer | SharedArrayBuffer} buffer the kernel memory's buffer
 * @param {Record<string, { byte: number }>} regions layoutRegions(...).regions
 * @param {string} prefix
 * @param {number} capacity
 */
export function wasmPainterState(buffer, regions, prefix, capacity) {
  const n = Math.max(1, capacity | 0);
  const at = (name) => regions[`${prefix}${name}`].byte;
  const u32 = (name, len = n) => new Uint32Array(buffer, at(name), len);
  const table = new Uint32Array(buffer, at('table'), PAINTER_SLOTS.length);
  PAINTER_SLOTS.forEach((name, i) => {
    table[i] = at(name);
  });
  return {
    order: u32('order'),
    scratch: u32('scratch'),
    moved: u32('moved'),
    merge: u32('merge'),
    prevKey: u32('prevKey'),
    stamp: new Int32Array(n),
    slotMoved: new Uint8Array(buffer, at('slotMoved'), n),
    runHeads: u32('runHeads'),
    runLen: u32('runLen'),
    hist: u32('hist', HIST_WORDS),
    ordsA: u32('ordsA'),
    ordsB: u32('ordsB'),
    ready: false,
    n: 0,
    gen: 0,
    frame: 0,
    table: at('table'),
  };
}

/** Back to createPainterState's state: every array 0, cold. */
export function resetWasmPainterState(state) {
  for (const name of PAINTER_SLOTS) state[name].fill(0);
  state.stamp.fill(0);
  state.ready = false;
  state.n = 0;
  state.gen = 0;
  state.frame = 0;
}

/** The kernel's exports on `memory`. */
export function loadPainterRadix(memory, url = KERNEL_URL) {
  return loadWasmKernel('painterRadix', url, memory, KERNEL_EXPORTS);
}

/**
 * One variant's functions in the shipped functions' shapes. Arrays are byte offsets into the memory
 * (`idxEByte` 0 for the JS `null`); `keysByte` is the float32 sort key column.
 * @param {Record<string, Function>} kernel loadPainterRadix's exports
 * @param {string} variant one of VARIANTS
 */
export function painterRadixVariant(kernel, variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`painterRadix: no variant ${variant}`);
  const core = variant === 'inplace' ? 'scalar' : variant;
  const radix = kernel[`radix_sort_${core}`];
  const order = kernel[`painter_order_${core}`];
  const reinsert = kernel[`reinsert_${variant}`];
  /** radixPainterOrder(state, idxE, ne, keys): the order, n and ready. */
  const painterOrder = (state, idxEByte, ne, keysByte) => {
    const live = order(state.table, idxEByte, ne, keysByte);
    state.n = ne;
    state.ready = live !== 0;
    return state.order;
  };
  return {
    variant,
    radix,
    order,
    reinsert,
    /** radixSortIndicesBySortKey(idx, n, keys, state.scratch, state.hist). */
    radixSort: (state, idxByte, n, keysByte) => radix(state.table, idxByte, n, keysByte),
    painterOrder,
    /** reinsertChangedSlots(state.order, n, keys, state.prevKey, …): the changed count or -1. */
    reinsertChanged: (state, n, keysByte) => reinsert(state.table, n, keysByte),
    /** orderPainterSlots with the kernel for the rebuild and the reinsert; idxE is the slot list's view. */
    orderPainterSlots(state, idxE, idxEByte, ne, keysByte) {
      if (ne <= 0) return idxE;
      if (ne < 2) {
        if (idxE) return idxE;
        state.order[0] = 0;
        return state.order;
      }
      state.frame = (state.frame + 1) | 0;
      if (!painterSameSet(state, idxE, ne)) return painterOrder(state, idxEByte, ne, keysByte);
      const changed = reinsert(state.table, ne, keysByte);
      if (changed < 0) return painterOrder(state, idxEByte, ne, keysByte);
      return state.order;
    },
  };
}
