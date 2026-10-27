// The dev server's route to the editor page (server/editorPage.js, VISUAL_EDITOR_PLAN.md ED-29, ED-30): /__weed/editor/
// serves the page's own files with the isolation headers, sends /__weed/editor to its slash, and nothing else: no
// subfolder, no way out, only the page's file types. Other paths are not its business.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { serveEditorPage, EDITOR_ROUTE, EDITOR_SHORT_ROUTE } from '../../server/editorPage.js';

test('the editor page’s files at /__weed/editor/, and nothing else', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-editor-page-'));
  const shellDir = path.join(base, 'shell');
  fs.mkdirSync(shellDir);
  fs.writeFileSync(path.join(shellDir, 'index.html'), '<title>WeedJS editor</title>');
  fs.writeFileSync(path.join(shellDir, 'editorShell.js'), 'export {};');
  fs.writeFileSync(path.join(base, 'secret.html'), 'no');
  const server = http.createServer((req, res) => {
    if (!serveEditorPage(req, res, { shellDir, headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' } })) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (p) =>
    new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    });
  try {
    const page = await get(`${EDITOR_ROUTE}?game=%2Findex.html`);
    assert.equal(page.status, 200);
    assert.equal(page.body, '<title>WeedJS editor</title>');
    assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal((await get('/__weed/editor/editorShell.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    const bare = await get('/__weed/editor?game=x');
    assert.deepEqual([bare.status, bare.headers.location], [301, '/__weed/editor/?game=x']);
    for (const p of ['/__weed/editor/../secret.html', '/__weed/editor/%2e%2e%2Fsecret.html', '/__weed/editor/sub/index.html', '/__weed/editor/.env', '/__weed/editor/x.json']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.equal((await get('/index.html')).status, 418, 'other paths are the server’s');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** The real page's head, served from a folder `root` (with or without an `editor` of its own). */
async function shortRouteServer({ ownEditor }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-editor-short-'));
  const shellDir = path.join(base, 'shell');
  const root = path.join(base, 'site');
  fs.mkdirSync(shellDir);
  fs.mkdirSync(root);
  if (ownEditor) fs.mkdirSync(path.join(root, 'editor'));
  const html = fs.readFileSync(new URL('../../src/core/debug/editor/shell/index.html', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(shellDir, 'index.html'), html);
  fs.writeFileSync(path.join(shellDir, 'editorShell.js'), 'export {};');
  const server = http.createServer((req, res) => {
    if (!serveEditorPage(req, res, { shellDir, gamePage: '/demos/', root })) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (p, method = 'GET') =>
    new Promise((resolve) => {
      http.request({ host: '127.0.0.1', port: server.address().port, path: p, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).end();
    });
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { get, close };
}

test('/editor is the short route: the page with its base and the game page it opens, served without a redirect', async () => {
  const site = await shortRouteServer({ ownEditor: false });
  try {
    for (const p of [`${EDITOR_SHORT_ROUTE}?scene=platformergame`, `${EDITOR_SHORT_ROUTE}/`, `${EDITOR_SHORT_ROUTE}`]) {
      const page = await site.get(p);
      assert.equal(page.status, 200, p);
      assert.match(page.body, /<base href="\/editor\/" \/>\n  <meta name="weed-game-page" content="\/demos\/" \/>/, p);
      assert.equal(page.headers['x-weed-editor'], EDITOR_SHORT_ROUTE, 'the route the Scene panel’s button opens');
    }
    assert.equal((await site.get('/editor/editorShell.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    const long = await site.get(`${EDITOR_ROUTE}?game=x`, 'HEAD');
    assert.deepEqual([long.status, long.headers['x-weed-editor']], [200, EDITOR_SHORT_ROUTE], 'the long route names the short one');
    for (const p of ['/editorial.html', '/editors/index.html', '/demos/editor']) assert.equal((await site.get(p)).status, 418, p);
    assert.equal((await site.get('/editor/sub/x.js')).status, 404);
  } finally {
    await site.close();
  }
});

test('a served folder with an `editor` of its own keeps /editor; the long route still serves the page', async () => {
  const site = await shortRouteServer({ ownEditor: true });
  try {
    assert.equal((await site.get('/editor?scene=x')).status, 418, 'the folder’s own');
    const page = await site.get(`${EDITOR_ROUTE}?game=x`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['x-weed-editor'], EDITOR_ROUTE);
    assert.match(page.body, /<base href="\/__weed\/editor\/" \/>/);
  } finally {
    await site.close();
  }
});
