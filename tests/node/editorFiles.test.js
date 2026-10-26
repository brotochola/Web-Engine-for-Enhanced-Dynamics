// The editor's scene-file picker (VISUAL_EDITOR_PLAN.md ED-38): the scene files of the running one's folder (the dev
// server's list route), Open (loadScene, a fast swap for the same class), New (an empty file naming the same module
// and class, written, then opened) and Save As (the document to another file, which is then the running one).
// Unsaved changes are not dropped without asking.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditMode, sceneFileNameOf } from '../../src/core/debug/editor/editMode.js';
import { listSceneFiles } from '../../src/core/debug/editor/sceneFileStore.js';
import { HotReload } from '../../src/core/debug/hotReload.js';
import { serializeSceneFile } from '../../src/core/sceneFile.js';

const ORIGIN = 'http://localhost:8000';
const FOLDER = `${ORIGIN}/demos/platformerGameScene/levels/`;

test('a name typed for New or Save As is a file of the same folder', () => {
  assert.equal(sceneFileNameOf('boss'), 'boss.scene.json');
  assert.equal(sceneFileNameOf(' 2-1.scene.json '), '2-1.scene.json');
  for (const bad of ['', '   ', '.scene.json', 'x/y', '..\\y', 'c:boss', null]) assert.equal(sceneFileNameOf(bad), null, String(bad));
});

/** A server with the editor's routes, in memory: the folder's files, and what was PUT. */
function fakeServer(files) {
  const puts = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/__weed/list') {
      assert.equal(u.searchParams.get('dir'), '/demos/platformerGameScene/levels');
      assert.equal(u.searchParams.get('ext'), '.scene.json');
      return { ok: true, status: 200, json: async () => ({ files: [...files].sort() }) };
    }
    if (u.pathname === '/__weed/file' && init.method === 'PUT') {
      const name = u.searchParams.get('path').split('/').pop();
      puts.push([name, init.body]);
      if (!files.includes(name)) files.push(name);
      return { ok: true, status: 200, json: async () => ({ mtimeMs: 1 }) };
    }
    return { ok: false, status: 404, json: async () => { throw new SyntaxError('a page'); } };
  };
  return { fetch, puts };
}

function editorWith(files) {
  const server = fakeServer(files);
  globalThis.fetch = server.fetch;
  globalThis.location = { origin: ORIGIN };
  const loads = [];
  const doc = { format: 1, script: '../platformerGameScene.js', export: 'PlatformerGameScene', entities: [{ name: 'P1', class: 'Platform', x: 1, y: 2 }] };
  const scene = { sceneFile: doc, sceneFileUrl: `${FOLDER}1-1.scene.json`, data: { levelsDone: 1 } };
  const debugUI = {
    scene,
    gameEngine: { loadScene: async (url, options) => (loads.push([url, options]), true) },
    tools: { updateToolIndicator() {}, _classNameForType: () => 'Platform' },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
  };
  const editMode = new EditMode(debugUI);
  let refreshed = 0;
  editMode.palette = { show() {}, hide() {}, refresh: () => refreshed++, destroy() {} };
  return { editMode, scene, loads, server, refreshed: () => refreshed };
}

async function withGlobals(fn) {
  const fetchBefore = globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = fetchBefore;
    delete globalThis.location;
    delete globalThis.confirm;
    HotReload._ignored.clear();
  }
}

test('listSceneFiles asks the list route for the folder; a server without it says what is needed', () =>
  withGlobals(async () => {
    const { fetch } = fakeServer(['b.scene.json', 'a.scene.json']);
    assert.deepEqual(await listSceneFiles(FOLDER, { fetch, origin: ORIGIN }), ['a.scene.json', 'b.scene.json']);
    const none = async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('page'); } });
    await assert.rejects(listSceneFiles(FOLDER, { fetch: none, origin: ORIGIN }), /could not list \/demos\/platformerGameScene\/levels \(HTTP 404\): the list needs npm run dev/);
  }));

test('the level list, and Open: another file of the folder, with the running data; nothing for the same file', () =>
  withGlobals(async () => {
    const { editMode, loads, refreshed } = editorWith(['1-1.scene.json', '1-2.scene.json']);
    await editMode.refreshSceneFiles();
    assert.deepEqual(editMode.sceneFiles, ['1-1.scene.json', '1-2.scene.json']);
    assert.equal(refreshed(), 1, 'the palette shows it');
    assert.equal(editMode.sceneFileName, '1-1.scene.json');
    assert.equal(await editMode.openSceneFile('1-1.scene.json'), false);
    assert.equal(await editMode.openSceneFile('1-2.scene.json'), true);
    assert.deepEqual(loads, [[`${FOLDER}1-2.scene.json`, { data: { levelsDone: 1 } }]]);
  }));

test('unsaved changes are dropped only when the author says so', () =>
  withGlobals(async () => {
    const { editMode, loads } = editorWith(['1-1.scene.json', '1-2.scene.json']);
    editMode.history.push({ id: 0, label: 'x', undo() {}, redo() {} });
    const asked = [];
    globalThis.confirm = (text) => (asked.push(text), false);
    assert.equal(await editMode.openSceneFile('1-2.scene.json'), false);
    assert.deepEqual(loads, []);
    assert.match(asked[0], /1-1\.scene\.json has unsaved changes\. Discard them\?/);
    globalThis.confirm = () => true;
    assert.equal(await editMode.openSceneFile('1-2.scene.json'), true);
  }));

test('New writes an empty file of the same module and class, then opens it; a taken name is refused', () =>
  withGlobals(async () => {
    const { editMode, loads, server } = editorWith(['1-1.scene.json']);
    await editMode.refreshSceneFiles();
    assert.equal(await editMode.newSceneFile('1-1'), false);
    assert.equal(editMode.status, '1-1.scene.json is already there');
    assert.equal(await editMode.newSceneFile('boss'), true);
    assert.deepEqual(server.puts, [
      ['boss.scene.json', serializeSceneFile({ format: 1, script: '../platformerGameScene.js', export: 'PlatformerGameScene', entities: [] })],
    ]);
    assert.deepEqual(loads, [[`${FOLDER}boss.scene.json`, { data: { levelsDone: 1 } }]]);
    clearTimeout(editMode._statusTimer);
  }));

test('Save As writes the document to another file, which is then the running one, saved', () =>
  withGlobals(async () => {
    const { editMode, scene, server } = editorWith(['1-1.scene.json']);
    editMode.history.push({ id: 0, label: 'x', undo() {}, redo() {} });
    assert.equal(editMode.dirty, true);
    assert.equal(await editMode.saveSceneFileAs('1-1-copy'), true);
    assert.deepEqual(server.puts, [['1-1-copy.scene.json', serializeSceneFile(scene.sceneFile)]]);
    assert.equal(scene.sceneFileUrl, `${FOLDER}1-1-copy.scene.json`, 'Ctrl+S, hot reload and game saves go to it now');
    assert.equal(editMode.dirty, false);
    assert.equal(editMode.status, 'Saved as 1-1-copy.scene.json');
    assert.deepEqual(editMode.sceneFiles, ['1-1-copy.scene.json', '1-1.scene.json'], 'listed again');
    globalThis.confirm = () => false;
    assert.equal(await editMode.saveSceneFileAs('1-1'), false, 'not over an existing file unless the author says so');
    assert.equal(server.puts.length, 1);
    clearTimeout(editMode._statusTimer);
  }));
