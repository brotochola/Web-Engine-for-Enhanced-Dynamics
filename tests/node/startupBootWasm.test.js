// SST-2 (SCENE_STARTUP_TIME_PLAN.md): engine.wasm is compiled once, on the page, and each worker binds its kernels on
// the WebAssembly.Module the page posts, instead of fetching and compiling its own. A worker that got none compiles
// its own, as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { compileWasmKernel, useEngineWasmModule } from '../../src/util/wasmKernel.js';
import { engineWasmUrl } from '../../src/wasm/engine.js';
import { takeLoadMarks } from '../../src/util/loadMarks.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import {
  coreComponentData,
  initWorker,
  loadWorker,
  postedMessages,
  quietly,
  spatialPublishBuffers,
} from '../bench/workerHarness.mjs';

const names = (marks) => marks.filter((_, i) => i % 2 === 0);

/** A spatial worker booted and initialized as the scene does, `engineWasm` in its boot (null: none). */
async function initSpatialWorker(engineWasm) {
  const first = await loadWorker('spatialWorker.js', 'spatialWorker');
  const worker = await quietly(() => new first.constructor(globalThis.self));
  const n = 64;
  const spatial = { worldWidth: 1024, worldHeight: 512, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 16, rowsPerBlock: 1 };
  bindEntityIdWidth(16);
  const { buffers, gridMetadata, mem } = spatialPublishBuffers(spatial, n, 1);
  buffers.componentData = coreComponentData(n);
  takeLoadMarks();
  postedMessages().length = 0;
  const config = { worldWidth: spatial.worldWidth, worldHeight: spatial.worldHeight, spatial, entityIdWidth: 16 };
  await quietly(() => worker.handleMessage({ data: { msg: 'boot', workerName: 'spatial0', config, engineWasm } }));
  await initWorker(worker, {
    config,
    globalEntityCount: n,
    buffers,
    gridMetadata,
    extra: { workerIndex: 0, totalSpatialWorkers: 1, spatialPublishMemory: mem.memory },
  });
  // Its marks went to the page with its ready message; any after it are still here.
  const ready = postedMessages().filter((m) => m.msg === 'workerReady').pop();
  return { worker, marks: names([...(ready?.loadMarks || []), ...takeLoadMarks()]) };
}

// First: nothing posted yet in this process.
test('a worker that got no module fetches and compiles its own, as before', async () => {
  const { worker, marks } = await initSpatialWorker(null);
  assert.ok(worker._wasmPub && worker._wasmGather, 'kernels bound');
  assert.ok(marks.includes('wasm fetch') && marks.includes('wasm compiled'), `its own compile: ${marks}`);
  assert.ok(!marks.includes('wasm module'), `nothing taken: ${marks}`);
});

test('useEngineWasmModule: the engine kernels come from the posted module, with no fetch or compile', async () => {
  const posted = await WebAssembly.compile(fs.readFileSync(engineWasmUrl));
  takeLoadMarks();
  assert.equal(useEngineWasmModule(null), false, 'no module: nothing taken');
  assert.equal(useEngineWasmModule({}), false, 'not a module: nothing taken');
  assert.equal(useEngineWasmModule(posted), true);
  assert.equal(await compileWasmKernel('spatialPublish', engineWasmUrl), posted, 'the posted module itself');
  assert.equal(await compileWasmKernel('gpuPack', String(engineWasmUrl)), posted, 'by its href too');
  const marks = names(takeLoadMarks());
  assert.ok(marks.includes('wasm module'));
  assert.ok(!marks.includes('wasm fetch') && !marks.includes('wasm compile'), `no compile of its own: ${marks}`);
});

test('a real spatial worker binds its kernels on the module the page posted', async () => {
  const posted = await WebAssembly.compile(fs.readFileSync(engineWasmUrl));
  const { worker, marks } = await initSpatialWorker(posted);
  assert.ok(worker._wasmPub && typeof worker._wasmPub.publish === 'function', 'publish bound');
  assert.ok(worker._wasmGather && typeof worker._wasmGather.gather === 'function', 'gather bound');
  assert.ok(marks.includes('wasm module'), `the module was taken: ${marks}`);
  assert.ok(!marks.includes('wasm fetch'), `no fetch of its own: ${marks}`);
  assert.ok(marks.indexOf('kernel spatialPublish') >= 0 && marks.indexOf('kernel spatialGather') >= 0, `${marks}`);
  assert.equal(await compileWasmKernel('spatialPublish', engineWasmUrl), posted);
});
