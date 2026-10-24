// E-112 (W4a): with the emit regions in the render-queue memory, pre-render keeps the emit's state
// there (its collector, the animation frame and clock, the texture each entity last drew), where the
// emit kernel reads it, and SpriteRenderer is bound in its block.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const N = 2000;
const MAX = 3000;

function emitMemory(entities) {
  const caps = gpuQueueCaps(MAX, { enabled: false });
  return createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), {
    entities,
    spriteBytes: SpriteRenderer.getBufferSize(entities),
    casterBytes: 0,
    decorationBytes: 0,
  });
}

async function boot(m) {
  const e = m.layout.emit;
  const buffers = { componentData: coreComponentData(N), componentDataByte: {} };
  if (e.entities === N) {
    buffers.componentData.SpriteRenderer = m.buffer;
    buffers.componentDataByte.SpriteRenderer = e.spriteRendererByte;
  }
  SpriteRenderer.clearArrays();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: { worldWidth: 2000, worldHeight: 1000, preRender: { interpolation: false } },
    globalEntityCount: N,
    buffers,
    extra: {
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems: MAX,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: e.entities === N ? m.buffer : new SharedArrayBuffer(N * 2),
        entityTextureByte: e.entities === N ? e.lastTextureByte : 0,
      },
    },
  });
  return worker;
}

test('pre-render views its collector, animation state and texture cache in the emit regions', async () => {
  const m = emitMemory(N);
  const e = m.layout.emit;
  const worker = await boot(m);
  for (const [name, view, byte] of [
    ['collector type', worker._renderableType, e.collectorTypeByte],
    ['collector index', worker._renderableIndex, e.collectorIndexByte],
    ['collector y', worker._renderableY, e.collectorYByte],
    ['frame', worker.entityFrameIndex, e.frameByte],
    ['clock', worker.entityFrameAccumulator, e.accumByte],
    ['last texture', worker.entityLastTextureId, e.lastTextureByte],
  ]) {
    assert.equal(view.buffer, m.buffer, `${name} in the memory`);
    assert.equal(view.byteOffset, byte, `${name} at its region`);
  }
  assert.equal(worker._renderableType.length, MAX);
  assert.equal(worker.entityFrameIndex.length, N);
  assert.equal(worker.entityLastTextureId.length, N);
  assert.ok(worker.entityLastTextureId.every((t) => t === 0xffff), 'the texture cache starts invalid');
  assert.equal(SpriteRenderer.active.buffer, m.buffer);
  assert.equal(SpriteRenderer.active.byteOffset, e.spriteRendererByte);
});

test('an emit layout for another entity count is not used', async () => {
  const m = emitMemory(N + 1);
  const worker = await boot(m);
  assert.notEqual(worker._renderableType.buffer, m.buffer);
  assert.notEqual(worker.entityFrameIndex.buffer, m.buffer);
  assert.equal(worker.entityFrameIndex.length, N);
});
