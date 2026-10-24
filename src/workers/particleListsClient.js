// The WASM particle list build (E-80): loads particleLists.wasm onto the particle memory and builds
// the published active and visible lists there, as buildActiveAndVisibleListBuffers, its turned
// loop or buildActiveListBuffers (no camera yet) would. The integrate reads the published active
// list's indices, so the particle worker keeps no copy of its own.

import { loadWasmKernel } from '../util/wasmKernel.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./particleLists.wasm', import.meta.url);

/**
 * Bind the kernel for a ParticleComponent whose buffer is `memory`'s.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} layout createParticleMemory's layout
 * @param {typeof import('../components/particleComponent.js').ParticleComponent} pc
 */
export async function bindParticleLists(memory, layout, pc) {
  const k = await loadWasmKernel('particleLists', wasmUrl, memory, ['build_lists', 'build_lists_turned', 'build_active']);
  if (pc.sharedBuffer !== memory.buffer) throw new Error('ParticleComponent is not in the particle memory');
  return {
    build: k.build_lists,
    buildTurned: k.build_lists_turned,
    buildActive: k.build_active,
    activeByte: pc.active.byteOffset,
    xByte: pc.x.byteOffset,
    yByte: pc.y.byteOffset,
    onScreenByte: pc.isItOnScreen.byteOffset,
    activeListByte: layout.activeListByte,
    visibleListByte: layout.visibleListByte,
  };
}

/**
 * buildActiveAndVisibleListBuffers (rotation 0) or its turned loop through the kernel, over the
 * first `maxParticles` slots. The turned loop's terms are computed as JS computes them.
 * @returns {number} the active count
 */
export function buildParticleListsWasm(b, maxParticles, cameraBounds, rotation, canvasWidth, canvasHeight, cullingRatio) {
  const camZoom = cameraBounds.zoom;
  if (!rotation) {
    return b.build(
      b.activeByte, b.xByte, b.yByte, b.onScreenByte, maxParticles, b.activeListByte, b.visibleListByte,
      camZoom, cameraBounds.cameraOffsetX, cameraBounds.cameraOffsetY,
      cameraBounds.minX, cameraBounds.maxX, cameraBounds.minY, cameraBounds.maxY,
    );
  }
  const halfCw = canvasWidth * 0.5;
  const halfCh = canvasHeight * 0.5;
  const marginScale = camZoom < 1 ? camZoom : 1;
  return b.buildTurned(
    b.activeByte, b.xByte, b.yByte, b.onScreenByte, maxParticles, b.activeListByte, b.visibleListByte,
    camZoom, cameraBounds.cameraOffsetX, cameraBounds.cameraOffsetY, halfCw, halfCh,
    Math.cos(rotation), Math.sin(rotation),
    halfCw + canvasWidth * cullingRatio * marginScale, halfCh + canvasHeight * cullingRatio * marginScale,
  );
}

/** buildActiveListBuffers through the kernel (the camera is not ready); the visible count is 0. */
export function buildActiveParticleListWasm(b, maxParticles) {
  return b.buildActive(b.activeByte, maxParticles, b.activeListByte, b.visibleListByte);
}
