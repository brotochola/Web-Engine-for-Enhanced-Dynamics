import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadSceneFiles, sceneFileEntry } from '../../src/util/sceneFiles.js';

// N-312: a scene's own files (static assets.files), fetched at once and handed over by name, read as bytes, text or
// JSON, gunzipped when asked (and left alone when the server already decoded them).

/** fetch over `files` (url → string or bytes); each request's url noted, every one held until `release`. */
function serve(files) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    await gate;
    return url in files ? new Response(files[url]) : new Response('missing', { status: 404, statusText: 'Not Found' });
  };
  return { calls, release, restore: () => (globalThis.fetch = previous) };
}

test('every file is requested at once and comes as its entry reads it', async () => {
  const level = { name: 'one', size: [3, 4] };
  const server = serve({
    '/bin': new Uint8Array([1, 2, 3]),
    '/gz': gzipSync(Buffer.from([9, 8, 7, 6])),
    '/plain-but-gzip-asked': new Uint8Array([5, 5]),
    '/text': 'hola',
    '/json': JSON.stringify(level),
    '/json.gz': gzipSync(Buffer.from(JSON.stringify(level))),
  });
  try {
    const loading = loadSceneFiles({
      bytes: '/bin',
      gzipped: { url: '/gz', decompress: 'gzip' },
      decoded: { url: '/plain-but-gzip-asked', decompress: 'gzip' },
      text: { url: '/text', as: 'text' },
      json: { url: '/json', as: 'json' },
      jsonGz: { url: '/json.gz', as: 'json', decompress: 'gzip' },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(server.calls.length, 6, 'all six requested before any answered');
    server.release();
    const files = await loading;
    assert.ok(files.bytes instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(files.bytes)], [1, 2, 3]);
    assert.deepEqual([...new Uint8Array(files.gzipped)], [9, 8, 7, 6]);
    assert.deepEqual([...new Uint8Array(files.decoded)], [5, 5], 'not gzip (a server decoded it): as it came');
    assert.equal(files.text, 'hola');
    assert.deepEqual(files.json, level);
    assert.deepEqual(files.jsonGz, level);
  } finally {
    server.restore();
  }
});

test('no files: an empty object; a bad entry names itself before any request; a missing file names its URL', async () => {
  assert.deepEqual(await loadSceneFiles(undefined), {});
  assert.throws(() => sceneFileEntry('map', {}), /assets\.files\.map needs a URL/);
  assert.throws(() => sceneFileEntry('map', { url: '/m', as: 'blob' }), /assets\.files\.map\.as is "blob"/);
  assert.throws(() => sceneFileEntry('map', { url: '/m', decompress: 'brotli' }), /decompress is "brotli"/);
  const server = serve({ '/ok': 'x', '/notjson': '<html>' });
  server.release();
  try {
    await assert.rejects(loadSceneFiles({ ok: '/ok', bad: { url: '/m', as: 'yaml' } }), /assets\.files\.bad\.as/);
    assert.equal(server.calls.length, 0, 'checked before fetching');
    await assert.rejects(loadSceneFiles({ gone: '/gone' }), /the scene's file "gone" .*HTTP 404/);
    await assert.rejects(loadSceneFiles({ page: { url: '/notjson', as: 'json' } }), /is not JSON .*starts "<html>"/);
  } finally {
    server.restore();
  }
});
