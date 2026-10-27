// What the editor keeps across a reload of the game page in the editor page (VISUAL_EDITOR_PLAN.md D9, ED-15):
// handover() is plain data (a copy survives structuredClone, and holds no object of the page), and resume() in the
// next page opens the kept file again with its unsaved document, gives the records their editor ids back by name,
// takes up the undo stack where it was, and comes back to edit mode, the view and the selection. Another scene's
// state is not taken up. Play and Stop (D8, ED-16) go back the same way: Stop swaps to the document, in edit mode.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { recordOf, editorIdOf, nextEditorIdToGive } from '../../src/core/debug/editor/sceneDocument.js';
import { Messages } from '../../src/core/messages.js';
import { Transform } from '../../src/components/transform.js';
import { Time } from '../../src/core/timeScale.js';
import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';

const FILE = 'http://host/levels/1-1.scene.json';

/** A scene of the platformer's shape: two platforms placed by its file, live at indices 1 and 2. */
function makeScene(file = FILE) {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(64) }, []);
  Transform.entityType = new Uint8Array(64);
  let next = 10;
  class Platform {
    static spawnParams = { width: { value: 220 } };
    static poolSize = 32;
    static spawn() {
      return { index: next++ };
    }
    static despawn() {}
  }
  return {
    sceneScriptUrl: 'http://host/platformer.js',
    sceneFileUrl: file,
    data: { levelsDone: 0 },
    sceneFile: {
      format: 1,
      script: '../platformer.js',
      entities: [
        { name: 'Platform1', class: 'Platform', x: 100, y: 200, config: { width: 400 } },
        { name: 'Platform2', class: 'Platform', x: 500, y: 200 },
      ],
    },
    registeredClasses: [{ class: Platform }],
    _namedEntities: new Map([
      ['Platform1', 1 * 65536],
      ['Platform2', 2 * 65536],
    ]),
  };
}

