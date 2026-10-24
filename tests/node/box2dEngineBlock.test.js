import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderQueueMemory, renderQueueMemoryBytes } from '../../src/util/renderQueueMemory.js';
import { box2dBlockPlan } from '../../src/util/box2dEngineBlock.js';
import { box2dMemoryPages } from '../../src/box2d/box2dMemory.js';

// Phase 4: with physics on, the render-queue regions are laid in a block of Box2D's memory. These check the
// two halves that do not need a browser: the regions placed in a given memory at a byte, and the plan that sizes
// the block and Box2D's memory before any buffer exists.

const ARGS = [500, 500 * 64, 4096, null, null, null, false, null];

test('the render-queue regions sit in a given memory from its byte, every region shifted by it', () => {
  const own = createRenderQueueMemory(...ARGS);
  const bytes = renderQueueMemoryBytes(...ARGS);
  assert.ok(bytes > 0);
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64, shared: true });
  const base = 65536 * 3;
  const placed = createRenderQueueMemory(...ARGS, { memory, baseByte: base });
  assert.ok(placed);
  assert.equal(placed.memory, memory);
  assert.equal(placed.buffer, memory.buffer);
  for (const key of ['queueAByte', 'queueBByte', 'gpuAByte', 'gpuBByte', 'indexByte', 'inverseByte', 'tableByte', 'particlesByte']) {
    assert.equal(placed.layout[key], own.layout[key] + base, key);
  }
  assert.equal(createRenderQueueMemory(...ARGS, { memory, baseByte: base + 8 }), null, 'an unaligned byte is refused');
  const small = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.equal(createRenderQueueMemory(...ARGS, { memory: small, baseByte: 0 }), null, 'a block too small is refused');
});

test('the block plan: physics on and the switch on, Box2D grown by the block', () => {
  const scene = (over = {}) => ({
    _physicsEnabled: true,
    totalEntityCount: 1000,
    componentPools: {},
    config: {
      physics: { wasmMemoryMB: 64 },
      wasm: {},
      renderer: { maxVisibleRenderables: 500 },
      lighting: { enabled: false, shadowsEnabled: false },
      decoration: { maxDecorations: 0 },
      particle: {},
      preRender: {},
      ...over,
    },
  });
  const plan = box2dBlockPlan(scene());
  assert.ok(plan && plan.bytes > 0);
  assert.ok(plan.pages > box2dMemoryPages({ wasmMemoryMB: 64 }));
  assert.ok((plan.pages - box2dMemoryPages({ wasmMemoryMB: 64 })) * 65536 >= plan.bytes, 'the pages hold the block');
  assert.equal(box2dBlockPlan({ ...scene(), _physicsEnabled: false }), null, 'no physics, no block');
  assert.equal(box2dBlockPlan(scene({ wasm: { box2dBlock: false } })), null, 'the switch off');
  assert.equal(box2dBlockPlan(scene({ physics: { wasmMemoryMB: 2048 } })), null, 'past 2 GB the memories stay apart');
});
