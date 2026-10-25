// The navigation memory (E-76 W14): NavGrid's buffer at byte 0 of a shared WebAssembly.Memory, where every
// worker views it as it views a plain SharedArrayBuffer, and the particle worker's flowfield scratch after
// it, so navFlowfield.wasm reads the walkability and writes its vectors in one memory. The flowfield runs only there,
// so a scene with navigation always has one: past the 2 GB cap, or refused by the browser, is an error.

import { navigationMemoryRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 32768 pages (2 GB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 32768;

/**
 * @param {number} navBytes NavGrid.calculateSABSize(...)
 * @param {number} cells the grid's cells
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }} null without cells
 */
export function createNavigationMemory(navBytes, cells) {
  const n = cells | 0;
  if (n <= 0 || (navBytes | 0) <= 0) return null;
  const map = navigationMemoryRegions(navBytes, n);
  const mb = Math.ceil((map.pages * 65536) / 1048576);
  if (map.pages > WASM_MAX_PAGES) {
    throw new Error(
      `navigation memory: ${mb} MB (${n} cells) is past the ${WASM_MAX_PAGES / 16} MB a kernel memory can take; ` +
        'raise navigation.cellSize or lower maxFlowfields',
    );
  }
  const r = map.regions;
  let memory;
  try {
    memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
  } catch (err) {
    throw new Error(`navigation memory: the browser would not make ${mb} MB (${err?.message ?? err})`, { cause: err });
  }
  return {
    memory,
    buffer: memory.buffer,
    // Plain numbers, so the layout posts to workers as it is.
    layout: {
      cells: n,
      navBytes: navBytes | 0,
      stateByte: r.state.byte,
      distByte: r.dist.byte,
      dirByte: r.dir.byte,
      nextByte: r.next.byte,
      prevByte: r.prev.byte,
      headByte: r.head.byte,
      sumsByte: r.sums.byte,
      quotientByte: r.quotient.byte,
      vectorsByte: r.vectors.byte,
      tableByte: r.table.byte,
    },
  };
}
