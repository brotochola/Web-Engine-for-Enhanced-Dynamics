// SST-2 (SCENE_STARTUP_TIME_PLAN.md), the page's side: compileEngineWasm compiles engine.wasm once a page, from its
// file in source builds (streamed when the server says application/wasm) and from WEED.EngineWasmUrl in a bundle (the
// data URL its workers carry, or the file mode's file), and resolves to null where it cannot (the workers then compile
// their own).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { engineWasmUrl } from '../../src/wasm/engine.js';

// The page module's own imports, loaded once without a page (as other tests import it).
await import('../../src/util/sceneWorkerBootstrap.js');

const bytes = fs.readFileSync(engineWasmUrl);
const engineExports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));

let instance = 0;
/** A fresh copy of the page module (its compile is once a page), on a fake page. */
async function onPage(window, fetchImpl) {
  globalThis.window = window;
  globalThis.fetch = fetchImpl;
  return import(`../../src/util/sceneWorkerBootstrap.js?page=${++instance}`);
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  delete globalThis.window;
  globalThis.fetch = realFetch;
});

test('source build: engine.wasm fetched once from /src/wasm and compiled; once a page', async () => {
  const urls = [];
  const page = await onPage({ location: { origin: 'http://127.0.0.1:8080' } }, async (url) => {
    urls.push(String(url));
    return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
  });
  const module = await page.compileEngineWasm();
  assert.ok(module instanceof WebAssembly.Module);
  assert.deepEqual(WebAssembly.Module.exports(module), engineExports);
  assert.deepEqual(urls, ['http://127.0.0.1:8080/src/wasm/engine.wasm']);
  assert.equal(await page.compileEngineWasm(), module, 'the same module for the next scene');
  assert.equal(urls.length, 1, 'no second fetch');
});

test('source build: a server that does not say application/wasm still gets it compiled (no streaming)', async () => {
  const page = await onPage({ location: { origin: 'http://h' } }, async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  const module = await page.compileEngineWasm();
  assert.deepEqual(WebAssembly.Module.exports(module), engineExports);
});

test('a missing file resolves to null (each worker compiles its own), with a warning', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const page = await onPage({ location: { origin: 'http://h' } }, async () => new Response('nope', { status: 404 }));
    assert.equal(await page.compileEngineWasm(), null);
    assert.equal(warned.length, 1);
  } finally {
    console.warn = warn;
  }
});

test('single-file bundle: WEED.EngineWasmUrl, the gzipped data URL its workers carry, inflated once and compiled', async () => {
  const gz = zlib.gzipSync(bytes, { level: 9 }).toString('base64');
  let ensured = 0;
  const WEED = {
    BUNDLE_MODE: true,
    ensureEmbeddedSources: async () => {
      ensured++;
    },
    // scripts/buildBundle.js reads it from the workers' common code (startupBundleEngineWasmUrl.test.js).
    EngineWasmUrl: `data:application/gzip;base64,${gz}`,
  };
  const fetched = [];
  const page = await onPage({ location: { origin: 'http://h' }, WEED }, async (url) => {
    fetched.push(url);
    throw new Error('the bundle fetches nothing');
  });
  const module = await page.compileEngineWasm();
  assert.ok(module instanceof WebAssembly.Module);
  assert.deepEqual(WebAssembly.Module.exports(module), engineExports);
  assert.equal(ensured, 1, 'the embedded sources inflated first');
  assert.deepEqual(fetched, []);
});

test("the bundle's file mode (SST-8): engine.wasm's file beside the bundle, streamed once", async () => {
  const url = 'http://h/dist/files/prod-0123456789/0a1b2c.wasm';
  const WEED = { BUNDLE_MODE: true, BUNDLE_WORKER_FILES: true, ensureEmbeddedSources: async () => {}, EngineWasmUrl: url };
  const fetched = [];
  const page = await onPage({ location: { origin: 'http://h' }, WEED }, async (u) => {
    fetched.push(String(u));
    return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
  });
  assert.deepEqual(WebAssembly.Module.exports(await page.compileEngineWasm()), engineExports);
  assert.deepEqual(fetched, [url]);
});

test('a bundle that names no engine.wasm: null (each worker compiles its own)', async () => {
  const page = await onPage({ location: { origin: 'http://h' }, WEED: { BUNDLE_MODE: true } }, async () => {
    throw new Error('no fetch');
  });
  assert.equal(await page.compileEngineWasm(), null);
});

test('no page (a worker, Node): null at once', async () => {
  const page = await import(`../../src/util/sceneWorkerBootstrap.js?page=${++instance}`);
  assert.equal(await page.compileEngineWasm(), null);
});