function setup(scene) {
  Time.bind(new SharedArrayBuffer(4));
  Time.scale = 1;
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data.set([1, 0, 0, 400, 300, 1]);
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Camera.setFree(false);
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const loads = [];
  const debugUI = {
    scene,
    gameEngine: {
      canvas: {},
      loadScene: async (url, options) => {
        loads.push([url, options]);
        // A fast swap: the same scene object, the file's content as given (copied, as loadScene does).
        scene.sceneFileUrl = url;
        if (options.sceneFile) scene.sceneFile = structuredClone(options.sceneFile);
        debugUI.editMode.onContentSwapped();
        return true;
      },
    },
    tools: { deactivateAll() {}, updateToolIndicator() {}, _syncDebugToolFlag() {}, _classNameForType: () => 'Platform' },
    panels: { scene: { updateEditButton() {} } },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  debugUI.editMode = editMode;
  editMode.palette = { show() {}, hide() {}, refresh() {}, destroy() {} };
  editMode.selection._show = () => {};
  return { editMode, loads };
}

function teardown(editMode) {
  editMode.exit();
  clearTimeout(editMode._statusTimer);
  delete globalThis.document;
  Camera.held = false;
  Camera.setFree(false);
}

/** The first page: an edit to Platform1, a rename of Platform2, Platform1 selected, the view moved. */
function editedPage() {
  const scene = makeScene();
  const { editMode } = setup(scene);
  editMode.enter();
  editMode.move.snap = 16;
  editMode.selection.select(2);
  editMode.renameSelected('Ledge');
  editMode.selection.select(1);
  editMode.selection._hooks.onChange('width', 640);
  Camera.setFreeTarget(1234, 567);
  Camera.setZoom(1.5);
  return { scene, editMode };
}

test('a handover is plain data: a copy of it holds everything, and nothing of the page', () => {
  const { scene, editMode } = editedPage();
  try {
    const state = editMode.handover();
    const copy = structuredClone(state);
    assert.deepEqual(copy, state, 'nothing lost in a copy');
    assert.equal(copy.version, 1);
    assert.equal(copy.sceneFileUrl, FILE);
    assert.equal(copy.active, true);
    assert.equal(copy.selection, 'Platform1');
    assert.equal(copy.snap, 16);
    assert.deepEqual(copy.view, { x: 1234, y: 567, zoom: 1.5 });
    assert.deepEqual(copy.document.entities.map((e) => e.name), ['Platform1', 'Ledge'], 'unsaved: the document goes along');
    assert.equal(copy.document.entities[0].config.width, 640);
    assert.deepEqual(copy.editorIds.map(([name]) => name).sort(), ['Ledge', 'Platform1']);
    assert.ok(copy.nextEditorId > Math.max(...copy.editorIds.map(([, id]) => id)));
    assert.deepEqual(copy.history.done.map((c) => c.kind), ['rename', 'edit']);
    // Saved: the document stays behind, the file has it.
    editMode.history.markSaved();
    assert.equal(editMode.handover().document, null);
    assert.equal(scene.sceneFile.entities.length, 2);
  } finally {
    teardown(editMode);
  }
});

test('resume opens the file with the unsaved document, and undo goes on where it was', async () => {
  const first = editedPage();
  const kept = structuredClone(first.editMode.handover());
  teardown(first.editMode);

  // The next page loaded the file from disk: the edits are not in it.
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    assert.equal(await editMode.resume(kept), true);
    assert.equal(loads.length, 1);
    assert.equal(loads[0][0], FILE);
    assert.deepEqual(loads[0][1].data, { levelsDone: 0 }, 'with the running data');
    assert.deepEqual(loads[0][1].sceneFile, kept.document);
    assert.deepEqual(scene.sceneFile.entities.map((e) => e.name), ['Platform1', 'Ledge']);
    assert.equal(editMode.dirty, true, 'still unsaved');
    assert.equal(editMode.active, true);
    assert.equal(editMode.move.snap, 16);
    assert.equal(Camera._freeFollowX, 1234);
    assert.equal(Camera.zoom, 1.5);
    assert.equal(editMode.selection.name, 'Platform1', 'selected by name');
    // The kept ids are the records’ again, and new ones are given above them.
    for (const [name, id] of kept.editorIds) assert.equal(editorIdOf(recordOf(scene, name).record), id);
    assert.ok(nextEditorIdToGive() >= kept.nextEditorId);

    editMode.undo(); // the width
    assert.equal(recordOf(scene, 'Platform1').record.config.width, 400);
    editMode.undo(); // the rename, made by the page before
    assert.deepEqual(scene.sceneFile.entities.map((e) => e.name), ['Platform1', 'Platform2']);
    assert.equal(editMode.dirty, false, 'back to the file');
    editMode.redo();
    assert.equal(recordOf(scene, 'Ledge') !== null, true);
  } finally {
    teardown(editMode);
  }
});

test('resume in edit mode opens the file again, the level at its start; playing, the same file is not; another file is', async () => {
  const first = editedPage();
  first.editMode.history.markSaved();
  const kept = structuredClone(first.editMode.handover());
  teardown(first.editMode);

  const scene = makeScene();
  scene.sceneFile.entities[1].name = 'Ledge'; // the file as saved
  const same = setup(scene);
  try {
    assert.equal(await same.editMode.resume(kept), true);
    assert.deepEqual(
      same.loads.map(([url, options]) => [url, 'sceneFile' in options]),
      [[FILE, false]],
      'editing (ED-80): from disk, so the frames the page ran before this are undone',
    );
    assert.equal(same.editMode.active, true);
    assert.equal(same.editMode.dirty, false);
    assert.equal(same.editMode.history.canUndo, true, 'the stack is there');
  } finally {
    teardown(same.editMode);
  }

  const playing = setup(makeScene());
  try {
    assert.equal(await playing.editMode.resume({ ...kept, active: false }), true);
    assert.equal(playing.loads.length, 0, 'playing: the page’s own boot is the level’s start');
    assert.equal(playing.editMode.active, false);
  } finally {
    teardown(playing.editMode);
  }

  const other = makeScene('http://host/levels/1-2.scene.json'); // the page started at another level
  const swapped = setup(other);
  try {
    assert.equal(await swapped.editMode.resume(kept), true);
    assert.deepEqual(
      swapped.loads.map(([url, options]) => [url, 'sceneFile' in options]),
      [[FILE, false]],
      'the kept file, from disk',
    );
  } finally {
    teardown(swapped.editMode);
  }
});

