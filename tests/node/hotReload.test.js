import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { HotReload } from '../../src/core/debug/hotReload.js';

// DX 5. A code change meant a manual reload and replaying to where you were.
// npm run dev pings /__weed/reload on a change; the debug build saves the scene,
// reloads, and the next loadScene of that scene restores it once.

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/node_server.js');

function startServer(root, port, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('Server running')) resolve(child);
    });
    child.once('error', reject);
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

function get(port, urlPath, onData) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => onData && onData(chunk));
      resolve({ res, req });
    });
  });
}

test('the dev server streams a change event to /__weed/reload', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'weed-hot-'));
  mkdirSync(path.join(root, 'node_modules'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = await startServer(root, port);
  try {
    let text = '';
    const { res, req } = await get(port, '/__weed/reload', (c) => (text += c));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
    writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'x');
    await new Promise((r) => setTimeout(r, 400));
    assert.doesNotMatch(text, /ignored\.js/, 'node_modules is not watched');
    writeFileSync(path.join(root, 'game.js'), 'export const a = 1;');
    const deadline = Date.now() + 4000;
    while (!/data: .*game\.js/.test(text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(text, /data: \{"file":"game\.js"\}/);
    req.destroy();
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('WEED_HOT_RELOAD=0 turns the endpoint off', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'weed-hot-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = await startServer(root, port, { WEED_HOT_RELOAD: '0' });
  try {
    const { res, req } = await get(port, '/__weed/reload');
    assert.equal(res.statusCode, 404);
    req.destroy();
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('the restore note is used once, and only restores the scene that was running', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const url = 'http://localhost:8000/demos/a/aScene.js';
    store.set('weed.hotReload', JSON.stringify({ url, data: { level: 2 } }));
    assert.deepEqual(HotReload.takeRestore(url), { restoreSlot: HotReload.SLOT, data: { level: 2 } });
    assert.equal(HotReload.takeRestore(url), null, 'once');

    store.set('weed.hotReload', JSON.stringify({ url, data: null }));
    assert.equal(HotReload.takeRestore('http://localhost:8000/demos/b/bScene.js'), null);
    assert.equal(store.has('weed.hotReload'), false, 'another scene used the note up');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('a lost or unreadable hot-reload save reads as null: the scene starts fresh, it does not fail', async () => {
  const { SaveStore, encodeSave } = await import('../../src/core/save/saveGame.js');
  const realGet = SaveStore.get;
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    SaveStore.get = async () => null; // the page unloaded before the save committed
    assert.equal(await HotReload.readSlot(), null);

    SaveStore.get = async () => new Uint8Array([1, 2, 3]); // not a save
    assert.equal(await HotReload.readSlot(), null);

    SaveStore.get = async () => {
      throw new Error('IndexedDB blocked');
    };
    assert.equal(await HotReload.readSlot(), null);
    assert.equal(warnings.length, 3);

    const blob = await encodeSave({
      sceneName: 'Level',
      engineVersion: '0',
      layout: { types: [], totalEntityCount: 0 },
      camera: null,
      sun: null,
      entities: [],
      joints: [],
    });
    SaveStore.get = async (slot) => (slot === HotReload.SLOT ? blob : null);
    assert.equal((await HotReload.readSlot()).sceneName, 'Level');
  } finally {
    SaveStore.get = realGet;
    console.warn = realWarn;
  }
});
