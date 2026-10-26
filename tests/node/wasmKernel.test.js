import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { compileWasmKernel, loadWasmKernel } from '../../src/util/wasmKernel.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';

// E-76 T5: the shared kernel loader links env.memory and nothing else, compiles each module once,
// and loads from a file URL (Node), a data URL (the bundle: gzipped) or fetch (the browser).

const SHIPPED = new URL('../../src/wasm/engine.wasm', import.meta.url);
const EMCC = new URL('../fixtures/spatialPublish.emcc.wasm', import.meta.url);

test('loadWasmKernel links the shipped spatial module from a file URL and a data URL', async () => {
  const mem = createSpatialPublishMemory(64, 4, 1);
  const fromFile = await loadWasmKernel('spatialPublish', SHIPPED, mem.memory, ['publish_batch']);
  assert.equal(typeof fromFile.publish_batch, 'function');
  const dataUrl = `data:application/wasm;base64,${fs.readFileSync(SHIPPED).toString('base64')}`;
  const fromData = await loadWasmKernel('spatialPublish', dataUrl, mem.memory, ['publish_batch']);
  assert.equal(typeof fromData.publish_batch, 'function');
  assert.equal(compileWasmKernel('spatialPublish', SHIPPED), compileWasmKernel('spatialPublish', SHIPPED), 'compiled once');
});

test('loadWasmKernel inflates a gzipped data URL (the bundle embeds the kernels so), to the committed module', async () => {
  const bytes = fs.readFileSync(SHIPPED);
  const gzipUrl = `data:application/gzip;base64,${zlib.gzipSync(bytes, { level: 9 }).toString('base64')}`;
  const module = await compileWasmKernel('spatialPublish', gzipUrl);
  assert.deepEqual(WebAssembly.Module.exports(module), WebAssembly.Module.exports(await WebAssembly.compile(bytes)));
  const mem = createSpatialPublishMemory(64, 4, 1);
  const fromGzip = await loadWasmKernel('spatialPublish', gzipUrl, mem.memory, ['publish_batch']);
  assert.equal(typeof fromGzip.publish_batch, 'function');
  // A payload that is not gzip names the kernel.
  const notGzip = `data:application/gzip;base64,${bytes.toString('base64')}`;
  await assert.rejects(loadWasmKernel('notGzip', notGzip, mem.memory, ['publish_batch']), /^Error: notGzip\.wasm: /);
});

test('loadWasmKernel refuses a module with other imports, and a missing export', async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  await assert.rejects(
    loadWasmKernel('spatialPublishEmcc', EMCC, memory, ['publish_batch']),
    /imports wasi_snapshot_preview1\.\w+ \(function\); a kernel may import only env\.memory/,
  );
  await assert.rejects(loadWasmKernel('spatialPublish', SHIPPED, memory, ['nope']), /no function export nope/);
  await assert.rejects(loadWasmKernel('missing', pathToFileURL('missing.wasm'), memory, []), /^Error: missing\.wasm: .*ENOENT/);
});

test('a kernel that does not compile or link names itself', async () => {
  const shared = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const garbage = `data:application/wasm;base64,${Buffer.from('not a module').toString('base64')}`;
  await assert.rejects(loadWasmKernel('garbage', garbage, shared, []), /^Error: garbage\.wasm: /);
  // The shipped module imports a shared memory: an unshared one does not link.
  const unshared = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  await assert.rejects(loadWasmKernel('spatialPublish', SHIPPED, unshared, ['publish_batch']), /^Error: spatialPublish\.wasm: /);
});

test('the spatial worker binds the publish module through the loader', async () => {
  // Two workers on the publish memory as the scene lays it out (spatialWorkerMicrobench's setup).
  const { setupSpatialKernel } = await import('../bench/spatialWorkerMicrobench.mjs');
  const k = await setupSpatialKernel({ n: 256, workers: 2, spatial: { worldWidth: 2048, worldHeight: 1024, maxEntitiesPerCell: 16, maxNeighbors: 8 } });
  const mem = k.mem;
  const worker = k.workers[1];
  assert.ok(worker._wasmPub, 'WASM publish bound');
  assert.equal(worker._wasmPub.listByte, mem.listByte + mem.listStride, 'worker 1 owns the second list slice');
  assert.equal(worker._neighborCandidateData.buffer, mem.buffer, 'candidates live in the publish memory');
});
