// The editor and the scene file's joints (VISUAL_EDITOR_PLAN.md ED-21): a joint holds two entity indices, so the
// editor makes the file's joints of an entity again each time it respawns it, and drops the joints on a slot before
// it despawns the entity there. A rename follows into the joints; a delete takes them out, and its undo puts them
// back. The inspector's joints panel adds, removes and changes them, each change one undo kept as data.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Messages } from '../../src/core/messages.js';
import { Transform } from '../../src/components/transform.js';
import { Joint } from '../../src/core/joint.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { spawnSceneFileJoints } from '../../src/core/sceneFileJoints.js';
import { serializeSceneFile } from '../../src/core/sceneFile.js';
import { setParam, removePlaced, renamePlaced, recordOf } from '../../src/core/debug/editor/sceneDocument.js';
import { editJoints, newJoint, JointsPanel } from '../../src/core/debug/editor/jointsPanel.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';

function bootJoints(maxJoints = 8, entities = 64) {
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(maxJoints, entities)), maxJoints, entities);
  const freeList = new SharedArrayBuffer(maxJoints * 2);
  const freeListTop = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTop), new Uint16Array(freeList), maxJoints, 1);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeList, freeListTop);
}

/** Door #1, Frame #2 and Lamp #3, a hinge between the door and the frame, made by the loader. */
function makeScene() {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(64) }, []);
  Transform.entityType = new Uint8Array(64);
  bootJoints();
  let next = 10;
  class Block {
    static spawnParams = { width: { value: 80 } };
    static spawn() {
      return { index: next++ };
    }
    static despawn() {}
  }
  const scene = {
    constructor: { name: 'Level' },
    sceneFileUrl: 'http://host/levels/a.scene.json',
    sceneFile: {
      format: 1,
      script: 's.js',
      entities: [
        { name: 'Door', class: 'Block', x: 100, y: 200 },
        { name: 'Frame', class: 'Block', x: 160, y: 200 },
        { name: 'Lamp', class: 'Block', x: 100, y: 100 },
      ],
      joints: [{ type: 'revolute', a: 'Door', b: 'Frame', anchorA: [30, 0], anchorB: [-30, 0] }],
    },
    registeredClasses: [{ class: Block }],
    _namedEntities: new Map([
      ['Door', 1 * 65536],
      ['Frame', 2 * 65536],
      ['Lamp', 3 * 65536],
    ]),
    _fileJoints: new Map(),
    _restorePayload: null,
  };
  spawnSceneFileJoints(scene);
  return scene;
}

/** The live joints, as [type, entity A, entity B, anchor A x, anchor B x], sorted. */
function liveJoints() {
  const out = [];
  for (let slot = 0; slot < Joint.getDenseActiveCount(); slot++) {
    const i = Joint.activeIndices[slot];
    out.push([Joint.type[i], Joint.getEntityA(i), Joint.getEntityB(i), Joint.localAnchorAX[i], Joint.localAnchorBX[i]]);
  }
  return out.sort((p, q) => p[1] - q[1] || p[2] - q[2]);
}

test('a respawn makes the entity’s joints again on its new index; a rename follows; a delete takes them out', () => {
  const scene = makeScene();
  const REVOLUTE = Joint.TYPE.REVOLUTE;
  assert.deepEqual(liveJoints(), [[REVOLUTE, 1, 2, 30, -30]]);
  // A code joint on the door's slot: it goes with the door's despawn instead of waiting for the slot's next entity.
  Joint.addWeld({ entityA: 1, entityB: 3 });

  const door = setParam(scene, 'Door', 'width', 120);
  assert.equal(door, 10);
  assert.deepEqual(liveJoints(), [[REVOLUTE, 10, 2, 30, -30]], 'between the new door and the frame; the code weld went');

  assert.equal(renamePlaced(scene, 'Door', 'Gate'), true);
  assert.equal(scene.sceneFile.joints[0].a, 'Gate');
  assert.deepEqual(liveJoints(), [[REVOLUTE, 10, 2, 30, -30]], 'a rename changes no joint');

  setParam(scene, 'Frame', 'width', 90); // the frame respawns: #11
  assert.deepEqual(liveJoints(), [[REVOLUTE, 10, 11, 30, -30]]);

  removePlaced(scene, 'Gate');
  assert.equal(scene.sceneFile.joints, undefined, 'its only joint left with it, and the section');
  assert.deepEqual(liveJoints(), []);
  assert.doesNotMatch(serializeSceneFile(scene.sceneFile), /joints/);
  Joint.reset();
});

function editorFor(scene) {
  const debugUI = {
    scene,
    tools: { _classNameForType: () => 'Block', updateToolIndicator() {} },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
  };
  const editMode = new EditMode(debugUI);
  editMode.selection._show = () => {};
  return editMode;
}

