// The particle memory (E-79, E-80): ParticleComponent's buffer as a shared WebAssembly.Memory, with the
// published particle lists and the WASM kernels' scratch after the component. Every worker views
// the component exactly as it views a plain SharedArrayBuffer (its columns start at byte 0). The
// regions and their offsets come from the memory map (wasmMemoryMap.js). E-129: a pool past 65 535
// slots lays its lists out at 4 bytes a slot (layout.slotBytes), up to MAX_POOL_SLOTS; up to 65 535
// the layout is the 16-bit one it always was. The integrate and the list build run only in WebAssembly, so a scene
// with particles always has one: past the 2 GB cap, or refused by the browser, it is an error that names its size.

import { PARTICLE_DEFAULTS } from './configDefaults.js';
import { MAX_POOL_SLOTS, poolSlotBytes } from './poolSlotWidth.js';
import { particleMemoryRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 32768 pages (2 GB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 32768;

/** Entries in each EXPO ease table (particleTween.js builds three of expoLutSize + 1). */
export const PARTICLE_LUT_ENTRIES = (PARTICLE_DEFAULTS.expoLutSize | 0) + 1;

/**
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }} null without
 *   particles; past MAX_POOL_SLOTS, past the module's import, or refused by the browser, it throws
 */
export function createParticleMemory(maxParticles, componentBytes) {
  const n = maxParticles | 0;
  if (n <= 0) return null;
  if (n > MAX_POOL_SLOTS) throw new Error(`particle memory: ${n} particles is past the ${MAX_POOL_SLOTS} a pool holds`);
  const slotBytes = poolSlotBytes(n);
  const map = particleMemoryRegions(n, componentBytes | 0, 3 * PARTICLE_LUT_ENTRIES);
  const mb = Math.ceil((map.pages * 65536) / 1048576);
  if (map.pages > WASM_MAX_PAGES) {
    throw new Error(`particle memory: ${mb} MB (${n} particles) is past the ${WASM_MAX_PAGES / 16} MB a kernel memory can take`);
  }
  const r = map.regions;
  let memory;
  try {
    memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
  } catch (err) {
    throw new Error(`particle memory: the browser would not make ${mb} MB (${err?.message ?? err})`, { cause: err });
  }
  return {
    memory,
    buffer: memory.buffer,
    // Plain numbers, so the layout posts to workers as it is.
    layout: {
      activeListByte: r.activeList.byte,
      visibleListByte: r.visibleList.byte,
      // Bytes per slot id in every list: 2, or 4 past 65 535 slots.
      slotBytes,
      // The integrate's input: the published active list after its count.
      indicesByte: r.activeList.byte + slotBytes,
      stampByte: r.stamp.byte,
      flatByte: r.flat.byte,
      heightedByte: r.heighted.byte,
      deadByte: r.dead.byte,
      trigByte: r.trig.byte,
      trigAngleByte: r.trigAngle.byte,
      lutByte: r.luts.byte,
      columnsByte: r.columns.byte,
      resultsByte: r.results.byte,
    },
  };
}