test('another scene’s state is not taken up', async () => {
  const first = editedPage();
  const kept = structuredClone(first.editMode.handover());
  teardown(first.editMode);
  const scene = makeScene();
  scene.sceneScriptUrl = 'http://host/menu.js';
  const { editMode, loads } = setup(scene);
  try {
    assert.equal(await editMode.resume(kept), false);
    assert.equal(loads.length, 0);
    assert.equal(editMode.active, false);
    assert.equal(editMode.history.canUndo, false);
    assert.equal(await editMode.resume({ ...kept, version: 2 }), false, 'another version');
  } finally {
    teardown(editMode);
  }
});

// ---- Play and Stop (D8, ED-16): the same restore path ----

test('Stop: back to the level as the document has it now, in edit mode, the view where it is, the undo stack kept', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    editMode.enter();
    editMode.selection.select(1);
    editMode.selection._hooks.onChange('width', 640);
    Camera.setFreeTarget(321, 654);
    editMode.play();
    assert.equal(editMode.active, false);
    assert.equal(editMode.playing, true);
    // The game's camera followed its player: its top-left at (5000, 1000), so its center at (5400, 1300).
    Camera._data[1] = 5000;
    Camera._data[2] = 1000;
    // What the swap finds when it hands the new level over, before the workers resume (Scene._fastSwap).
    const atSwap = [];
    const swapped = editMode.onContentSwapped.bind(editMode);
    editMode.onContentSwapped = () => {
      Time.scale = 1; // the swap's reset (Scene._resetSceneWideStateForSwap)
      swapped();
      atSwap.push(editMode.active, Time.scale, Camera._freeFollowX, Camera._freeFollowY);
    };

    assert.equal(await editMode.stop(), true);
    assert.deepEqual(
      atSwap,
      [true, 0, 5400, 1300],
      'edit mode holds the new level before its workers resume, in the view it comes back to: not one frame plays, no other view shows',
    );
    assert.equal(loads.length, 1);
    assert.equal(loads[0][0], FILE);
    assert.equal(loads[0][1].sceneFile.entities[0].config.width, 640, 'the document, edits and all');
    assert.equal(editMode.active, true, 'in edit mode');
    assert.equal(editMode.playing, false);
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [5400, 1300], 'the view where the game left it (ED-80)');
    assert.equal(editMode.dirty, true, 'Stop does not save or drop edits');
    assert.equal(editMode.history.canUndo, true, 'the undo stack is the document’s, kept');
    assert.match(editMode.status, /^Stopped: 1-1\.scene\.json/);
    editMode.undo();
    assert.equal(recordOf(scene, 'Platform1').record.config.width, 400);
  } finally {
    teardown(editMode);
  }
});

test('Stop after the game went to another level: back to the file Play started from, with its document', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    editMode.enter();
    editMode.selection.select(2);
    editMode.renameSelected('Ledge'); // unsaved, in 1-1
    Camera.setFreeTarget(321, 654);
    editMode.play();
    // The goal: the game loads 1-2 (another document: its stack starts empty).
    await editMode.debugUI.gameEngine.loadScene('http://host/levels/1-2.scene.json', {
      data: { levelsDone: 1 },
      sceneFile: { format: 1, script: '../platformer.js', entities: [{ name: 'Boss', class: 'Platform', x: 0, y: 0 }] },
    });
    assert.equal(editMode.history.canUndo, false);
    loads.length = 0;

    assert.equal(await editMode.stop(), true);
    assert.equal(loads[0][0], FILE, 'the file Play started from');
    assert.deepEqual(loads[0][1].data, { levelsDone: 0 }, 'with the data it was loaded with');
    assert.deepEqual(scene.sceneFile.entities.map((e) => e.name), ['Platform1', 'Ledge'], 'its unsaved document');
    assert.equal(editMode.history.canUndo, true, 'and its undo stack');
    assert.equal(Camera._freeFollowX, 321, 'and the view Play started from: where the game was is in another level');
    editMode.undo();
    assert.deepEqual(scene.sceneFile.entities.map((e) => e.name), ['Platform1', 'Platform2']);
  } finally {
    teardown(editMode);
  }
});

