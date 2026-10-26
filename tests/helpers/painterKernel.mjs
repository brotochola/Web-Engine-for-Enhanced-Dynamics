// A painter state sorted by painterRadix.wasm, on a memory of its own with room for the keys it reads, for tests
// that order rows through packSpriteLayer or the kernel client without a scene's render-queue memory.
import { bindPainterRadix, createWasmPainterState } from '../../src/render/painterRadixClient.js';
import { layoutRegions, painterStateLayout, painterStateRegions } from '../../src/util/wasmMemoryMap.js';

/**
 * @param {number} rows the queue's rows (the state's, and the keys')
 * @returns {Promise<{ state: object, keysU32: Uint32Array, idx: Uint32Array, memory: WebAssembly.Memory }>}
 *   `idx` a slot list in the memory (the kernel reads a list there), `rows` long
 */
export async function kernelPainter(rows) {
  const n = Math.max(1, rows | 0);
  const r = layoutRegions([
    ...painterStateRegions('test', n, 'test'),
    { name: 'keys', owner: 'test', bytes: n * 4 },
    { name: 'idx', owner: 'test', bytes: n * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: r.pages, maximum: 32768, shared: true });
  const binding = await bindPainterRadix(memory, painterStateLayout(r.regions, 'test', n));
  return {
    state: createWasmPainterState(binding),
    keysU32: new Uint32Array(memory.buffer, r.regions.keys.byte, n),
    idx: new Uint32Array(memory.buffer, r.regions.idx.byte, n),
    memory,
  };
}
