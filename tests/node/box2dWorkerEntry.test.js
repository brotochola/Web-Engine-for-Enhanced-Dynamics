import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// SST-12: a source build's physics worker entry (src/box2d/box2dWorkerEntry.js), run as shipped in a stand-in worker
// scope: it fetches the glue, weedjsPost.js and the host at once and the siblings weedjsPost.js names as soon as it is in,
// runs them in the glue's order from blob URLs, and hands the messages that came meanwhile to the host in order. A
// pthread pool worker loads the glue directly; a fetch that fails falls back to the glue's own importScripts.

const ENTRY = readFileSync(fileURLToPath(new URL('../../src/box2d/box2dWorkerEntry.js', import.meta.url)), 'utf8');
const BASE = 'http://game.test/src/box2d/';

const SCRIPTS = {
  'box2dWasm.js': "self.ran.push('glue'); importScripts('weedjsPost.js'); importScripts('physicsHostImpl.js');",
  'weedjsPost.js': "importScripts(\n  'one.js',\n  'two.js',\n);\nself.ran.push('post');",
  'one.js': "self.ran.push('one');",
  'two.js': "self.ran.push('two');",
  'physicsHostImpl.js': "self.ran.push('host'); self.onmessage = function (e) { self.got.push(e.data); };",
};

/** A worker scope: fetch held until release(), importScripts that runs what it loads, blobs readable at once. */
function workerScope({ name = 'physics pages=1024 mb=64', fail = null } = {}) {
  const requested = [];
  const imported = [];
  const blobs = new Map();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const scope = new EventTarget();
  let context = null;
  class StandInBlob {
    constructor(parts) {
      this.source = parts.join('');
    }
  }
  class StandInURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:game.test/${blobs.size}`;
      blobs.set(url, blob.source);
      return url;
    }
  }
  Object.assign(scope, {
    self: scope,
    name,
    location: { href: `${BASE}box2dWorkerEntry.js?v=7`, search: '?v=7' },
    ran: [],
    got: [],
    warnings: [],
    onmessage: null,
    performance,
    MessageEvent,
    Blob: StandInBlob,
    URL: StandInURL,
    Promise,
    Object,
    Array,
    String,
    Error,
    setTimeout,
    console: { warn: (...a) => scope.warnings.push(a.join(' ')) },
    fetch: async (url) => {
      requested.push(url);
      await gate;
      const file = url.slice(BASE.length).split('?')[0];
      if (file === fail) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => SCRIPTS[file] };
    },
    importScripts: (...urls) => {
      for (const url of urls) {
        imported.push(url);
        const source = blobs.has(url) ? blobs.get(url) : SCRIPTS[String(url).split('?')[0]];
        vm.runInContext(source, context);
      }
    },
  });
  // A message reaches onmessage as in a worker (the host sets it), besides any listener.
  scope.addEventListener('message', (e) => scope.onmessage?.(e));
  context = vm.createContext(scope);
  return { scope, context, requested, imported, release: () => release(), blobs };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('the scripts are fetched at once and run in the glue\'s order; messages that came meanwhile reach the host in order', async () => {
  const w = workerScope();
  vm.runInContext(ENTRY, w.context);
  await settle();
  assert.deepEqual(
    w.requested.map((u) => u.slice(BASE.length)).sort(),
    ['box2dWasm.js?v=7', 'physicsHostImpl.js', 'weedjsPost.js'],
    'the glue, weedjsPost.js and the host requested before any answered',
  );
  w.scope.dispatchEvent(new MessageEvent('message', { data: 'reserveEngineBlock' }));
  w.scope.dispatchEvent(new MessageEvent('message', { data: 'init' }));
  assert.deepEqual([...w.scope.got], [], 'held: the host is not in yet');
  w.release();
  await settle();
  assert.deepEqual(w.requested.length, 5, 'both siblings requested once weedjsPost.js came');
  assert.deepEqual([...w.scope.ran], ['glue', 'one', 'two', 'post', 'host']);
  assert.ok(w.imported.every((u) => u.startsWith('blob:')), 'everything from the blobs');
  assert.ok([...w.blobs.values()].every((s) => s.includes('//# sourceURL=' + BASE)), 'each named by its file');
  assert.deepEqual([...w.scope.got], ['reserveEngineBlock', 'init']);
  w.scope.dispatchEvent(new MessageEvent('message', { data: 'start' }));
  assert.deepEqual([...w.scope.got], ['reserveEngineBlock', 'init', 'start'], 'once in, each message once');
  assert.deepEqual([...w.scope.__weedPhysicsLoadMarks].filter((x) => typeof x === 'string'), ['entry evaluated', 'scripts fetched']);
});

test('a pthread pool worker loads the glue directly; a file that does not come falls back to the glue\'s importScripts', async () => {
  const pool = workerScope({ name: 'em-pthread' });
  vm.runInContext(ENTRY, pool.context);
  assert.equal(pool.imported[0], 'box2dWasm.js?v=7', 'the glue first, by its own URL (it then runs as a pool thread)');
  assert.deepEqual(pool.requested, []);

  const w = workerScope({ fail: 'two.js' });
  vm.runInContext(ENTRY, w.context);
  w.scope.dispatchEvent(new MessageEvent('message', { data: 'init' }));
  w.release();
  await settle();
  assert.equal(w.imported[0], 'box2dWasm.js?v=7', 'the glue as before, by its own URL');
  assert.deepEqual([...w.scope.ran], ['glue', 'one', 'two', 'post', 'host']);
  assert.deepEqual([...w.scope.got], ['init']);
  assert.match(w.scope.warnings[0], /two\.js: HTTP 404/);
});
