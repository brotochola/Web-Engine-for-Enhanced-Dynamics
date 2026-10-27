// The editor page (VISUAL_EDITOR_PLAN.md D9, ED-15): the host the game page connects to, and the game page's side of
// it. The host keeps copies of what a page hands over and nothing of the page itself; the next page takes the state
// up once its scene, the same scene, is ready. Keys typed in the editor page reach the editor as in the game page.
// In Chromium, tests/bench/editorShellSmoke.mjs runs the real pages (reloads, and that no reloaded page is kept).
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditorHost, gamePageUrl, gamePageFor, editorQueryFor, SLOT_NAMES } from '../../src/core/debug/editor/shell/editorShell.js';
import { findEditorHost, editorPageUrl, HostedEditor, HOST_KEY, HOST_VERSION, dockDigitOf } from '../../src/core/debug/editor/editorHost.js';
import { dockKeyOf } from '../../src/core/debug/editor/shell/editorLayout.js';
import { editorPageFor } from '../../src/core/debug/editorPage.js';

/** A dock: what was put into it, and replaceChildren. */
class Slot {
  constructor() {
    this.children = [];
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
}

function makeHost() {
  const slots = {};
  for (const name of SLOT_NAMES) slots[name] = new Slot();
  const status = [];
  const host = new EditorHost({ slots, onStatus: (text) => status.push(text) });
  return { host, slots, status };
}

test('the host hands a page the docks and what the page before it handed over, once', () => {
  const { host, slots } = makeHost();
  const first = { onHostKey() {} };
  const answer = host.connect(first);
  assert.equal(answer.version, HOST_VERSION);
  assert.equal(answer.kept, null, 'nothing kept yet');
  assert.equal(answer.slots.tree, slots.tree);
  assert.equal(host.connected, true);
  slots.tree.appendChild({ node: 'of the page' });

  const state = { version: 1, sceneScriptUrl: '/a.js', history: { done: [{ id: 1, label: 'x' }] } };
  host.disconnect(first, state);
  assert.equal(host.connected, false);
  assert.deepEqual(slots.tree.children, [], 'the nodes the page put into the docks are taken out');

  const second = { onHostKey() {} };
  const { kept } = host.connect(second);
  assert.deepEqual(kept, state);
  assert.notEqual(kept, state, 'a copy of its own, not the page’s object');
  assert.notEqual(kept.history, state.history);
  assert.equal(host.connect(second).kept, null, 'taken: the next connect gets nothing');
});

test('Ctrl+1, 2, 3 typed in the game page fold the editor page’s docks, and reach neither the game nor the browser', () => {
  const taken = [];
  const host = new EditorHost({ slots: {}, onDockKey: (digit) => (taken.push(digit), digit !== 9) });
  assert.equal(host.dockKey(2), true);
  assert.equal(host.dockKey(9), false);
  assert.deepEqual(taken, [2, 9]);
  assert.equal(new EditorHost({ slots: {} }).dockKey(1), false, 'an editor page without docks to fold');

  const passed = [];
  const hosted = new HostedEditor({}, { dockKey: (digit) => (passed.push(digit), true) });
  const typed = (key, extra) => {
    const e = keyEvent(key, extra);
    e.stopped = false;
    e.stopPropagation = () => {
      e.stopped = true;
    };
    hosted._onDockKey(e);
    return e;
  };
  const two = typed('2', { ctrlKey: true, code: 'Digit2' });
  assert.deepEqual(passed, [2]);
  assert.equal(two.prevented && two.stopped, true, 'not the game’s, not a tab switch');
  const held = typed('3', { ctrlKey: true, code: 'Digit3', repeat: true });
  assert.equal(held.prevented, true);
  assert.deepEqual(passed, [2], 'a held key folds once');
  const undo = typed('z', { ctrlKey: true, code: 'KeyZ' });
  assert.equal(undo.prevented || undo.stopped, false, 'the editor’s own keys pass');
  // The two sides read the keys alike.
  for (const e of [keyEvent('1', { ctrlKey: true }), keyEvent('"', { code: 'Digit3', metaKey: true }), keyEvent('2', { ctrlKey: true, shiftKey: true })]) {
    assert.equal(dockDigitOf(e), dockKeyOf(e));
  }
});

test('only the connected page disconnects; a page that hands over nothing leaves nothing kept', () => {
  const { host } = makeHost();
  const page = { onHostKey() {} };
  host.connect(page);
  host.disconnect({ onHostKey() {} }, { stale: true });
  assert.equal(host.connected, true, 'another page’s disconnect is ignored');
  host.disconnect(page, { version: 1 });
  const next = { onHostKey() {} };
  host.connect(next);
  host.disconnect(next, null);
  assert.equal(host.connect({ onHostKey() {} }).kept, null);
});

test('a state that cannot be copied is dropped with a warning, and the page is let go anyway', () => {
  const { host } = makeHost();
  const page = { onHostKey() {} };
  host.connect(page);
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    host.disconnect(page, { fn: () => {} });
  } finally {
    console.warn = warn;
  }
  assert.equal(host.connected, false);
  assert.match(warnings[0], /cannot be copied/);
  assert.equal(host.connect({ onHostKey() {} }).kept, null);
});

