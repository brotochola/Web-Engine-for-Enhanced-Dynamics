// Placing, duplicating, deleting and renaming in edit mode (VISUAL_EDITOR_PLAN.md ED-11): the palette lists the
// scene's classes with how many the file places against each pool; a click places one at the cursor (on the grid)
// under a name the file does not use; Ctrl+D copies the selection; Del takes it out; a rename keeps names unique and
// follows the entity params that name it. Each is one entry of undo, which finds its record by an editor id the
// file never holds, so a rename or a delete in between does not lose it. A full pool says which count to raise.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Messages } from '../../src/core/messages.js';
import { Transform } from '../../src/components/transform.js';
import { serializeSceneFile } from '../../src/core/sceneFile.js';
import {
  uniqueName,
  addPlaced,
  removePlaced,
  renamePlaced,
  recordOf,
  editorIdOf,
  nameOfEditorId,
} from '../../src/core/debug/editor/sceneDocument.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { Palette } from '../../src/core/debug/editor/palette.js';

function makeScene({ platformPool = 64 } = {}) {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(256) }, []);
  Transform.entityType = new Uint8Array(256);
  const calls = [];
  let next = 10;
  const spawner = (name, pool) => ({
    poolSize: pool,
    live: 0,
    spawn(cfg) {
      if (this.live >= this.poolSize) return null;
      this.live++;
      calls.push(['spawn', name, { ...cfg }]);
      return { index: next++ };
    },
    despawn(i) {
      this.live--;
      calls.push(['despawn', name, i]);
    },
  });
  class Platform {
    static spawnParams = { width: { value: 220 } };
  }
  Object.assign(Platform, spawner('Platform', platformPool));
  class Lever {
    static spawnParams = { door: { value: null, type: 'entity', class: 'Platform' } };
  }
  Object.assign(Lever, spawner('Lever', 8));
  class Flash {}
  Object.assign(Flash, spawner('Flash', 4));
  const scene = {
    constructor: { name: 'PlatformerGameScene' },
    sceneFile: {
      format: 1,
      script: 's.js',
      entities: [
        { name: 'Platform1', class: 'Platform', x: 100, y: 200, config: { width: 400 } },
        { name: 'Lever1', class: 'Lever', x: 10, y: 20, config: { door: 'Platform1' } },
      ],
    },
    registeredClasses: [{ class: Platform }, { class: Lever }, { class: Flash }],
    _namedEntities: new Map([
      ['Platform1', 1 * 65536],
      ['Lever1', 2 * 65536],
    ]),
  };
  Platform.live = 1;
  Lever.live = 1;
  return { scene, calls, Platform };
}

test('uniqueName: the base without its digits, then the smallest free number', () => {
  const { scene } = makeScene();
  assert.equal(uniqueName(scene, 'Platform'), 'Platform2');
  assert.equal(uniqueName(scene, 'Platform1'), 'Platform2', 'a copy of Platform1');
  assert.equal(uniqueName(scene, 'Goal'), 'Goal1');
});

test('add, remove and rename in the document: spawns, despawns, and the entities that name it follow', () => {
  const { scene, calls } = makeScene();
  removePlaced(scene, 'Platform1');
  assert.equal(recordOf(scene, 'Platform1'), null);
  assert.deepEqual(calls, [
    ['despawn', 'Platform', 1],
    ['despawn', 'Lever', 2],
    ['spawn', 'Lever', { x: 10, y: 20, door: -1 }],
  ], 'the lever respawns without its door; its param keeps the name');
  calls.length = 0;
  const index = addPlaced(scene, { name: 'Platform1', class: 'Platform', x: 100, y: 200, config: { width: 400 } }, 0);
  assert.equal(index, 11);
  assert.equal(scene.sceneFile.entities[0].name, 'Platform1', 'back at its place in the file');
  assert.deepEqual(calls.at(-1), ['spawn', 'Lever', { x: 10, y: 20, door: 11 }], 'and the lever has its door again');

  assert.equal(renamePlaced(scene, 'Platform1', 'Lever1'), false, 'taken');
  assert.equal(renamePlaced(scene, 'Platform1', '  '), false, 'empty');
  assert.equal(renamePlaced(scene, 'Platform1', 'Door'), true);
  assert.equal(recordOf(scene, 'Lever1').record.config.door, 'Door', 'the lever names it by its new name');
  assert.equal(scene._namedEntities.has('Door'), true);
  assert.equal(scene._namedEntities.has('Platform1'), false);
});

test('an editor id finds a record whatever its name, and the file never holds it', () => {
  const { scene } = makeScene();
  const record = recordOf(scene, 'Platform1').record;
  const id = editorIdOf(record);
  assert.equal(editorIdOf(record), id, 'made once');
  renamePlaced(scene, 'Platform1', 'Ground');
  assert.equal(nameOfEditorId(scene, id), 'Ground');
  assert.doesNotMatch(serializeSceneFile(scene.sceneFile), /_editorId/);
  assert.equal(structuredClone(record)._editorId, undefined, 'a copy has none until it is given one');
});

