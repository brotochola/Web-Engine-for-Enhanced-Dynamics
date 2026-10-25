import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker } from '../helpers/preRenderEmitBoot.mjs';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { Layer } from '../../src/core/layer.js';

// B29 (renderOnly ghost rows). A renderOnly particle is drawn by its compute
// layer, so the sprite emit skipped it, but only after reserving its queue row.
// The published count included that row, and Pixi drew whatever the buffer held
// there from an older frame. The particle is now left out at collect.

const N = 4;
const NP = 3;


test('a renderOnly particle takes no render queue row', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const visible = new SharedArrayBuffer(2 * (NP + 1));
    const { worker: w } = await bootEmitWorker(N, { particles: NP, extra: { visibleParticlesData: visible } });

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
      w._renderableCount = 0;
      w._bindCollectPoses(); // as each frame does before its collect
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