test('the editor page asks before it unloads only while the connected page has unsaved changes', () => {
  const { host } = makeHost();
  assert.equal(host.hasUnsavedChanges(), false, 'no page');
  let dirty = true;
  const page = { onHostKey() {}, hasUnsavedChanges: () => dirty };
  host.connect(page);
  assert.equal(host.hasUnsavedChanges(), true);
  dirty = false;
  assert.equal(host.hasUnsavedChanges(), false);
  host.disconnect(page, null);
  dirty = true;
  assert.equal(host.hasUnsavedChanges(), false, 'a page that has gone');
});

test('keys typed in the editor page go to the connected page only', () => {
  const { host } = makeHost();
  const got = [];
  host.onKeyDown({ key: 'z' });
  const page = { onHostKey: (e) => got.push(e.key) };
  host.connect(page);
  host.onKeyDown({ key: 'z' });
  host.disconnect(page, null);
  host.onKeyDown({ key: 'y' });
  assert.deepEqual(got, ['z']);
});

test('the game page must be on the editor page’s server', () => {
  const page = 'http://127.0.0.1:8000/src/core/debug/editor/shell/?game=x';
  assert.equal(gamePageUrl('/demos/index.html?scene=platformergame', page), 'http://127.0.0.1:8000/demos/index.html?scene=platformergame');
  assert.equal(gamePageUrl('http://127.0.0.1:8000/game.html', page), 'http://127.0.0.1:8000/game.html');
  assert.equal(gamePageUrl('https://elsewhere.example/game.html', page), null);
  assert.equal(gamePageUrl('', page), null);
  assert.equal(gamePageUrl(null, page), null);
});

test('/editor?scene=x opens the server’s game page with that query; ?game= any page of this server', () => {
  const page = 'http://localhost:8000/editor?scene=littlecityscene';
  assert.equal(gamePageFor('?scene=littlecityscene', page, '/demos/'), 'http://localhost:8000/demos/?scene=littlecityscene');
  assert.equal(gamePageFor('', 'http://localhost:8000/editor', '/demos/'), 'http://localhost:8000/demos/', 'none: the list');
  assert.equal(gamePageFor('?game=%2Fgame.html%3Flevel%3D2', page, '/demos/'), 'http://localhost:8000/game.html?level=2');
  assert.equal(gamePageFor('?game=https%3A%2F%2Felsewhere.example%2F', page, '/demos/'), null);
  assert.equal(gamePageFor('?scene=x', 'http://localhost:8000/src/core/debug/editor/shell/?scene=x', ''), null, 'no server: the form');
});

test('the address in its shortest form: the server’s game page’s own query, else ?game= and the path', () => {
  const page = 'http://localhost:8000/editor?game=x';
  assert.equal(editorQueryFor('http://localhost:8000/demos/?scene=littlecityscene', page, '/demos/'), '?scene=littlecityscene');
  assert.equal(editorQueryFor('http://localhost:8000/demos/index.html?scene=a', page, '/demos/'), '?scene=a', 'index.html is the folder');
  assert.equal(editorQueryFor('http://localhost:8000/demos/', page, '/demos/'), '');
  assert.equal(editorQueryFor('http://localhost:8000/game.html?level=2', page, '/demos/'), '?game=%2Fgame.html%3Flevel%3D2');
  assert.equal(editorQueryFor('http://localhost:8000/demos/?game=1', page, '/demos/'), '?game=%2Fdemos%2F%3Fgame%3D1', 'its own game param');
  assert.equal(editorQueryFor('http://localhost:8000/?a=1', page, ''), '?game=%2F%3Fa%3D1', 'no server game page');
  for (const game of ['http://localhost:8000/demos/?scene=a&debug=1', 'http://localhost:8000/x/y.html#z']) {
    const query = editorQueryFor(game, page, '/demos/');
    assert.equal(gamePageFor(query, page, '/demos/'), game, 'the short form opens the same page');
  }
});

test('the connected page’s scene being ready tells the editor page; another page’s does not', () => {
  const slots = {};
  for (const name of SLOT_NAMES) slots[name] = new Slot();
  let shown = 0;
  const host = new EditorHost({ slots, onSceneReady: () => shown++ });
  const page = { onHostKey() {} };
  host.sceneReady(page);
  assert.equal(shown, 0, 'not connected');
  host.connect(page);
  host.sceneReady({});
  host.sceneReady(page);
  assert.equal(shown, 1);
});

test('the Scene panel’s button opens the route the dev server names, else the page beside the source', async () => {
  const answer = (ok, route) => async () => ({ ok, headers: { get: (k) => (k === 'X-Weed-Editor' ? route : null) } });
  const fallback = 'http://localhost:8000/src/core/debug/editor/shell/';
  assert.equal(await editorPageFor('/demos/?scene=a', fallback, answer(true, '/editor')), '/editor?game=%2Fdemos%2F%3Fscene%3Da');
  assert.equal(await editorPageFor('/', fallback, answer(true, '/__weed/editor/')), '/__weed/editor/?game=%2F');
  const besideTheSource = `${fallback}?game=%2F`;
  assert.equal(await editorPageFor('/', fallback, answer(false, null)), besideTheSource, 'no route');
  assert.equal(await editorPageFor('/', fallback, answer(true, null)), besideTheSource, 'a page that is not the editor’s');
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await editorPageFor('/', fallback, offline), besideTheSource);
});

