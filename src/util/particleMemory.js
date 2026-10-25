// The particle memory (E-79, E-80): ParticleComponent's buffer as a shared WebAssembly.Memory, with the
// published particle lists and the WASM kernels' scratch after the component. Every worker views
// the component exactly as it views a plain SharedArrayBuffer (at layout.componentByte, 0 in a memory of its
// own). Close-out group B: a region of the render-queue memory when the scene has one (createParticleMemory's
// place), so pre-render's emit kernel reads the particles where the particle kernels write them. The
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
 * The bytes the particle memory's regions take, for a region reserved before it is made (the render-queue memory's).
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 */
export function particleMemoryBytes(maxParticles, componentBytes) {
  const n = maxParticles | 0;
  return n > 0 ? particleMemoryRegions(n, componentBytes | 0, 3 * PARTICLE_LUT_ENTRIES).bytes : 0;
}

/**
 * @param {number} maxParticles
 * @param {number} componentBytes ParticleComponent.getBufferSize(maxParticles)
 * @param {null | { memory: WebAssembly.Memory, baseByte: number, bytes: number }} [place] lay the regions in that
 *   memory from baseByte, in the `bytes` reserved there (the render-queue memory's particle region), instead of
 *   making a memory of their own
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: Record<string, number> }} null without
 *   particles; past MAX_POOL_SLOTS, past the module's import, outside its place, or refused by the browser, it throws
 */
export function createParticleMemory(maxParticles, componentBytes, place = null) {
  const n = maxParticles | 0;
  if (n <= 0) return null;
  if (n > MAX_POOL_SLOTS) throw new Error(`particle memory: ${n} particles is past the ${MAX_POOL_SLOTS} a pool holds`);
  const slotBytes = poolSlotBytes(n);
  const map = particleMemoryRegions(n, componentBytes | 0, 3 * PARTICLE_LUT_ENTRIES);
  const mb = Math.ceil((map.pages * 65536) / 1048576);
  const base = place ? place.baseByte | 0 : 0;
  if (place) {
    if ((base & 63) !== 0 || map.bytes > (place.bytes | 0) || base + map.bytes > place.memory.buffer.byteLength) {
      throw new Error(`particle memory: ${map.bytes} bytes do not fit the ${place.bytes | 0} reserved at byte ${base}`);
    }
  } else if (map.pages > WASM_MAX_PAGES) {
    throw new Error(`particle memory: ${mb} MB (${n} particles) is past the ${WASM_MAX_PAGES / 16} MB a kernel memory can take`);
  }
  // Every region's byte from the memory's start: the place's offset added.
  const r = {};
  for (const [name, region] of Object.entries(map.regions)) r[name] = { ...region, byte: region.byte + base };
  let memory = place ? place.memory : null;
  if (!memory) {
    try {
      memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
    } catch (err) {
      throw new Error(`particle memory: the browser would not make ${mb} MB (${err?.message ?? err})`, { cause: err });
    }
  }
  return {
    memory,
    buffer: memory.buffer,
    // Plain numbers, so the layout posts to workers as it is.
    layout: {
      // ParticleComponent's columns start here (buffers.componentDataByte.ParticleComponent).
      componentByte: r.component.byte,
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
