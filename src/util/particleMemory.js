// The particle memory (E-79, E-80): ParticleComponent's buffer as a shared WebAssembly.Memory, with the
// published particle lists and the WASM kernels' scratch after the component. Every worker views
// the component exactly as it views a plain SharedArrayBuffer (its columns start at byte 0). The
// regions and their offsets come from the memory map (wasmMemoryMap.js). E-129: a pool past 65 535
// slots lays its lists out at 4 bytes a slot (layout.slotBytes), up to MAX_POOL_SLOTS; up to 65 535
// the layout is the 16-bit one it always was.

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
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }}
 */
export function createParticleMemory(maxParticles, componentBytes) {
  const n = maxParticles | 0;
  if (n <= 0 || n > MAX_POOL_SLOTS) return null;
  const slotBytes = poolSlotBytes(n);
  const map = particleMemoryRegions(n, componentBytes | 0, 3 * PARTICLE_LUT_ENTRIES);
  if (map.pages > WASM_MAX_PAGES) return null;
  const r = map.regions;
  try {
    const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
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
  } catch {
    return null;
  }
}
