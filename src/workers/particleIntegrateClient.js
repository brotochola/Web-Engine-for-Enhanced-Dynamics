// The WASM particle integrate (E-79): loads particleIntegrate.wasm onto the particle memory and
// runs updateParticlePhysicsBuffers' work in it. What JS did around the loop stays here: the dead
// list goes back to the pool in the order JS returned it (the free list's order decides later
// allocations), and an angle past fdlibm's medium reduction gets Math.cos / Math.sin.

import { ParticleEmitter } from '../core/particleEmitter.js';
import { PARTICLE_LUT_ENTRIES } from '../util/particleMemory.js';
import { expoLutTables } from '../util/particleTween.js';
import { loadWasmKernel } from '../util/wasmKernel.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./particleIntegrate.wasm', import.meta.url);

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
 */
export async function bindParticleIntegrate(memory, layout, pc, maxParticles) {
  const { integrate_batch: integrate } = await loadWasmKernel('particleIntegrate', wasmUrl, memory, ['integrate_batch']);
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
  return {
    integrate,
    layout,
    lutSize: PARTICLE_LUT_ENTRIES - 1,
    indices: new Uint16Array(buffer, layout.indicesByte, n),
    stamp: new Uint16Array(buffer, layout.stampByte, n),
    dead: new Uint16Array(buffer, layout.deadByte, n),
    trig: new Uint16Array(buffer, layout.trigByte, n),
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
