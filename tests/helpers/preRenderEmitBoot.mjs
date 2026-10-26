// A pre-render worker booted as a scene boots it since the emit runs only in preRenderEmit.wasm (close-out group B): the
// render queue, SpriteRenderer and the emit's state in a render-queue memory, the texture metadata in the kernel's
// tables. For tests that drive pre-render's emit end to end (collectRenderable, buildRenderQueue) on a few entities.
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { createParticleMemory, particleMemoryBytes } from '../../src/util/particleMemory.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';

/**
 * One sheet (id 1) with one animation of `frames` frames, textures 0 … frames-1 of `size` pixels: a row's texture is
 * its frame.
 */
export function oneAnimationMetadata(frames, size = 16) {
  return {
    animationFrameStart: [0],
    animationFrameCount: [frames],
    proxyToGlobalAnim: { 1: { 0: 0 } },
    animationNameToIndex: {},
    frameWidth: new Uint16Array(frames).fill(size),
    frameHeight: new Uint16Array(frames).fill(size),
  };
}

/**
 * @param {number} entities
 * @param {{ maxItems?: number, textureMetadata?: object, config?: object, adobe?: boolean, particles?: number, extra?: object }} [opts]
 *   `adobe`: the Adobe regions too (AdobeAnimComponent, the collector's pose stash, the asset tables), as a scene with Adobe
 *   characters has them; `particles`: a pool of that many particles in the particle memory placed in this one; `extra`:
 *   more of the init payload (the particle lists, say)
 * @returns {Promise<{ worker: object, m: object }>} the worker (its kernel bound) and the memory
 */
export async function bootEmitWorker(entities, {
  maxItems = 8, textureMetadata = oneAnimationMetadata(1), config = {}, adobe = false, particles = 0, extra = {},
} = {}) {
  const caps = gpuQueueCaps(maxItems, { enabled: false });
  const m = createRenderQueueMemory(maxItems, computeBufferSize(maxItems), computeGpuQueueBufferSize(caps), {
    entities,
    spriteBytes: SpriteRenderer.getBufferSize(entities),
    casterBytes: 0,
    decorationBytes: 0,
    adobe: adobe ? { animBytes: AdobeAnimComponent.getBufferSize(entities), tableBytes: 1 << 16 } : null,
    particleBytes: particles > 0 ? particleMemoryBytes(particles, ParticleComponent.getBufferSize(particles)) : 0,
  });
  const e = m.layout.emit;
  const pm = particles > 0
    ? createParticleMemory(particles, ParticleComponent.getBufferSize(particles), { memory: m.memory, baseByte: e.particleMemoryByte, bytes: e.particleMemoryBytes })
    : null;
  SpriteRenderer.clearArrays();
  AdobeAnimComponent.clearArrays();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: { worldWidth: 1000, worldHeight: 1000, preRender: { interpolation: false }, ...config },
    globalEntityCount: entities,
    buffers: {
      componentData: {
        ...coreComponentData(entities), SpriteRenderer: m.buffer,
        ...(adobe ? { AdobeAnimComponent: m.buffer } : {}), ...(pm ? { ParticleComponent: m.buffer } : {}),
      },
      componentDataByte: {
        SpriteRenderer: e.spriteRendererByte,
        ...(adobe ? { AdobeAnimComponent: e.adobeAnimByte } : {}), ...(pm ? { ParticleComponent: pm.layout.componentByte } : {}),
      },
    },
    extra: {
      ...(pm ? { maxParticles: particles } : {}),
      ...extra,
      textureMetadata,
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: m.buffer,
        entityTextureByte: e.lastTextureByte,
      },
    },
  });
  bindPoseColumns(entities);
  if (!worker._emitWasm || !worker._emitWasm.texturesReady) throw new Error('bootEmitWorker: the emit kernel did not bind');
  return { worker, m };
}

/** Count the persist hits (persist_frame calls that kept the rows) of the worker's kernel. */
export function countPersistHits(worker) {
  const b = worker._emitWasm;
  const real = b.persistFrame;
  const counter = { hits: 0, restore: () => { b.persistFrame = real; } };
  b.persistFrame = (...args) => {
    const got = real(...args);
    if (got !== -1) counter.hits++;
    return got;
  };
  return counter;
}
