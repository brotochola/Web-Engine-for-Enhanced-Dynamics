// SST-2 (SCENE_STARTUP_TIME_PLAN.md), the page's side: compileEngineWasm compiles engine.wasm once a page, from its
// file in source builds (streamed when the server says application/wasm) and from the data URL a bundle inlined in its
// workers' code, and resolves to null where it cannot (the workers then compile their own).
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

test('bundle: the gzipped data URL inlined in the workers\' common code, inflated once and compiled', async () => {
  const gz = zlib.gzipSync(bytes, { level: 9 }).toString('base64');
  let ensured = 0;
  const WEED = {
    BUNDLE_MODE: true,
    ensureEmbeddedSources: async () => {
      ensured++;
    },
    // As scripts/buildBundle.js leaves it: the URL as a string literal in a minified worker chunk.
    WorkerCommonSource: `var a=1;const u=new URL("data:application/gzip;base64,${gz}",self.location.href);export{u};`,
    WorkerSources: { spatialWorker: 'importScripts(x)' },
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

test('bundle: WEED.EngineWasmUrl, when the bundle names it, is used as is', async () => {
  const gz = zlib.gzipSync(bytes).toString('base64');
  const WEED = { BUNDLE_MODE: true, EngineWasmUrl: `data:application/gzip;base64,${gz}`, WorkerCommonSource: '' };
  const page = await onPage({ location: { origin: 'http://h' }, WEED }, async () => {
    throw new Error('no fetch');
  });
  assert.deepEqual(WebAssembly.Module.exports(await page.compileEngineWasm()), engineExports);
});

test('no page (a worker, Node): null at once', async () => {
  const page = await import(`../../src/util/sceneWorkerBootstrap.js?page=${++instance}`);
  assert.equal(await page.compileEngineWasm(), null);
});
