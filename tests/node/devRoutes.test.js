// The dev server's editor routes (VISUAL_EDITOR_PLAN.md D7, ED-13): PUT /__weed/file writes a scene file inside the
// served folder, atomically; GET /__weed/list lists a folder's scene files. Only this machine, its own pages, paths
// inside the folder, .scene.json names (and the baked atlas: .atlas.json, .atlas.png), JSON bodies of at most 8 MB
// (a PNG of at most 64 MB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleDevRoute, MAX_ATLAS_PNG_BYTES, MAX_BODY_BYTES, resolveInside } from '../../server/devRoutes.js';

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-devroutes-'));
  fs.mkdirSync(path.join(root, 'levels'));
  const server = http.createServer((req, res) => {
    if (!handleDevRoute(req, res, root)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ root, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const put = (base, sitePath, body) =>
  fetch(`${base}/__weed/file?path=${encodeURIComponent(sitePath)}`, { method: 'PUT', body });

test('PUT writes a scene file inside the folder and answers its mtime; nothing else is left there', async () => {
  await withServer(async ({ root, base }) => {
    const text = '{ "format": 1, "script": "../s.js", "entities": [] }\n';
    const res = await put(base, '/levels/1-1.scene.json', text);
    assert.equal(res.status, 200);
    const { mtimeMs } = await res.json();
    const file = path.join(root, 'levels', '1-1.scene.json');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(mtimeMs, fs.statSync(file).mtimeMs);
    assert.deepEqual(fs.readdirSync(path.join(root, 'levels')), ['1-1.scene.json'], 'no temporary file left');
  });
});

test('a reader sees the old file or the new one, never part of one', async () => {
  await withServer(async ({ root, base }) => {
    const file = path.join(root, 'levels', 'big.scene.json');
    const doc = (fill) => JSON.stringify({ format: 1, script: 's.js', entities: [], pad: fill.repeat(3 << 20) });
    const before = doc('a');
    const after = doc('b');
    fs.writeFileSync(file, before);
    let done = false;
    const writing = put(base, '/levels/big.scene.json', after).then((res) => {
      done = true;
      return res.status;
    });
    // A reader that reads as often as it can, with a moment between reads as any other program has (Windows does
    // not rename over a file while it is open: the route tries again).
    let reads = 0;
    while (!done) {
      const seen = fs.readFileSync(file, 'utf8');
      assert.ok(seen === before || seen === after, `read ${reads}: ${seen.length} bytes, neither file`);
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(await writing, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
  });
});

test('PUT refuses paths out of the folder, other endings, bodies that are not JSON or too big', async () => {
  await withServer(async ({ root, base }) => {
    const outside = path.join(path.dirname(root), 'weed-devroutes-escape.scene.json');
    const cases = [
      ['/../weed-devroutes-escape.scene.json', '{}', 400],
      ['/levels/../../weed-devroutes-escape.scene.json', '{}', 400],
      ['levels/no-slash.scene.json', '{}', 400],
      ['/levels\\..\\..\\x.scene.json', '{}', 400],
      ['/levels/a:b.scene.json', '{}', 400],
      [`${root.replace(/\\/g, '/')}/levels/abs.scene.json`, '{}', 400],
      ['/levels/a.json', '{}', 400],
      ['/levels/a.js', '{}', 400],
      ['/levels/broken.scene.json', '{ "format": 1,', 400],
      ['/nofolder/a.scene.json', '{}', 404],
      ['/levels/huge.scene.json', `"${'x'.repeat(MAX_BODY_BYTES)}"`, 413],
    ];
    for (const [sitePath, body, status] of cases) {
      const res = await put(base, sitePath, body);
      assert.equal(res.status, status, sitePath.slice(0, 80));
      assert.ok((await res.json()).error);
    }
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'levels')), [], 'nothing written');
    const wrongMethod = await fetch(`${base}/__weed/file?path=/levels/a.scene.json`);
    assert.equal(wrongMethod.status, 405);
  });
});

test('PUT writes the atlas the editor bakes: a PNG of up to 64 MB and its JSON (ED-31)', async () => {
  await withServer(async ({ root, base }) => {
    // Past the 8 MB of a scene file: an atlas image may be that big.
    const png = Buffer.alloc(MAX_BODY_BYTES + 1024, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    assert.ok(png.length <= MAX_ATLAS_PNG_BYTES);
    const res = await put(base, '/levels/Level.atlas.png', png);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.ok(fs.readFileSync(path.join(root, 'levels', 'Level.atlas.png')).equals(png), 'written byte for byte');
    const json = '{"frames":{},"animations":{},"meta":{"size":{"w":1,"h":1}}}';
    assert.equal((await put(base, '/levels/Level.atlas.json', json)).status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'levels', 'Level.atlas.json'), 'utf8'), json);

    const refused = [
      ['/levels/Other.atlas.png', '{"not":"a png"}', 400, /not a PNG/],
      ['/levels/Other.atlas.json', 'not json', 400, /not JSON/],
      ['/levels/Other.png', png.subarray(0, 64), 400, /can be written/],
      ['/levels/Other.json', '{}', 400, /can be written/],
      ['/levels/Other.atlas.json', `"${'x'.repeat(MAX_BODY_BYTES)}"`, 413, /at most/],
    ];
    for (const [sitePath, body, status, why] of refused) {
      const answer = await put(base, sitePath, body);
      assert.equal(answer.status, status, sitePath);
      assert.match((await answer.json()).error, why, sitePath);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, 'levels')).sort(), ['Level.atlas.json', 'Level.atlas.png']);
  });
});

