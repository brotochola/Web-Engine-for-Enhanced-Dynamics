// The particle memory (E-79): ParticleComponent's buffer as a shared WebAssembly.Memory, with the
// particle worker's lists and the WASM integrate's scratch after the component. Every worker views
// the component exactly as it views a plain SharedArrayBuffer (its columns start at byte 0). The
// regions and their offsets come from the memory map (wasmMemoryMap.js).

import { PARTICLE_DEFAULTS } from './configDefaults.js';
import { particleIntegrateRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/** Entries in each EXPO ease table (particleTween.js builds three of expoLutSize + 1). */
export const PARTICLE_LUT_ENTRIES = (PARTICLE_DEFAULTS.expoLutSize | 0) + 1;

/**
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }}
 */
export function createParticleMemory(maxParticles, componentBytes) {
  const n = maxParticles | 0;
  if (n <= 0 || n > 65535) return null;
  const map = particleIntegrateRegions(n, componentBytes | 0, 3 * PARTICLE_LUT_ENTRIES);
  if (map.pages > WASM_MAX_PAGES) return null;
  const r = map.regions;
  try {
    const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
    return {
      memory,
      buffer: memory.buffer,
      // Plain numbers, so the layout posts to workers as it is.
      layout: {
        indicesByte: r.indices.byte,
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
