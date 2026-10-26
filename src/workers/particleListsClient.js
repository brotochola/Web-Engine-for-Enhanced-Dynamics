// The WASM particle list build (E-80): loads particleLists.wasm onto the particle memory and builds
// the published active and visible lists there, as buildActiveAndVisibleListBuffers, its turned
// loop or buildActiveListBuffers (no camera yet) would. The integrate reads the published active
// list's indices, so the particle worker keeps no copy of its own. With `f32` (wasm.particleListsF32, the
// particle worker's default) the screen test is the kernel's float32 one, build_lists_f32x4 and
// build_lists_turned_f32x4, chosen here once; the call path is the same. E-129: a pool past 65 535 slots, whose
// memory lays the lists out at 4 bytes a slot (layout.slotBytes 4), binds the _u32 export of each build.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { engineWasmUrl } from '../wasm/engine.js';


/** The kernel's two screen-test builds, double and float32, on u16 lists and on u32 lists (wasm/particleLists.c). */
const BUILD_EXPORTS = Object.freeze({ build: 'build_lists', buildTurned: 'build_lists_turned', buildActive: 'build_active' });
const BUILD_EXPORTS_F32 = Object.freeze({ build: 'build_lists_f32x4', buildTurned: 'build_lists_turned_f32x4', buildActive: 'build_active' });
const BUILD_EXPORTS_U32 = Object.freeze({ build: 'build_lists_u32', buildTurned: 'build_lists_turned_u32', buildActive: 'build_active_u32' });
const BUILD_EXPORTS_F32_U32 = Object.freeze({
  build: 'build_lists_f32x4_u32', buildTurned: 'build_lists_turned_f32x4_u32', buildActive: 'build_active_u32',
});

/**
 * Bind the kernel for a ParticleComponent whose buffer is `memory`'s.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} layout createParticleMemory's layout
 * @param {typeof import('../components/particleComponent.js').ParticleComponent} pc
 * @param {{ f32?: boolean }} [options] f32: the float32 screen test (`f32` on the binding says which)
 */
export async function bindParticleLists(memory, layout, pc, { f32 = false } = {}) {
  const wide = layout.slotBytes === 4;
  const names = wide ? (f32 ? BUILD_EXPORTS_F32_U32 : BUILD_EXPORTS_U32) : f32 ? BUILD_EXPORTS_F32 : BUILD_EXPORTS;
  const k = await loadWasmKernel('particleLists', engineWasmUrl, memory, [names.build, names.buildTurned, names.buildActive]);
  if (pc.sharedBuffer !== memory.buffer) throw new Error('ParticleComponent is not in the particle memory');
  return {
    f32: Boolean(f32),
    slotBytes: wide ? 4 : 2,
    build: k[names.build],
    buildTurned: k[names.buildTurned],
    buildActive: k[names.buildActive],
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
