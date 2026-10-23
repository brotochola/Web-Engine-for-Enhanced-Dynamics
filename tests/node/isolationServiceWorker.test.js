import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// DX-SW, SW-3. weed-sw.js adds COOP and COEP to page loads and worker scripts, leaves everything
// else to the network, never touches opaque responses, and keeps no state between restarts.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'src/workers/isolationServiceWorker.js'), 'utf8');

/** Runs the worker's script in a fresh context, as the browser does on every restart. */
function startWorker(fetchImpl) {
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0 };
  const self = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: () => {
      calls.skipWaiting++;
      return Promise.resolve();
    },
    clients: {
      claim: () => {
        calls.claim++;
        return Promise.resolve();
      },
    },
  };
  vm.runInNewContext(source, { self, fetch: fetchImpl, Headers, Response });
  return { listeners, calls };
}

/** Dispatches a fetch event; resolves to the response handed to respondWith, or null if none. */
async function dispatchFetch(worker, request) {
  let responded = null;
  worker.listeners.fetch({
    request,
    respondWith: (p) => {
      responded = p;
    },
  });
  return responded === null ? null : await responded;
}

const okResponse = () => new Response('body', { status: 203, statusText: 'Fine', headers: { 'Content-Type': 'text/html', 'X-Kept': '1' } });

test('a page load and a worker script get the isolation headers, status and body unchanged', async () => {
  const worker = startWorker(async () => okResponse());
  for (const request of [
    { mode: 'navigate', destination: 'document', cache: 'default' },
    { mode: 'same-origin', destination: 'worker', cache: 'default' },
    { mode: 'same-origin', destination: 'sharedworker', cache: 'default' },
  ]) {
    const res = await dispatchFetch(worker, request);
    assert.ok(res, request.destination);
    assert.equal(res.status, 203);
    assert.equal(res.statusText, 'Fine');
    assert.equal(await res.text(), 'body');
    assert.equal(res.headers.get('x-kept'), '1');
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  }
});

test('images, scripts, WASM and other requests go to the network untouched', async () => {
  let fetched = 0;
  const worker = startWorker(async () => {
    fetched++;
    return okResponse();
  });
  for (const destination of ['image', 'script', 'audio', 'font', 'style', '']) {
    assert.equal(await dispatchFetch(worker, { mode: 'cors', destination, cache: 'default' }), null, destination);
  }
  assert.equal(fetched, 0);
});

test('opaque responses pass through untouched, and DevTools only-if-cached requests are skipped', async () => {
  const opaque = { status: 0, type: 'opaqueredirect' };
  const worker = startWorker(async () => opaque);
  assert.equal(await dispatchFetch(worker, { mode: 'navigate', destination: 'document', cache: 'default' }), opaque);
  assert.equal(await dispatchFetch(worker, { mode: 'no-cors', destination: 'worker', cache: 'only-if-cached' }), null);
});

test('install skips waiting, activate claims the open pages, and a restart behaves the same', async () => {
  for (let run = 0; run < 2; run++) {
    const worker = startWorker(async () => okResponse());
    worker.listeners.install({});
    let waited = null;
    worker.listeners.activate({ waitUntil: (p) => { waited = p; } });
    await waited;
    assert.deepEqual(worker.calls, { skipWaiting: 1, claim: 1 });
    const res = await dispatchFetch(worker, { mode: 'navigate', destination: 'document', cache: 'default' });
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  }
});

// DEPLOY.md's self-removing weed-sw.js: what a game deploys once its host sends the headers. It
// must unregister and reload the pages it controlled (guide examples have to run).
test("the guide's self-removing weed-sw.js unregisters and reloads its pages", async () => {
  const guide = readFileSync(join(root, 'docs/guide/DEPLOY.md'), 'utf8');
  const block = /```js\n(\/\/ weed-sw\.js that removes itself\n[\s\S]*?)```/.exec(guide);
  assert.ok(block, 'the snippet is in DEPLOY.md');
  const listeners = {};
  const done = { skipWaiting: 0, unregister: 0, navigated: [] };
  const pages = ['https://game.test/a.html', 'https://game.test/b.html'].map((url) => ({
    url,
    navigate: async (to) => done.navigated.push(to),
  }));
  const self = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: () => {
      done.skipWaiting++;
    },
    registration: { unregister: async () => (done.unregister++, true) },
    // opts comes from the vm's realm: compare the field, not the object.
    clients: { matchAll: async (opts) => (assert.equal(opts.type, 'window'), pages) },
  };
  vm.runInNewContext(block[1], { self });
  listeners.install({});
  let waited = null;
  listeners.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.deepEqual(done, { skipWaiting: 1, unregister: 1, navigated: pages.map((p) => p.url) });
});