function editorFor(scene) {
  const debugUI = {
    scene,
    tools: { _classNameForType: () => 'Platform', updateToolIndicator() {} },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
  };
  const editMode = new EditMode(debugUI);
  editMode.selection._show = () => {};
  return editMode;
}

test('place, duplicate, delete and rename are each one undo, and survive one another', () => {
  const { scene } = makeScene();
  const editMode = editorFor(scene);
  editMode.move.snap = 8;
  const placed = editMode.place('Platform', 1003, 498);
  assert.equal(editMode.selection.name, 'Platform2');
  assert.deepEqual(recordOf(scene, 'Platform2').record, { name: 'Platform2', class: 'Platform', x: 1000, y: 496 });
  assert.equal(editMode.selection.index, placed);

  editMode.selection.select(1);
  editMode.duplicateSelected();
  const copy = recordOf(scene, 'Platform3');
  assert.deepEqual(
    { ...copy.record },
    { name: 'Platform3', class: 'Platform', x: 116, y: 216, config: { width: 400 } },
    'a grid step of at least 16 px away',
  );
  assert.equal(copy.position, 1, 'right after the original in the file');

  editMode.renameSelected('Ledge');
  assert.equal(editMode.selection.name, 'Ledge');
  editMode.selection._hooks.onChange('width', 500); // an edit after the rename
  editMode.deleteSelected();
  assert.equal(recordOf(scene, 'Ledge'), null);
  assert.equal(editMode.selection.index, -1);

  const names = () => scene.sceneFile.entities.map((e) => e.name);
  editMode.undo(); // the delete
  assert.deepEqual(names(), ['Platform1', 'Ledge', 'Lever1', 'Platform2']);
  editMode.undo(); // the width
  assert.deepEqual(recordOf(scene, 'Ledge').record.config, { width: 400 });
  editMode.undo(); // the rename
  assert.deepEqual(names(), ['Platform1', 'Platform3', 'Lever1', 'Platform2']);
  editMode.undo(); // the duplicate
  editMode.undo(); // the place
  assert.deepEqual(names(), ['Platform1', 'Lever1']);
  assert.equal(editMode.dirty, false);
  for (let i = 0; i < 5; i++) editMode.redo();
  assert.deepEqual(names(), ['Platform1', 'Lever1', 'Platform2'], 'and all of it again, the delete last');
  assert.equal(recordOf(scene, 'Ledge'), null);
  clearTimeout(editMode._statusTimer);
});

test('a full pool places nothing and says which count to raise', () => {
  const { scene } = makeScene({ platformPool: 1 });
  const editMode = editorFor(scene);
  assert.equal(editMode.place('Platform', 0, 0), -1);
  assert.equal(scene.sceneFile.entities.length, 2, 'no record');
  assert.equal(editMode.history.canUndo, false);
  assert.equal(editMode.status, 'Platform: its pool of 1 is full. Raise its count in PlatformerGameScene.entities');
  assert.equal(editMode.statusIsError, true);
  clearTimeout(editMode._statusTimer);
});

test('the keys: Ctrl+D, Del, and Esc stops placing before it clears the selection', () => {
  const { scene } = makeScene();
  const editMode = editorFor(scene);
  const key = (k, extra = {}) => editMode.onKey({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  editMode.selection.select(1);
  key('d', { ctrlKey: true });
  assert.equal(editMode.selection.name, 'Platform2');
  assert.equal(key('Delete'), true);
  assert.equal(recordOf(scene, 'Platform2'), null);
  assert.equal(key('Delete'), false, 'nothing selected');
  editMode.startPlacing('Platform');
  assert.equal(editMode.placing, 'Platform');
  key('Escape');
  assert.equal(editMode.placing, null);
  clearTimeout(editMode._statusTimer);
});

// ---- the palette, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { set: new Set(), add(c) { this.set.add(c); } };
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = text;
    this.children = [];
  }
}

test('the palette lists the scene’s classes with the file’s count against each pool, not the engine’s own', () => {
  const { scene } = makeScene();
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const placing = [];
    const editMode = { debugUI: { scene }, placing: 'Lever', startPlacing: (c) => placing.push(c) };
    const palette = new Palette(editMode);
    palette._list = new El('div');
    palette.refresh();
    const rows = palette._list.children;
    assert.deepEqual(rows.map((r) => r.dataset.className), ['Platform', 'Lever'], 'no Flash');
    assert.deepEqual(rows.map((r) => r.children[2].textContent), ['1 / 64', '1 / 8']);
    assert.equal(rows[1].children[0].classList.set.has('active'), true, 'the class being placed');
    rows[0].children[0].onclick();
    assert.deepEqual(placing, ['Platform']);
  } finally {
    delete globalThis.document;
  }
});
