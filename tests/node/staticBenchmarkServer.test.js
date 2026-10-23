import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

// DX-SW, SW-2. The browser tests of the isolation service worker need a host that does not send
// COOP/COEP (GitHub Pages, `npx serve`), a second origin to embed the game from, and the worker's
// source served at the URL a game would deploy it to.

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'sw.js'), '// the worker');
  return dir;
}

async function get(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test('the isolation headers by default, none when asked, and two servers are two origins', async () => {
  const root = tempRoot();
  const isolated = await createStaticBenchmarkServer(root);
  const plain = await createStaticBenchmarkServer(root, 0, { isolationHeaders: false });
  try {
    const a = await get(isolated.port, '/');
    assert.equal(a.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(a.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(a.headers.get('cross-origin-resource-policy'), 'cross-origin');

    const b = await get(plain.port, '/');
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('content-type'), 'text/html');
    for (const h of ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']) {
      assert.equal(b.headers.get(h), null, h);
    }
    assert.notEqual(isolated.port, plain.port);
  } finally {
    await isolated.close();
    await plain.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mapped path serves another file under the root', async () => {
  const root = tempRoot();
  const server = await createStaticBenchmarkServer(root, 0, { isolationHeaders: false, files: { '/weed-sw.js': 'src/sw.js' } });
  try {
    const res = await get(server.port, '/weed-sw.js');
    assert.equal(res.status, 200);
    assert.equal(res.body, '// the worker');
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    assert.equal((await get(server.port, '/sw.js')).status, 404);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
