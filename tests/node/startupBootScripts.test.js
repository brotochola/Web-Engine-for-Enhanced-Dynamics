// SST-3 (SCENE_STARTUP_TIME_PLAN.md): a bundle's workers are blobs, which cannot import(). The page fetches the scene's
// script graph once (fetchScriptGraph: every file at once, each file's imports as it arrives) and posts { url → text }
// with 'boot'; each worker evaluates from those texts (orderBlobEntityScripts, loadEntityScripts' scriptTexts) in
// today's order (expandBlobEntityScripts: a DFS post-order, each file fetched in turn), with no fetch of its own.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandBlobEntityScripts,
  fetchScriptGraph,
  loadEntityScripts,
  orderBlobEntityScripts,
} from '../../src/util/utils.js';

const BASE = 'http://127.0.0.1/demos/graph/';

// Two entries; a shared dependency imported from four places; a cycle (b ↔ c); a file that does not load; an engine
// import, which is in the bundle and is not fetched. Each file logs its evaluation; b.js and extra.js extend a class at
// their top level, so an order that evaluated them before what they extend would need a retry.
const FILES = {
  'scene.js': `import { A } from './a.js';\nimport { B } from './b.js';\nimport { Scene } from '/src/index.js';\n` +
    `globalThis.__evalLog.push('scene');\nexport class GraphScene { static parts = [A, B]; }\n`,
  'a.js': `import { Shared } from './shared.js';\nimport { Gone } from './missing.js';\n` +
    `globalThis.__evalLog.push('a');\nexport class A { get s() { return Shared; } }\n`,
  'b.js': `import { Shared } from './shared.js';\nimport { C } from './c.js';\n` +
    `globalThis.__evalLog.push('b');\nexport class B extends Shared { get c() { return C; } }\n`,
  'c.js': `import { B } from './b.js';\nglobalThis.__evalLog.push('c');\nexport class C { get b() { return B; } }\n`,
  'shared.js': `globalThis.__evalLog.push('shared');\nexport class Shared {}\n`,
  'extra.js': `import { Shared } from './shared.js';\nimport { A } from './a.js';\n` +
    `globalThis.__evalLog.push('extra');\nexport class Extra extends Shared {}\n`,
};
const ENTRIES = [`${BASE}scene.js`, `${BASE}extra.js`];
const short = (urls) => urls.map((u) => u.slice(BASE.length));

/** A server for FILES (missing.js is a 404); `onFetch` sees each request. */
function server(onFetch = () => {}) {
  return async (url) => {
    onFetch(String(url));
    const name = String(url).slice(BASE.length);
    return name in FILES ? new Response(FILES[name], { status: 200 }) : new Response('not found', { status: 404 });
  };
}

test('the order from the page\'s texts is today\'s walk (a shared dependency, a cycle, a missing file)', async () => {
  const today = await expandBlobEntityScripts(ENTRIES, server());
  const texts = await fetchScriptGraph(ENTRIES, server());
  assert.deepEqual(short(orderBlobEntityScripts(ENTRIES, texts)), short(today));
  assert.deepEqual(short(today), ['shared.js', 'missing.js', 'a.js', 'c.js', 'b.js', 'scene.js', 'extra.js']);
  assert.deepEqual(Object.keys(texts).map((u) => u.slice(BASE.length)).sort(), ['a.js', 'b.js', 'c.js', 'extra.js', 'scene.js', 'shared.js']);
});

test('the page fetches each file once, the graph\'s files side by side', async () => {
  const fetched = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const serve = server((url) => fetched.push(url));
  const slow = async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return serve(url);
  };
  const texts = await fetchScriptGraph(ENTRIES, slow);
  assert.equal(new Set(fetched).size, fetched.length, `each once: ${short(fetched)}`);
  assert.deepEqual(short(fetched).sort(), ['a.js', 'b.js', 'c.js', 'extra.js', 'missing.js', 'scene.js', 'shared.js']);
  // The two entries together, then a.js and b.js together (and shared.js, c.js, missing.js) as scene.js arrives.
  assert.ok(maxInFlight >= 3, `in parallel: at most ${maxInFlight} at once`);
  assert.equal(Object.keys(texts).length, 6);
});

const EXPORTS = ['GraphScene', 'A', 'B', 'C', 'Shared', 'Extra'];

/**
 * loadEntityScripts in a bundled (blob) worker, whose global (self) the scripts' names resolve on: each file's
 * evaluation, in order, and the classes it registered there. Each run starts with none of them.
 */
async function evaluateInBlobWorker(fetchImpl, scriptTexts) {
  const saved = { self: globalThis.self, fetch: globalThis.fetch, location: globalThis.location };
  globalThis.self = globalThis;
  globalThis.location = { href: 'blob:http://127.0.0.1/0f0e' };
  globalThis.fetch = fetchImpl;
  globalThis.__evalLog = [];
  try {
    await loadEntityScripts(ENTRIES, globalThis, false, scriptTexts);
    const classes = Object.fromEntries(EXPORTS.map((name) => [name, globalThis[name]]));
    return { log: globalThis.__evalLog.slice(), ctx: classes };
  } finally {
    for (const name of EXPORTS) delete globalThis[name];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('a bundled worker evaluates from the texts in today\'s order, fetching only what the page could not', async () => {
  const today = await evaluateInBlobWorker(server(), null);
  const texts = await fetchScriptGraph(ENTRIES, server());
  const fetchedByWorker = [];
  const fromTexts = await evaluateInBlobWorker(server((url) => fetchedByWorker.push(url)), texts);
  assert.deepEqual(fromTexts.log, today.log);
  assert.deepEqual(today.log, ['shared', 'a', 'c', 'b', 'scene', 'extra']);
  for (const name of EXPORTS) {
    assert.equal(typeof fromTexts.ctx[name], 'function', `${name} registered`);
  }
  assert.ok(new fromTexts.ctx.B() instanceof fromTexts.ctx.Shared);
  // Only the file the page could not load is tried again (and fails again, as it did).
  assert.deepEqual(short([...new Set(fetchedByWorker)]), ['missing.js']);
});