test('findEditorHost: only a parent of this origin with a host of this version', () => {
  const host = { version: HOST_VERSION };
  const top = {};
  top.parent = top;
  assert.equal(findEditorHost(top), null, 'not in a frame');
  assert.equal(findEditorHost({ parent: { [HOST_KEY]: host } }), host);
  assert.equal(findEditorHost({ parent: { [HOST_KEY]: { version: HOST_VERSION + 1 } } }), null, 'another version');
  assert.equal(findEditorHost({ parent: {} }), null, 'a parent that is no editor page');
  const crossOrigin = {
    get parent() {
      return new Proxy({}, { get: () => { throw new Error('SecurityError'); } });
    },
  };
  assert.equal(findEditorHost(crossOrigin), null, 'another origin throws on the read');
  assert.equal(findEditorHost(null), null);
});

test('editorPageUrl: beside the editor’s source when served from it, else the dev server’s route', () => {
  const moduleUrl = 'http://127.0.0.1:8000/src/core/debug/editorPage.js';
  assert.equal(editorPageUrl(moduleUrl, 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/src/core/debug/editor/shell/');
  assert.equal(
    editorPageUrl('file:///build/src/core/debug/editorPage.js', 'http://127.0.0.1:8000'),
    'http://127.0.0.1:8000/__weed/editor/',
    'a bundle: the route of npm run dev and of a game with @weed.js/editor',
  );
});

// ---- the game page's side ----

function hostedFor({ scene = { sceneScriptUrl: '/s.js' }, editing = false, handover = { version: 1, sceneScriptUrl: '/s.js' } } = {}) {
  const log = [];
  const editMode = {
    handover: () => handover,
    resume: async (kept) => log.push(['resume', kept]),
    save: () => log.push(['save']),
  };
  const debugUI = {
    scene,
    editing,
    editMode,
    toggleEditMode: () => log.push(['toggle']),
    onEditKey: (e) => {
      log.push(['editKey', e.key]);
      return true;
    },
  };
  const disconnects = [];
  const host = { disconnect: (client, state) => disconnects.push(state) };
  const hosted = new HostedEditor(debugUI, host);
  hosted.slots = {}; // connected, without the DOM
  return { hosted, log, disconnects, debugUI };
}

const keyEvent = (key, extra = {}) => {
  const e = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: null, prevented: false, ...extra };
  e.preventDefault = () => {
    e.prevented = true;
  };
  return e;
};

test('a page hands over its editor’s state; one that has not taken up what it was handed hands that back', () => {
  const removeEventListener = globalThis.window;
  globalThis.window = { removeEventListener() {} };
  try {
    const a = hostedFor();
    a.hosted.disconnect();
    assert.deepEqual(a.disconnects, [{ version: 1, sceneScriptUrl: '/s.js' }]);
    a.hosted.disconnect();
    assert.equal(a.disconnects.length, 1, 'once');

    const b = hostedFor();
    const pending = { version: 1, sceneScriptUrl: '/other.js' };
    b.hosted._kept = pending;
    b.hosted.onSceneReady(); // another scene runs: not its state
    assert.deepEqual(b.log, []);
    b.hosted.disconnect();
    assert.equal(b.disconnects[0], pending, 'handed back as it was');
  } finally {
    globalThis.window = removeEventListener;
  }
});

test('the state is taken up once the same scene is ready', () => {
  const { hosted, log } = hostedFor();
  const kept = { version: 1, sceneScriptUrl: '/s.js' };
  hosted._kept = kept;
  hosted.onSceneReady();
  hosted.onSceneReady();
  assert.deepEqual(log, [['resume', kept]]);
  assert.equal(hosted._kept, null);
});

test('keys from the editor page: Shift+E toggles, Ctrl+S saves even while playing, the rest only while editing', () => {
  const playing = hostedFor();
  const shiftE = keyEvent('E', { shiftKey: true });
  playing.hosted.onHostKey(shiftE);
  const save = keyEvent('s', { ctrlKey: true });
  playing.hosted.onHostKey(save);
  playing.hosted.onHostKey(keyEvent('Delete'));
  assert.deepEqual(playing.log, [['toggle'], ['save']]);
  assert.equal(save.prevented, true, 'never the browser’s Save Page');

  const editing = hostedFor({ editing: true });
  const field = { tagName: 'INPUT' };
  editing.hosted.onHostKey(keyEvent('Delete', { target: field })); // a field keeps its keys
  editing.hosted.onHostKey(keyEvent('E', { shiftKey: true, target: field })); // typing a capital E
  editing.hosted.onHostKey(keyEvent('s', { ctrlKey: true, target: field }));
  editing.hosted.onHostKey(keyEvent('Delete'));
  assert.deepEqual(editing.log, [['editKey', 's'], ['editKey', 'Delete']]);
});
