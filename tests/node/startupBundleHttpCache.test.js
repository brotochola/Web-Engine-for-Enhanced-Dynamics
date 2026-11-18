/**
 * SST-8's timing needs warm visits that can reuse cached scripts and wasm with their compiled code: the bench server's
 * httpCache option (loadWaterfall --http-cache) serves like a static host, every file revalidated with an ETag and
 * answered 304 when unchanged. Without it, nothing changes: .js stays no-store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

test('httpCache: an ETag on every file, 304 for an unchanged one, isolation kept; the default still no-store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-http-cache-'));
  fs.writeFileSync(path.join(root, 'worker.js'), '// a worker');
  fs.writeFileSync(path.join(root, 'engine.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const cached = await createStaticBenchmarkServer(root, 0, { httpCache: true });
  const plain = await createStaticBenchmarkServer(root);
  try {
    for (const [file, type] of [['/worker.js', 'text/javascript'], ['/engine.wasm', 'application/wasm']]) {
      const first = await fetch(`http://127.0.0.1:${cached.port}${file}`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('content-type'), type);
      assert.equal(first.headers.get('cache-control'), 'no-cache');
      assert.equal(first.headers.get('cross-origin-embedder-policy'), 'require-corp');
      const etag = first.headers.get('etag');
      assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
      assert.ok(first.headers.get('last-modified'));
      assert.ok((await first.arrayBuffer()).byteLength > 0);

      const again = await fetch(`http://127.0.0.1:${cached.port}${file}`, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304);
      assert.equal((await again.arrayBuffer()).byteLength, 0);
      assert.equal(again.headers.get('cross-origin-embedder-policy'), 'require-corp');
    }
    const missing = await fetch(`http://127.0.0.1:${cached.port}/nope.js`);
    assert.equal(missing.status, 404);

    const js = await fetch(`http://127.0.0.1:${plain.port}/worker.js`);
    assert.equal(js.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(js.headers.get('etag'), null);
  } finally {
    await cached.close();
    await plain.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