test('adding, changing and removing joints are each one undo; a delete’s undo puts its joints back', () => {
  const scene = makeScene();
  const editMode = editorFor(scene);
  const W = Joint.TYPE.WELD;
  const R = Joint.TYPE.REVOLUTE;
  editMode.selection.select(1); // the door
  assert.equal(editJoints(editMode, 'add', (js) => js.push(newJoint(scene, 'Door', 'Lamp', 'weld'))), true);
  assert.deepEqual(scene.sceneFile.joints[1], { type: 'weld', a: 'Door', b: 'Lamp', anchorA: [0, -50], anchorB: [0, 50] }, 'halfway between');
  assert.deepEqual(liveJoints(), [[R, 1, 2, 30, -30], [W, 1, 3, 0, 0]]);
  assert.equal(editJoints(editMode, 'nothing', () => {}), false, 'a write that changes nothing is no change');
  assert.equal(editJoints(editMode, 'bad', (js) => (js[1].b = 'Door')), false, 'a joint the file format refuses');
  assert.match(editMode.status, /"a" and "b" both name Door/);
  editJoints(editMode, 'anchor', (js) => (js[0].anchorA = [25, 5]));
  assert.deepEqual(liveJoints(), [[R, 1, 2, 25, -30], [W, 1, 3, 0, 0]]);

  editMode.selection.select(1);
  editMode.deleteSelected();
  assert.equal(scene.sceneFile.joints, undefined);
  assert.deepEqual(liveJoints(), []);

  const history = structuredClone(editMode.history.toData());
  editMode.undo(); // the delete: the door, and both joints, on its new index
  const door = scene._namedEntities.get('Door') / 65536;
  assert.deepEqual(scene.sceneFile.joints.map((j) => j.type), ['revolute', 'weld']);
  assert.deepEqual(liveJoints(), [[R, door, 2, 25, -30], [W, door, 3, 0, 0]]);
  editMode.undo(); // the anchor
  assert.deepEqual(scene.sceneFile.joints[0].anchorA, [30, 0]);
  editMode.undo(); // the weld
  assert.deepEqual(liveJoints(), [[R, door, 2, 30, -30]]);
  assert.equal(editMode.dirty, false);
  editMode.redo();
  editMode.redo();
  editMode.redo();
  assert.deepEqual(liveJoints(), [], 'and the delete again');

  // The history is data: the next page's editor (D9) applies it on its own.
  const next = editorFor(scene);
  next.history.load(history);
  next.undo();
  assert.equal(scene.sceneFile.joints.length, 2);
  assert.equal(liveJoints().length, 2);
  clearTimeout(editMode._statusTimer);
  clearTimeout(next._statusTimer);
  Joint.reset();
});

// ---- the panel, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.title = '';
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = text;
    this.children = [];
  }
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
  find(fn) {
    for (const el of this.all()) if (fn(el)) return el;
    return null;
  }
}

test('the panel lists the entity’s joints; its fields add, change and remove them', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const scene = makeScene();
    const editMode = editorFor(scene);
    const selection = editMode.selection;
    const panel = new JointsPanel(selection);
    selection.select(2); // the frame
    selection.name = 'Frame';
    editMode._showRestored = () => panel.show(selection.name);
    panel.show('Frame');
    const rows = () => [...panel.el.all()].filter((el) => el.dataset.joint !== undefined);
    assert.equal(rows().length, 1);
    const row = rows()[0];
    assert.equal(row.find((el) => el.dataset.jointOther !== undefined).value, 'Door', 'the other entity');
    // The frame is the joint's b: its "here" anchor is anchorB.
    const here = row.find((el) => el.dataset.anchor === 'anchorB.x');
    assert.equal(here.value, '-30');
    here.value = '-20';
    here.onchange();
    assert.deepEqual(scene.sceneFile.joints[0].anchorB, [-20, 0]);

    const settings = rows()[0].find((el) => el.dataset.jointSettings !== undefined);
    settings.value = '{ "enableLimit": true, "upperAngle": 0.75 }';
    settings.onchange();
    assert.equal(scene.sceneFile.joints[0].upperAngle, 0.75);
    assert.equal(Joint.upperAngle[liveIndexOfJoint(scene, 0)], 0.75);
    const stray = rows()[0].find((el) => el.dataset.jointSettings !== undefined);
    stray.value = '{ "length": 4 }';
    stray.onchange();
    assert.equal(stray.style.borderColor, '#f87171', 'a key a revolute joint does not take');
    assert.equal(scene.sceneFile.joints[0].length, undefined);

    const addType = panel.el.find((el) => el.dataset.jointAddType !== undefined);
    const addOther = panel.el.find((el) => el.dataset.jointAddOther !== undefined);
    addType.value = 'distance';
    addOther.value = 'Lamp';
    panel.el.find((el) => el.dataset.jointAdd !== undefined).onclick();
    assert.deepEqual(scene.sceneFile.joints[1], { type: 'distance', a: 'Frame', b: 'Lamp', anchorA: [0, 0], anchorB: [0, 0] });
    assert.equal(rows().length, 2);
    // Its length: the distance as placed, (160, 200) to (100, 100).
    assert.ok(Math.abs(Joint.length[liveIndexOfJoint(scene, 1)] - Math.sqrt(60 * 60 + 100 * 100)) < 1e-3);

    rows()[0].find((el) => el.dataset.jointRemove !== undefined).onclick();
    assert.deepEqual(scene.sceneFile.joints.map((j) => j.type), ['distance']);
    assert.equal(Joint.getDenseActiveCount(), 1);
    assert.equal(editMode.history._done.length, 4, 'one undo each');
    clearTimeout(editMode._statusTimer);
  } finally {
    delete globalThis.document;
    Joint.reset();
  }
});

/** The pool index of the joint the file made from its joints[position]. */
function liveIndexOfJoint(scene, position) {
  return scene._fileJoints.get(scene.sceneFile.joints[position]).index;
}

test('newJoint: a distance joint holds the centers; the others hold the entities where they are', () => {
  const scene = makeScene();
  assert.deepEqual(newJoint(scene, 'Door', 'Frame', 'distance').anchorA, [0, 0]);
  assert.deepEqual(newJoint(scene, 'Door', 'Frame', 'prismatic'), { type: 'prismatic', a: 'Door', b: 'Frame', anchorA: [30, 0], anchorB: [-30, 0] });
  assert.equal(recordOf(scene, 'Door').record.x, 100);
  Joint.reset();
});
