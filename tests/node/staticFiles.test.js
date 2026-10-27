// The dev server's static files (server/staticFiles.js, review N-80): a request's path is decoded and kept inside the
// served folder, so a raw `/../` (a browser removes the dots; curl --path-as-is and a socket do not) gets 403, not a
// file of the machine; and the server listens on this machine only (both loopback addresses) unless --host or
// WEED_HOST opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { serveStaticFile, listenHost, listenAddresses, listenFrom } from '../../server/staticFiles.js';

/** A served folder with a page, a folder with its index, a file with a space, and a secret beside the folder. */
function makeSite() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-static-'));
  const root = path.join(base, 'site');
  fs.mkdirSync(path.join(root, 'demos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(root, 'demos', 'index.html'), '<h1>demos</h1>');
  fs.writeFileSync(path.join(root, 'demos', 'a b.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'not for the network');
  return { base, root };
}

/** Serve `root` on a free port; GET a raw path (sent as is: no dot removal). */
async function serve(root, options = {}) {
  const server = http.createServer((req, res) => serveStaticFile(req, res, { root, log: () => {}, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (rawPath) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a path out of the served folder is refused, however it is written', async () => {
  const { base, root } = makeSite();
  const site = await serve(root);
  try {
    for (const raw of ['/../secret.txt', '/demos/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/demos/..%5C..%5Csecret.txt']) {
      const res = await site.get(raw);
      assert.equal(res.status, 403, raw);
      assert.doesNotMatch(res.body, /not for the network/, raw);
    }
    assert.equal((await site.get('/%E0%A4%A')).status, 400, 'bad percent-encoding');
  } finally {
    await site.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the folder is served as before: index.html, a folder sent to its slash, a decoded name, the headers', async () => {
  const { base, root } = makeSite();
  const site = await serve(root, { headers: { 'Cross-Origin-Opener-Policy': 'same-origin' } });
  try {
    const home = await site.get('/');
    assert.equal(home.status, 200);
    assert.equal(home.body, '<h1>home</h1>');
    assert.equal(home.headers['cross-origin-opener-policy'], 'same-origin');
    const folder = await site.get('/demos?scene=x');
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.location, '/demos/?scene=x');
    assert.equal((await site.get('/demos/')).body, '<h1>demos</h1>');
    const spaced = await site.get('/demos/a%20b.js');
    assert.equal(spaced.status, 200, 'a name with a space');
    assert.equal(spaced.headers['content-type'], 'text/javascript');
    assert.equal(spaced.headers['cache-control'], 'no-cache, no-store, must-revalidate');
    assert.equal((await site.get('/nope.js')).status, 404);
  } finally {
    await site.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a special file is served for its path wherever it lives (the isolation worker at /weed-sw.js)', async () => {
  const { base, root } = makeSite();
  const site = await serve(root, { special: (p) => (p === '/weed-sw.js' ? path.join(base, 'secret.txt') : null) });
  try {
    assert.equal((await site.get('/weed-sw.js')).body, 'not for the network');
    assert.equal((await site.get('/../secret.txt')).status, 403, 'only that path');
  } finally {
    await site.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the server listens on this machine only, unless --host or WEED_HOST opens it', () => {
  assert.equal(listenHost(['node', 'node_server.js'], {}), '127.0.0.1');
  assert.equal(listenHost(['node', 'node_server.js', '--host'], {}), '0.0.0.0');
  assert.equal(listenHost(['node', 'node_server.js'], { WEED_HOST: '192.168.0.10' }), '192.168.0.10');
});

/** The body a GET of / at host:port answers. */
function textAt(host, port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: '/' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

test('this machine only is both loopback addresses: localhost reaches the server even beside one left on its port', async () => {
  assert.deepEqual(listenAddresses('127.0.0.1'), ['127.0.0.1', '::1']);
  assert.deepEqual(listenAddresses('0.0.0.0'), [undefined], '--host: every interface, IPv6 and IPv4');
  assert.deepEqual(listenAddresses('192.168.0.10'), ['192.168.0.10']);

  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // A server left running on every interface, as `npm run dev` listened before N-80.
  const stale = http.createServer((req, res) => res.end('stale'));
  await new Promise((resolve) => stale.listen({ port }, resolve));
  const servers = [stale];
  try {
    const inUse = [];
    const first = await listenFrom(port, listenAddresses('127.0.0.1'), () => http.createServer((req, res) => res.end('first')), (p) => inUse.push(p));
    servers.push(...first.servers);
    // Windows lets it bind the loopback addresses beside the other, and gives it their connections; elsewhere the
    // port is in use and it takes the next. Either way the port it reports reaches it, over IPv4 and IPv6.
    assert.equal(inUse.length, first.port - port);
    assert.equal(await textAt('127.0.0.1', first.port), 'first');
    if (first.servers.length === 2) assert.equal(await textAt('::1', first.port), 'first');

    const second = await listenFrom(first.port, listenAddresses('127.0.0.1'), () => http.createServer((req, res) => res.end('second')));
    servers.push(...second.servers);
    assert.ok(second.port > first.port, 'a port this server holds is in use for the next one');
    assert.equal(await textAt('127.0.0.1', second.port), 'second');
    assert.equal(await textAt('127.0.0.1', first.port), 'first');
  } finally {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  }
});
