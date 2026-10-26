// The WASM particle integrate (E-79): loads particleIntegrate.wasm onto the particle memory and
// runs updateParticlePhysicsBuffers' work in it. What JS did around the loop stays here: the dead
// list goes back to the pool in the order JS returned it (the free list's order decides later
// allocations), and an angle past fdlibm's medium reduction gets Math.cos / Math.sin. With `f32`
// (wasm.particleIntegrateF32, the particle worker's default) the kernel's float32 integrate,
// integrate_batch_f32x4, is bound in integrate_batch's place, once; the call and the JS around it are the
// same. E-129: a pool past 65 535 slots (layout.slotBytes 4) binds the _u32 export, on u32 lists.

import { ParticleEmitter } from '../core/particleEmitter.js';
import { PARTICLE_LUT_ENTRIES } from '../util/particleMemory.js';
import { expoLutTables } from '../util/particleTween.js';
import { loadWasmKernel } from '../util/wasmKernel.js';
import { engineWasmUrl } from '../wasm/engine.js';


/** The columns wasm/particleIntegrate.c reads, in its table's order. */
export const PARTICLE_INTEGRATE_COLUMNS = Object.freeze([
  'active', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'lifespan', 'currentLife', 'gravity', 'scaleX', 'scaleY',
  'alpha', 'tint', 'baseTint', 'textureId', 'rotC', 'rotS', 'fadeOnTheFloor', 'timeOnFloor', 'initialAlpha',
  'stayOnTheFloor', 'despawnOnGroundContact', 'tweenMask', 'easeId', 'alphaFrom', 'alphaTo', 'scaleXFrom',
  'scaleXTo', 'scaleYFrom', 'scaleYTo', 'tintFrom', 'tintTo', 'rotFrom', 'rotTo', 'angularVelFrom',
  'angularVelTo', 'hasAngularVel', 'animCount', 'animMode', 'animFrames', 'flat', 'renderOnly',
]);

/**
 * Bind the kernel for a ParticleComponent whose buffer is `memory`'s: writes the column table and
 * the EXPO tables, returns the kernel and the particle worker's lists as views of the memory.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} layout createParticleMemory's layout
 * @param {typeof import('../components/particleComponent.js').ParticleComponent} pc
 * @param {number} maxParticles
 * @param {{ f32?: boolean }} [options] f32: the float32 integrate (`f32` on the binding says which)
 */
export async function bindParticleIntegrate(memory, layout, pc, maxParticles, { f32 = false } = {}) {
  const wide = layout.slotBytes === 4;
  const exportName = `${f32 ? 'integrate_batch_f32x4' : 'integrate_batch'}${wide ? '_u32' : ''}`;
  const integrate = (await loadWasmKernel('particleIntegrate', engineWasmUrl, memory, [exportName]))[exportName];
  const buffer = memory.buffer;
  if (pc.sharedBuffer !== buffer) throw new Error('ParticleComponent is not in the particle memory');
  const columns = new Uint32Array(buffer, layout.columnsByte, PARTICLE_INTEGRATE_COLUMNS.length);
  PARTICLE_INTEGRATE_COLUMNS.forEach((name, k) => {
    columns[k] = pc[name].byteOffset;
  });
  const tables = expoLutTables();
  if (tables.some((t) => t.length !== PARTICLE_LUT_ENTRIES)) throw new Error('EXPO table size changed');
  tables.forEach((t, k) => new Float32Array(buffer, layout.lutByte + k * PARTICLE_LUT_ENTRIES * 4, PARTICLE_LUT_ENTRIES).set(t));
  const n = maxParticles | 0;
  const Slot = wide ? Uint32Array : Uint16Array;
  return {
    integrate,
    f32: Boolean(f32),
    slotBytes: wide ? 4 : 2,
    layout,
    lutSize: PARTICLE_LUT_ENTRIES - 1,
    indices: new Slot(buffer, layout.indicesByte, n),
    stamp: new Slot(buffer, layout.stampByte, n),
    dead: new Slot(buffer, layout.deadByte, n),
    trig: new Slot(buffer, layout.trigByte, n),
    trigAngle: new Float64Array(buffer, layout.trigAngleByte, n),
    results: new Int32Array(buffer, layout.resultsByte, 4),
    out: { activeCount: 0, stampedCount: 0 },
  };
}

/**
 * updateParticlePhysicsBuffers through the kernel, for the active list in `binding.indices`.
 * @returns {{ activeCount: number, stampedCount: number }}
 */
export function integrateParticlesWasm(binding, pc, count, deltaTime, dtRatio, stampEnabled) {
  const L = binding.layout;
  const skipRenderOnly = pc.renderOnlyLive && Atomics.load(pc.renderOnlyLive, 0) > 0 ? 1 : 0;
  binding.integrate(
    L.columnsByte, L.indicesByte, count, deltaTime, dtRatio, stampEnabled ? 1 : 0, skipRenderOnly,
    L.stampByte, L.flatByte, L.heightedByte, L.deadByte, L.trigByte, L.trigAngleByte,
    L.lutByte, binding.lutSize, L.resultsByte,
  );
  const results = binding.results;
  const dead = binding.dead;
  for (let k = 0, n = results[2]; k < n; k++) ParticleEmitter.returnToPool(dead[k]);
  const trig = binding.trig;
  const trigAngle = binding.trigAngle;
  for (let k = 0, n = results[3]; k < n; k++) {
    const i = trig[k];
    pc.rotC[i] = Math.cos(trigAngle[k]);
    pc.rotS[i] = Math.sin(trigAngle[k]);
  }
  binding.out.activeCount = results[0];
  binding.out.stampedCount = results[1];
  return binding.out;
}
