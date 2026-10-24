// The navigation memory (E-76 W14): NavGrid's buffer at byte 0 of a shared WebAssembly.Memory, where every
// worker views it as it views a plain SharedArrayBuffer, and the particle worker's flowfield scratch after
// it, so navFlowfield.wasm reads the walkability and writes its vectors in one memory.

import { navigationMemoryRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/**
 * @param {number} navBytes NavGrid.calculateSABSize(...)
 * @param {number} cells the grid's cells
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }}
 */
export function createNavigationMemory(navBytes, cells) {
  const n = cells | 0;
  if (n <= 0 || (navBytes | 0) <= 0) return null;
  const map = navigationMemoryRegions(navBytes, n);
  if (map.pages > WASM_MAX_PAGES) return null;
  const r = map.regions;
  try {
    const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
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
  } catch {
    return null;
  }
}
