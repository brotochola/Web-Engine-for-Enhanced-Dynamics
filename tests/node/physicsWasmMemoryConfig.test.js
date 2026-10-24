import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHYSICS_DEFAULTS,
  BOX2D_MEMORY_MB_MIN,
  BOX2D_MEMORY_MB_MAX,
  box2dMemoryPages,
} from '../../src/util/configDefaults.js';
import { createPhysicsWorker } from '../../src/util/sceneWorkerBootstrap.js';

// BM-7 (docs/internal/BOX2D_MEMORY_PLAN.md). physics.wasmMemoryMB sizes Box2D's memory; the
// physics worker's name carries it as pages of 64 KB, which the glue's pre-js reads before any
// message can arrive.

test('the default is 512 MB, the size Box2D always had', () => {
  assert.equal(PHYSICS_DEFAULTS.wasmMemoryMB, 512);
  assert.equal(box2dMemoryPages(PHYSICS_DEFAULTS), 8192);
  assert.equal(box2dMemoryPages(undefined), 8192);
  assert.equal(box2dMemoryPages({}), 8192);
});

test('whole megabytes become 16 pages each, inside 16..2048 MB', () => {
  assert.equal(BOX2D_MEMORY_MB_MIN, 16);
  assert.equal(BOX2D_MEMORY_MB_MAX, 2048);
  assert.equal(box2dMemoryPages({ wasmMemoryMB: 64 }), 1024);
  assert.equal(box2dMemoryPages({ wasmMemoryMB: 16 }), 256);
  assert.equal(box2dMemoryPages({ wasmMemoryMB: 2048 }), 32768);
});

test('a size out of range or not whole is clamped and rounded, with one warning', () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(box2dMemoryPages({ wasmMemoryMB: 8 }), 256);
    assert.equal(box2dMemoryPages({ wasmMemoryMB: 4096 }), 32768);
    assert.equal(box2dMemoryPages({ wasmMemoryMB: 100.4 }), 1600);
    assert.equal(box2dMemoryPages({ wasmMemoryMB: 'lots' }), 8192);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /physics\.wasmMemoryMB 8 is not a whole number of MB in 16\.\.2048; using 16/);
});

test('the physics worker is created with its size in its name, on the src and the bundle URL', () => {
  const OriginalWorker = globalThis.Worker;
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const created = [];
  globalThis.Worker = class {
    constructor(url, options) {
      created.push({ url, options });
    }
  };
  globalThis.window = { WEED: { getBox2dWorkerUrl: () => 'blob:weed/box2d' } };
  try {
    createPhysicsWorker(false, '?v=1', { wasmMemoryMB: 64 });
    createPhysicsWorker(true, '', { wasmMemoryMB: 128 });
  } finally {
    globalThis.Worker = OriginalWorker;
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
  }
  assert.deepEqual(created, [
    { url: '/src/box2d/box2dWasm.js?v=1', options: { name: 'physics pages=1024' } },
    { url: 'blob:weed/box2d', options: { name: 'physics pages=2048' } },
  ]);
});
