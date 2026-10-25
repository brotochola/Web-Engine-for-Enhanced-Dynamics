/**
 * The shipped Box2D build takes its memory from the engine (BM-5, docs/internal/BOX2D_MEMORY_PLAN.md):
 * the module imports a shared memory of 256 to 32768 pages, and the glue's pre-js
 * (weedjs/weed_pre.js in the sibling build) creates it from the physics worker's name with
 * initial === maximum, so it never grows. Not a speed claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readWasmStructure } from '../../scripts/wasmKernelRules.mjs';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BOX2D_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/box2d');
const glue = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.js'), 'utf8');

test('the module imports one shared memory of 256 to 32768 pages', () => {
  const { imports } = readWasmStructure(fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.wasm')));
  const memories = imports.filter((i) => i.kind === 'memory');
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].limits, { min: 256, max: 32768, shared: true, memory64: false });
});

test('a 64 MB memory links, and a world boots and steps in it', () => {
  const { memory, fn } = instantiateBox2dWasm(['create_world', 'weedjs_memory_peak_bytes'], { pages: 1024 });
  assert.equal(memory.buffer.byteLength, 64 * 1024 * 1024);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  const slot = fn('create_body_box')(
    worldId, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, -1,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  fn('step_world')(worldId, 1 / 60, 4);
  const peak = fn('weedjs_memory_peak_bytes')() >>> 0;
  assert.ok(peak > 0 && peak <= memory.buffer.byteLength, `peak ${peak}`);
});

// The glue from its first line through the pre-js, run as a worker would run it, with a fake
// WebAssembly.Memory that records what it was asked for (nothing is committed).
const preJsEnd = /\/\/ end include: [^\n]*weed_pre\.js/.exec(glue);
function runGlueHead(workerName, { memoryThrows = false } = {}) {
  assert.ok(preJsEnd, 'the glue has no weed_pre.js block - rebuild with weedjs\\build_for_weed.bat');
  const created = [];
  class FakeMemory {
    constructor(descriptor) {
      if (memoryThrows) throw new RangeError('WebAssembly.Memory(): could not allocate memory');
      // A copy made in this realm: the vm context has its own Object.prototype.
      this.descriptor = { ...descriptor };
      created.push(this.descriptor);
    }
  }
  const context = vm.createContext({
    name: workerName,
    WorkerGlobalScope: function WorkerGlobalScope() {},
    WebAssembly: { Memory: FakeMemory },
  });
  vm.runInContext(glue.slice(0, preJsEnd.index), context);
  return { created, Module: context.Module };
}

test('the pre-js sizes the memory from the worker name, initial === maximum', () => {
  const { created, Module } = runGlueHead('physics pages=1024');
  assert.deepEqual(created, [{ initial: 1024, maximum: 1024, shared: true }]);
  assert.equal(Module.wasmMemory.descriptor, created[0]);
  assert.deepEqual(runGlueHead('').created, [{ initial: 8192, maximum: 8192, shared: true }]);
  // createPhysicsWorker's name since the out-of-memory message names the set size: pages= is still the memory.
  assert.deepEqual(runGlueHead('physics pages=768 mb=16').created, [{ initial: 768, maximum: 768, shared: true }]);
});

test('pthread helpers create no memory (they receive the main one)', () => {
  const { created, Module } = runGlueHead('em-pthread');
  assert.equal(created.length, 0);
  assert.equal(Module.wasmMemory, undefined);
});

test('a size out of range, or a memory the browser refuses, stops the worker with the key named', () => {
  assert.throws(() => runGlueHead('physics pages=100'), /100 pages is outside 256\.\.32768 \(physics\.wasmMemoryMB/);
  assert.throws(() => runGlueHead('physics pages=40000'), /outside 256\.\.32768/);
  assert.throws(
    () => runGlueHead('physics pages=1024', { memoryThrows: true }),
    /could not reserve 64 MB \(physics\.wasmMemoryMB\)/,
  );
});

test('the glue takes Module.wasmMemory, and running out aborts with "OOM" instead of returning NULL', () => {
  assert.match(glue, /if \(Module\["wasmMemory"\]\) \{\s*wasmMemory = Module\["wasmMemory"\];/);
  assert.match(glue, /var abortOnCannotGrowMemory = requestedSize => \{\s*abort\("OOM"\);/);
  const resize = glue.slice(glue.indexOf('var _emscripten_resize_heap'));
  assert.match(resize.slice(0, resize.indexOf('\n};')), /abortOnCannotGrowMemory\(requestedSize\);\s*$/);
});
