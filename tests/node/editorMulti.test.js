// Several placed entities selected (VISUAL_EDITOR_PLAN.md ED-28): Shift+click adds and takes out, a drag on empty
// ground boxes what it touches, Ctrl+A takes them all; a move, Del and Ctrl+D act on all of them as one change that
// one undo takes back; Ctrl+G groups them (kept in the file under editor.groups), and a click on one of a group
// selects the group; a rename follows into the groups.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { Messages } from '../../src/core/messages.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { recordOf } from '../../src/core/debug/editor/sceneDocument.js';
import { groupsOf } from '../../src/core/debug/editor/multiSelect.js';

const N = 64;

/** Platforms that spawn where their record says, as 100 × 20 boxes, into slots 10 and up. */
function makeScene() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
  const free = [];
  for (let i = N - 1; i >= 10; i--) free.push(i);
  class Platform {
    static spawnParams = { width: { value: 100 } };
    static poolSize = 40;
    static spawn(cfg) {
      const i = free.pop();
      Transform.active[i] = 1;
      Transform.x[i] = cfg.x;
      Transform.y[i] = cfg.y;
      Collider.active[i] = 1;
      Collider.shapeType[i] = ShapeType.Box;
      Collider.width[i] = 100;
      Collider.height[i] = 20;
      return { index: i };
    }
    static despawn(i) {
      Transform.active[i] = 0;
      Collider.active[i] = 0;
      Messages.spawnGen[i]++;
      free.push(i);
    }
  }
  const scene = {
    constructor: { name: 'Level' },
    sceneFile: { format: 1, script: 's.js', entities: [] },
    registeredClasses: [{ class: Platform }],
    _namedEntities: new Map(),
    sceneFileUrl: 'http://host/levels/a.scene.json',
  };
  // Four platforms in a row, 200 px apart.
  for (let k = 0; k < 4; k++) {
    const record = { name: `P${k + 1}`, class: 'Platform', x: 200 * k, y: 100 };
    scene.sceneFile.entities.push(record);
    const { index } = Platform.spawn(record);
    scene._namedEntities.set(record.name, index * 65536);
  }
  return scene;
}

