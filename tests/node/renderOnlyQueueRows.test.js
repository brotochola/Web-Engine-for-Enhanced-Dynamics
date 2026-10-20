import test from 'node:test';
import assert from 'node:assert/strict';

import { coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { Layer } from '../../src/core/layer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';

// B29 (renderOnly ghost rows). A renderOnly particle is drawn by its compute
// layer, so the sprite emit skipped it, but only after reserving its queue row.
// The published count included that row, and Pixi drew whatever the buffer held
// there from an older frame. The particle is now left out at collect.

const N = 4;
const NP = 3;

function renderQueuePayload(maxItems) {
  const bytes = computeBufferSize(maxItems);
  return {
    maxItems,
    sync: new SharedArrayBuffer(8),
    dataA: new SharedArrayBuffer(bytes),
    dataB: new SharedArrayBuffer(bytes),
    cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
    cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
    entityTextureData: new SharedArrayBuffer(maxItems * 2),
  };
}

test('a renderOnly particle takes no render queue row', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const buffers = { componentData: coreComponentData(N) };
    buffers.componentData.ParticleComponent = new SharedArrayBuffer(ParticleComponent.getBufferSize(NP));
    const visible = new SharedArrayBuffer(2 * (NP + 1));
    await initWorker(w, {
      config: { worldWidth: 1000, worldHeight: 1000, preRender: { interpolation: false } },
      globalEntityCount: N,
      buffers,
      extra: { renderQueue: renderQueuePayload(8), maxParticles: NP, visibleParticlesData: visible },
    });

    const entities = Layer.entitiesMask();
    for (let i = 0; i < NP; i++) {
      ParticleComponent.active[i] = 1;
      ParticleComponent.x[i] = 100 + i * 10;
      ParticleComponent.y[i] = 50;
      ParticleComponent.scaleX[i] = 1;
      ParticleComponent.scaleY[i] = 1;
      ParticleComponent.alpha[i] = 1;
      ParticleComponent.layerMask[i] = entities;
    }
    ParticleComponent.renderOnly[0] = 1;
    Atomics.store(ParticleComponent.renderOnlyLive, 0, 1);
    new Uint16Array(visible).set([NP, 0, 1, 2]);

    // Two frames fill both queue buffers with a stale marker first.
    for (let f = 0; f < 2; f++) {
      w.renderQueueX.fill(-999);
      w.collectVisibleParticles();
      w.buildRenderQueue(16);
      const count = w.renderQueueCount[0];
      const xs = Array.from(w.renderQueueX.subarray(0, count)).sort((a, b) => a - b);
      assert.deepEqual(xs, [110, 120], `frame ${f}: only the two sprite particles, no stale row`);
      w._queueBuf ^= 1;
    }
  } finally {
    Layer.reset();
  }
});