test('Stop with no play session resets the level to its document; a scene without a file has nothing to go back to', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    assert.equal(await editMode.stop(), true, 'playing since the page loaded');
    assert.equal(loads.length, 1);
    assert.equal(editMode.active, true);
  } finally {
    teardown(editMode);
  }
  const fileless = makeScene(null);
  const second = setup(fileless);
  try {
    assert.equal(await second.editMode.stop(), false);
    assert.equal(second.loads.length, 0);
    assert.match(second.editMode.status, /not loaded from a scene file/);
  } finally {
    teardown(second.editMode);
  }
});

test('a play session goes along with a reload: Stop in the next page goes back to where Play started', async () => {
  const scene = makeScene();
  const first = setup(scene);
  first.editMode.enter();
  first.editMode.play();
  const kept = structuredClone(first.editMode.handover());
  teardown(first.editMode);
  assert.ok(kept.playStart, 'handed over');
  assert.equal(kept.playStart.data, undefined, 'without the page’s data');

  const next = makeScene();
  const { editMode, loads } = setup(next);
  try {
    assert.equal(await editMode.resume(kept), true);
    assert.equal(editMode.playing, true);
    assert.equal(await editMode.stop(), true);
    assert.equal(loads.at(-1)[0], FILE);
    assert.deepEqual(loads.at(-1)[1].data, { levelsDone: 0 }, 'the next page’s data');
  } finally {
    teardown(editMode);
  }
});

// ---- Play and Stop as Unity's (ED-80): edit mode is the level at its start ----

test('Shift+E: Play while editing; while playing, a Stop back to the level’s start; a scene with no file holds where it is', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    editMode.enter();
    editMode.toggle();
    assert.equal(editMode.playing, true, 'Play');
    editMode.toggle();
    assert.equal(editMode.active, true, 'edit mode at once: it holds the level the Stop swaps in');
    assert.equal(editMode.settled, false, 'the swap is on its way');
    assert.equal(await editMode.edit(), true, 'and edit() waits for it');
    assert.equal(editMode.settled, true);
    assert.equal(editMode.playing, false);
    assert.deepEqual(loads.map(([url]) => url), [FILE], 'one swap, to the document');
    assert.equal(await editMode.edit(), true, 'editing already: nothing more');
    assert.equal(loads.length, 1);
  } finally {
    teardown(editMode);
  }
  const fileless = setup(makeScene(null));
  try {
    assert.equal(await fileless.editMode.edit(), true);
    assert.equal(fileless.editMode.active, true, 'held where it is');
    assert.equal(fileless.loads.length, 0);
  } finally {
    teardown(fileless.editMode);
  }
});

test('the editor page opens editing: edit mode at once, the level’s start once the scene is ready, quietly', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    editMode.editFromStart();
    assert.equal(editMode.active, true, 'the world held at once');
    assert.equal(editMode.settled, false, 'its reset is on its way');
    assert.equal(loads.length, 0, 'not before the engine takes loads');
    editMode.onSceneReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(loads.map(([url]) => url), [FILE], 'the frames the boot ran are undone');
    assert.equal(editMode.settled, true);
    assert.doesNotMatch(editMode.status, /^Stopped/, 'no "Stopped" line on opening');
    editMode.onSceneReady(); // the next load (the game's own, a Stop's swap): no reset
    assert.equal(loads.length, 1);
  } finally {
    teardown(editMode);
  }
  // A scene with no file has no level to edit: it plays (the editor page shows its console, its live values).
  const fileless = setup(makeScene(null));
  try {
    fileless.editMode.editFromStart();
    fileless.editMode.onSceneReady();
    assert.equal(fileless.editMode.active, false);
    assert.equal(fileless.loads.length, 0);
  } finally {
    teardown(fileless.editMode);
  }
});

test('a full load while editing comes back to edit mode in the next scene, at its level’s start once it is ready', async () => {
  const scene = makeScene();
  const { editMode, loads } = setup(scene);
  try {
    editMode.enter();
    editMode.onDetach();
    editMode.onAttach();
    assert.equal(editMode.active, true);
    assert.equal(editMode.settled, false);
    editMode.onSceneReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(loads.map(([url]) => url), [FILE], 'the frames its boot ran are undone');
    assert.equal(editMode.settled, true);
  } finally {
    teardown(editMode);
  }
});