function editorFor(scene) {
  const debugUI = {
    scene,
    tools: { _classNameForType: () => 'Platform', updateToolIndicator() {}, deactivateAll() {}, _syncDebugToolFlag() {} },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
    panels: { scene: { updateEditButton() {} } },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  debugUI.editMode = editMode;
  editMode.selection._show = () => {};
  editMode.palette = { show() {}, hide() {}, refresh() {}, destroy() {} };
  return editMode;
}

const press = (editMode, x, y, extra = {}) => {
  const e = { shiftKey: false, clientX: 0, clientY: 0, ...extra };
  const took = editMode.multi.press(x, y, e);
  return { took, e };
};
const names = (editMode) => editMode.multi.selectedNames();
const xs = (scene) => scene.sceneFile.entities.map((r) => r.x);

test('Shift+click adds and takes out; a plain click elsewhere starts over; the box takes what it touches', () => {
  const scene = makeScene();
  const editMode = editorFor(scene);
  try {
    assert.equal(press(editMode, 0, 100, { shiftKey: true }).took, true);
    assert.deepEqual(names(editMode), ['P1'], 'the first one goes to the inspector');
    press(editMode, 200, 100, { shiftKey: true });
    press(editMode, 400, 100, { shiftKey: true });
    assert.deepEqual(names(editMode), ['P1', 'P2', 'P3']);
    press(editMode, 200, 100, { shiftKey: true });
    assert.deepEqual(names(editMode), ['P1', 'P3'], 'again: out');
    assert.equal(press(editMode, 400, 100).took, false, 'on a selected one: the move tool drags them all');
    assert.deepEqual(names(editMode), ['P1', 'P3']);
    assert.equal(press(editMode, 600, 100).took, false);
    assert.equal(editMode.multi.count, 0, 'a plain click on another one starts over (the move tool selects it)');

    // A box from (150, 50) to (450, 150) touches P2 and P3.
    assert.equal(press(editMode, 150, 50, { clientX: 0, clientY: 0 }).took, true, 'empty ground: a box');
    editMode.multi.move(450, 150, { clientX: 300, clientY: 100 });
    editMode.multi.release();
    assert.deepEqual(names(editMode), ['P2', 'P3']);
    press(editMode, 150, 300, { clientX: 0, clientY: 0 });
    editMode.multi.release();
    assert.deepEqual(names(editMode), [], 'a click on empty ground clears');
    assert.equal(editMode.multi.onKey({ key: 'a', ctrlKey: true }), true);
    assert.deepEqual(names(editMode), ['P1', 'P2', 'P3', 'P4'], 'Ctrl+A');
    assert.equal(editMode.multi.onKey({ key: 'Escape' }), true);
    assert.deepEqual(names(editMode), ['P1'], 'Esc lets go of the others first');
  } finally {
    clearTimeout(editMode._statusTimer);
  }
});

test('a move, Del and Ctrl+D act on all of them, each one change that one undo takes back', () => {
  const scene = makeScene();
  const editMode = editorFor(scene);
  try {
    editMode.multi.selectNames(['P1', 'P3']);
    editMode.moveSelectedTo(16, 132); // P1 to (16, 132): P3 by the same step
    assert.deepEqual(xs(scene), [16, 200, 416, 600]);
    assert.equal(recordOf(scene, 'P3').record.y, 132);
    assert.deepEqual(names(editMode), ['P1', 'P3'], 'still selected');
    editMode.undo();
    assert.deepEqual(xs(scene), [0, 200, 400, 600], 'one undo, both back');
    editMode.redo();
    assert.deepEqual(xs(scene), [16, 200, 416, 600]);

    editMode.duplicateSelected();
    assert.deepEqual(scene.sceneFile.entities.map((r) => r.name), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    assert.deepEqual(names(editMode), ['P5', 'P6'], 'the copies are selected');
    editMode.deleteSelected();
    assert.equal(scene.sceneFile.entities.length, 4);
    assert.deepEqual(names(editMode), []);
    editMode.undo(); // the delete
    assert.deepEqual(names(editMode), ['P5', 'P6']);
    assert.equal(scene.sceneFile.entities.length, 6);
    editMode.undo(); // the duplicate
    assert.deepEqual(scene.sceneFile.entities.map((r) => r.name), ['P1', 'P2', 'P3', 'P4']);
    assert.deepEqual(names(editMode), ['P1', 'P3']);
  } finally {
    clearTimeout(editMode._statusTimer);
  }
});

test('Del of several puts each back at its place in the file on undo', () => {
  const scene = makeScene();
  const editMode = editorFor(scene);
  try {
    editMode.multi.selectNames(['P2', 'P4', 'P1']);
    editMode.deleteSelected();
    assert.deepEqual(scene.sceneFile.entities.map((r) => r.name), ['P3']);
    editMode.undo();
    assert.deepEqual(scene.sceneFile.entities.map((r) => r.name), ['P1', 'P2', 'P3', 'P4']);
    for (const name of ['P1', 'P2', 'P4']) assert.ok(scene._namedEntities.has(name), `${name} is live again`);
  } finally {
    clearTimeout(editMode._statusTimer);
  }
});

test('Ctrl+G groups them in the file; a click on one selects the group; a rename follows; undo and ungroup', () => {
  const scene = makeScene();
  const editMode = editorFor(scene);
  try {
    editMode.multi.selectNames(['P1', 'P2']);
    assert.equal(editMode.multi.onKey({ key: 'g', ctrlKey: true, shiftKey: false }), true);
    assert.deepEqual(groupsOf(scene.sceneFile), [['P1', 'P2']]);
    editMode.multi.selectNames([]);
    press(editMode, 200, 100); // P2: the move tool selects it, the group comes along
    editMode.selection.select(Math.floor(scene._namedEntities.get('P2') / 65536));
    assert.deepEqual(names(editMode).sort(), ['P1', 'P2']);
    editMode.multi.selectNames(['P1']);
    editMode.renameSelected('Ground');
    assert.deepEqual(groupsOf(scene.sceneFile), [['Ground', 'P2']], 'the rename follows into the group');
    editMode.undo(); // the rename
    editMode.undo(); // the group
    assert.deepEqual(groupsOf(scene.sceneFile), []);
    assert.equal(scene.sceneFile.editor, undefined, 'no editor key left in the file');
    editMode.redo();
    editMode.multi.selectNames(['P2']);
    assert.equal(editMode.multi.onKey({ key: 'G', ctrlKey: true, shiftKey: true }), true);
    assert.deepEqual(groupsOf(scene.sceneFile), [], 'ungrouped');
    editMode.multi.selectNames(['P3']);
    assert.equal(editMode.groupSelected(), false, 'one is no group');
  } finally {
    clearTimeout(editMode._statusTimer);
  }
});