test('a link inside the folder does not lead out of it', async () => {
  await withServer(async ({ root, base }) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-devroutes-elsewhere-'));
    const link = path.join(root, 'linked');
    try {
      fs.symlinkSync(elsewhere, link, 'junction');
      const res = await put(base, '/linked/a.scene.json', '{}');
      assert.equal(res.status, 400);
      assert.deepEqual(fs.readdirSync(elsewhere), []);
      assert.equal(resolveInside(root, '/linked/a.scene.json'), null);
    } finally {
      fs.rmSync(link, { force: true, recursive: false });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('the list route lists the folder’s scene files, sorted; nothing else', async () => {
  await withServer(async ({ root, base }) => {
    for (const name of ['b.scene.json', 'a.scene.json', 'c.json', 'd.txt']) fs.writeFileSync(path.join(root, 'levels', name), '{}');
    fs.mkdirSync(path.join(root, 'levels', 'folder.scene.json'));
    const list = (query) => fetch(`${base}/__weed/list?${query}`);
    const res = await list('dir=/levels&ext=.scene.json');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { files: ['a.scene.json', 'b.scene.json'] });
    assert.equal((await list('dir=/levels&ext=.txt')).status, 400);
    assert.equal((await list('dir=/levels')).status, 400);
    assert.equal((await list('dir=/../&ext=.scene.json')).status, 400);
    assert.equal((await list('dir=/missing&ext=.scene.json')).status, 404);
    assert.equal((await fetch(`${base}/__weed/list?dir=/levels&ext=.scene.json`, { method: 'PUT', body: '{}' })).status, 405);
  });
});

test('only this machine, by a loopback name, from one of its own pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-devroutes-'));
  try {
    const ask = ({ address = '127.0.0.1', host = 'localhost:8000', origin } = {}) => {
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url: '/__weed/list?dir=/&ext=.scene.json',
        socket: { remoteAddress: address },
        headers: origin === undefined ? { host } : { host, origin },
        resume() {},
      });
      let status = 0;
      const res = { writeHead: (s) => (status = s), end() {} };
      assert.equal(handleDevRoute(req, res, root), true);
      return status;
    };
    assert.equal(ask({ address: '192.168.1.20' }), 403, 'another machine');
    assert.equal(ask({ host: 'evil.example:8000' }), 403, 'a rebound name');
    assert.equal(ask({ origin: 'http://evil.example' }), 403, 'another site’s page');
    assert.equal(ask({ origin: 'null' }), 403, 'a sandboxed page');
    assert.equal(ask({ host: 'localhost' }), 0, 'local, no origin: served (asynchronously)');
    assert.equal(ask({ address: '::1', host: '[::1]:8000', origin: 'http://[::1]:8000' }), 0);
    assert.equal(ask({ address: '::ffff:127.0.0.1', host: '127.0.0.1:8000', origin: 'http://127.0.0.1:8000' }), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('other paths are left to the server', () => {
  const res = { writeHead() {}, end() {} };
  for (const url of ['/__weed/reload', '/index.html', '/__weed/files', '/__weed/file/x']) {
    assert.equal(handleDevRoute({ url, method: 'GET', headers: {}, socket: {} }, res, os.tmpdir()), false, url);
  }
});

test('POST /__weed/export exports into the folder the server was given, never one the request names (ED-32)', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-export-route-'));
  const engineBundle = path.join(work, 'weed.prod.bundle.min.js');
  fs.writeFileSync(engineBundle, '/* engine */');
  const options = { export: { dir: path.join(work, 'exports'), engineBundle } };
  const server = http.createServer((req, res) => {
    if (!handleDevRoute(req, res, repo, {}, options)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/__weed/export`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const F = '/tests/fixtures/exportGame';
  try {
    const res = await post({
      scene: `${F}/game/fixtureScene.js`,
      export: 'FixtureScene',
      start: `${F}/game/levels/a.scene.json`,
      sceneFiles: [`${F}/game/levels/a.scene.json`],
      assets: [],
      atlas: null,
      outDir: path.join(work, 'elsewhere'), // not the request's to choose
    });
    const done = await res.json();
    assert.equal(res.status, 200, JSON.stringify(done));
    assert.equal(done.outDir, path.join(work, 'exports', 'FixtureScene'));
    assert.equal(done.url, null, 'outside the served folder: no URL to open it at');
    assert.ok(done.files.includes('game.min.js') && done.files.includes('vendor/weed.js'));
    assert.ok(fs.existsSync(path.join(work, 'exports', 'FixtureScene', 'index.html')));
    assert.equal(fs.existsSync(path.join(work, 'elsewhere')), false);

    const missing = await post({ scene: `${F}/game/none.js`, export: 'FixtureScene' });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /scene module not found/);
    assert.equal((await post('{ not json')).status, 400);
    assert.equal((await fetch(`${base}/__weed/export`)).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
  // The same local checks as the other routes.
  let status = 0;
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/__weed/export',
    socket: { remoteAddress: '192.168.1.20' },
    headers: { host: 'localhost:8000' },
    resume() {},
  });
  assert.equal(handleDevRoute(req, { writeHead: (s) => (status = s), end() {} }, os.tmpdir()), true);
  assert.equal(status, 403, 'another machine');
});
