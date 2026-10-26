// The editor saves the running scene file (VISUAL_EDITOR_PLAN.md D7, ED-13): Ctrl+S in edit mode PUTs the document,
// in the file's layout, to the dev server's /__weed/file, after telling hot reload to skip that write. Errors say
// what went wrong, and how to get a server that saves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { saveSceneFile, OWN_WRITE_IGNORE_MS } from '../../src/core/debug/editor/sceneFileStore.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { HotReload } from '../../src/core/debug/hotReload.js';
import { serializeSceneFile } from '../../src/core/sceneFile.js';
import { handleDevRoute } from '../../server/devRoutes.js';

const ORIGIN = 'http://localhost:8000';
const DOC = {
  format: 1,
  script: '../platformerGameScene.js',
  export: 'PlatformerGameScene',
  entities: [{ name: 'Platform1', class: 'Platform', x: 600, y: 2050, config: { width: 1200 } }],
};

function withLocation(fn) {
  globalThis.location = { origin: ORIGIN };
  HotReload._ignored.clear();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete globalThis.location;
      HotReload._ignored.clear();
    });
}

const fakeFetch = (status, answer, calls) => async (url, init) => {
  calls.push({ url, init });
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (answer === null) throw new SyntaxError('Unexpected token <');
      return answer;
    },
  };
};

test('saveSceneFile PUTs the document in the file’s layout, and hot reload skips that write', () =>
  withLocation(async () => {
    const calls = [];
    const fileUrl = `${ORIGIN}/demos/platformerGameScene/levels/1-1.scene.json`;
    const mtimeMs = await saveSceneFile(fileUrl, DOC, { fetch: fakeFetch(200, { mtimeMs: 1234.5 }, calls) });
    assert.equal(mtimeMs, 1234.5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}/__weed/file?path=${encodeURIComponent('/demos/platformerGameScene/levels/1-1.scene.json')}`);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].init.body, serializeSceneFile(DOC));
    assert.equal(HotReload._isIgnored(fileUrl), true);
    assert.ok(HotReload._ignored.get(fileUrl) <= Date.now() + OWN_WRITE_IGNORE_MS);
  }));

test('a name with a space goes to the server as the name, encoded once', () =>
  withLocation(async () => {
    const calls = [];
    await saveSceneFile('/levels/boss%20fight.scene.json', DOC, { fetch: fakeFetch(200, { mtimeMs: 1 }, calls) });
    assert.equal(new URL(calls[0].url).searchParams.get('path'), '/levels/boss fight.scene.json');
  }));

test('saveSceneFile says why it could not save', () =>
  withLocation(async () => {
    const calls = [];
    await assert.rejects(
      saveSceneFile('https://cdn.example/levels/1-1.scene.json', DOC, { fetch: fakeFetch(200, {}, calls) }),
      /not on this page's server/,
    );
    assert.equal(calls.length, 0, 'nothing sent');
    await assert.rejects(
      saveSceneFile('/levels/1-1.scene.json', DOC, { fetch: fakeFetch(400, { error: 'not JSON: …' }, calls) }),
      /could not save \/levels\/1-1\.scene\.json: not JSON/,
    );
    await assert.rejects(
      saveSceneFile('/levels/1-1.scene.json', DOC, { fetch: fakeFetch(404, null, calls) }),
      /this server cannot save files \(HTTP 404\): serve the game with npm run dev/,
    );
  }));

test('end to end: the dev server’s route writes what the editor sends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-editor-save-'));
  fs.mkdirSync(path.join(root, 'levels'));
  const server = http.createServer((req, res) => {
    if (!handleDevRoute(req, res, root)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.location = { origin };
  try {
    await saveSceneFile(`${origin}/levels/1-1.scene.json`, DOC, { origin });
    assert.equal(fs.readFileSync(path.join(root, 'levels', '1-1.scene.json'), 'utf8'), serializeSceneFile(DOC));
  } finally {
    delete globalThis.location;
    HotReload._ignored.clear();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ctrl+S in edit mode saves the running scene file once, and the indicator says how it went', () =>
  withLocation(async () => {
    const calls = [];
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = fakeFetch(200, { mtimeMs: 1 }, calls);
    try {
      const scene = { sceneFile: DOC, sceneFileUrl: `${ORIGIN}/demos/platformerGameScene/levels/1-1.scene.json` };
      const debugUI = { scene, tools: { updateToolIndicator() {} } };
      const editMode = new EditMode(debugUI);
      const key = (k, extra) => ({ key: k, ctrlKey: false, metaKey: false, ...extra });
      // A width typed into the panel and not yet committed: Ctrl+S leaves the field first, so it is saved too.
      let committed = false;
      globalThis.document = {
        activeElement: {
          tagName: 'INPUT',
          blur: () => {
            committed = true;
            DOC.entities[0].config.width = 1300;
          },
        },
      };
      assert.equal(editMode.onKey(key('s', { ctrlKey: true })), true, 'the editor took Ctrl+S');
      delete globalThis.document;
      assert.equal(committed, true);
      assert.match(calls[0].init.body, /"width": 1300/, 'the committed value is in what was written');
      DOC.entities[0].config.width = 1200;
      assert.equal(editMode.onKey(key('S', { metaKey: true })), true);
      await editMode.save();
      assert.equal(calls.length, 1, 'a second Ctrl+S during the save waits for it');
      assert.equal(editMode.status, 'Saved 1-1.scene.json');
      assert.equal(editMode.onKey(key('s')), false, 's alone is not the editor’s');

      globalThis.fetch = fakeFetch(500, { error: 'EBUSY' }, calls);
      const errors = [];
      const quiet = console.error;
      console.error = (m) => errors.push(m);
      try {
        assert.equal(await editMode.save(), false);
      } finally {
        console.error = quiet;
      }
      assert.match(errors[0], /^\[WeedJS\] editor: could not save/, 'and the console says it too');
      assert.match(editMode.status, /could not save .*1-1\.scene\.json: EBUSY/);
      assert.equal(editMode.statusIsError, true);

      debugUI.scene = { sceneFile: null, sceneFileUrl: null };
      assert.equal(await editMode.save(), false);
      assert.match(editMode.status, /not loaded from a scene file/);
      clearTimeout(editMode._statusTimer);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  }));
