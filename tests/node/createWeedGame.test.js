import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'packages/create-weed-game/index.mjs');
const TEMPLATE = path.join(ROOT, 'packages/create-weed-game/template');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weed-create-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function scaffold(parent, name) {
  const r = spawnSync(process.execPath, [CLI, name], { cwd: parent, encoding: 'utf8' });
  return { ...r, dir: path.join(parent, name) };
}

test('the CLI copies the template, restores .gitignore and names the package', () => {
  const parent = tempDir();
  try {
    const r = scaffold(parent, 'My Game');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['index.html', 'src/gameScene.js', 'scripts/dev.mjs', 'scripts/build.mjs', '.gitignore', 'jsconfig.json']) {
      assert.ok(fs.existsSync(path.join(r.dir, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(r.dir, '_gitignore')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'package.json'), 'utf8')).name, 'my-game');
    assert.match(r.stdout, /npm run dev/);

    const again = scaffold(parent, 'My Game');
    assert.equal(again.status, 1);
    assert.match(again.stderr, /not empty/);
  } finally {
    removeDir(parent);
  }
});

test('the template depends on this engine minor, no newer than this version', () => {
  const engine = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version.split('.').map(Number);
  const range = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')).dependencies['@weed.js/engine'];
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(m, `range ${range}`);
  assert.deepEqual([+m[1], +m[2]], engine.slice(0, 2));
  assert.ok(+m[3] <= engine[2], `${range} is newer than ${engine.join('.')}`);
});

test('npm run build swaps in the production engine and writes _headers', () => {
  const parent = tempDir();
  try {
    const { dir } = scaffold(parent, 'game');
    const engineDir = path.join(dir, 'node_modules/@weed.js/engine/dist');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'weed.prod.bundle.esm.min.js'), '/* prod */');
    // An engine without weed-sw.js (older than DX-SW): the build still works, without it.
    const old = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'dist/weed-sw.js')), false);
    // DX-SW: the isolation service worker goes next to index.html, for hosts without headers.
    fs.writeFileSync(path.join(engineDir, 'weed-sw.js'), '/* sw */');

    const r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8');
    assert.match(html, /"@weed\.js\/engine": "\.\/vendor\/weed\.js"/);
    assert.match(html, /const DEV = false;/);
    assert.doesNotMatch(html, /node_modules/);
    assert.equal(fs.readFileSync(path.join(dir, 'dist/vendor/weed.js'), 'utf8'), '/* prod */');
    assert.ok(fs.existsSync(path.join(dir, 'dist/src/gameScene.js')));
    assert.equal(fs.readFileSync(path.join(dir, 'dist/weed-sw.js'), 'utf8'), '/* sw */');
    const headers = fs.readFileSync(path.join(dir, 'dist/_headers'), 'utf8');
    assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
    assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);

    // An index.html without the DEV line stops the build instead of shipping debug.
    const page = path.join(dir, 'index.html');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('const DEV = true;', 'const DEV = 1;'));
    const broken = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /const DEV = true;/);
  } finally {
    removeDir(parent);
  }
});

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

async function startServer(dir, args) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...args], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve());
    child.on('exit', (code) => reject(new Error(`dev server exited ${code}`)));
  });
  const stop = () =>
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
  return { port, stop };
}

test('the dev server sends the isolation headers, guards the root and pings on save', async () => {
  const parent = tempDir();
  const { dir } = scaffold(parent, 'game');
  const server = await startServer(dir, []);
  try {
    const page = await get(server.port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match((await get(server.port, '/src/gameScene.js')).headers['content-type'], /text\/javascript/);
    assert.equal((await get(server.port, '/..%2f..%2fpackage.json')).status, 403); // %2f survives URL parsing
    assert.equal((await get(server.port, '/..%5c..%5cpackage.json')).status, 403);
    assert.equal((await get(server.port, '/nope.js')).status, 404);

    const ping = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: '/__weed/reload' }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (chunk.startsWith(': hot reload')) {
            const file = path.join(dir, 'src/gameScene.js');
            fs.appendFileSync(file, '\n// edited\n');
          } else if (chunk.startsWith('data: ')) {
            req.destroy();
            resolve(JSON.parse(chunk.slice(6)));
          }
        });
      });
      req.on('error', (e) => e.code !== 'ECONNRESET' && reject(e));
      setTimeout(() => reject(new Error('no reload ping')), 5000);
    });
    assert.equal(ping.file, 'src/gameScene.js');
  } finally {
    await server.stop();
    removeDir(parent);
  }
});

test('preview serves dist without the reload endpoint', async () => {
  const parent = tempDir();
  const { dir } = scaffold(parent, 'game');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist/index.html'), '<!doctype html>');
  const server = await startServer(dir, ['dist']);
  try {
    assert.equal((await get(server.port, '/')).body, '<!doctype html>');
    assert.equal((await get(server.port, '/__weed/reload')).status, 404);
  } finally {
    await server.stop();
    removeDir(parent);
  }
});

test('the template scene registers cleanly and compiles for blob workers', async () => {
  const { default: WEED } = await import('../../src/index.js');
  globalThis.WEED = WEED; // the template reads the page's global WEED
  const file = path.join(TEMPLATE, 'src/gameScene.js');
  const { GameScene } = await import(pathToFileURL(file).href);
  const { warnMissingListenerTags } = await import('../../src/util/listenerTags.js');
  const { transformBlobScript } = await import('../../src/util/utils.js');

  const warnings = [];
  const registered = GameScene.entities.map(([C]) => ({ class: C, components: WEED.GameObject._collectComponents(C) }));
  warnMissingListenerTags(registered, WEED.GameObject, (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
  new Function('exports', 'WEED', transformBlobScript(fs.readFileSync(file, 'utf8'), 'http://x/gameScene.js'));
});
