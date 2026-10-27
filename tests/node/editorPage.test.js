// The dev server's route to the editor page (server/editorPage.js, VISUAL_EDITOR_PLAN.md ED-29, ED-30): /__weed/editor/
// serves the page's own files with the isolation headers, sends /__weed/editor to its slash, and nothing else: no
// subfolder, no way out, only the page's file types. Other paths are not its business.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { serveEditorPage, EDITOR_ROUTE } from '../../server/editorPage.js';

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
