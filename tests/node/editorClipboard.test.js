// Copy and paste of placed entities (VISUAL_EDITOR_PLAN.md ED-59, clipboard.js): Ctrl+C keeps the selected records
// and the joints between them; Ctrl+V adds them again named anew, a step off (or at the pointer), as one undo,
// selected; an entity param naming a copied entity names its copy; a copy keeps its original's look (its seed), as
// a duplicate does. The real EditMode over the handles tests' world.
import test from 'node:test';
import assert from 'node:assert/strict';

import { copyEntities, writeClipboard, readClipboard, pastePlan, CLIPBOARD_KIND } from '../../src/core/debug/editor/clipboard.js';
import { placedSeed } from '../../src/core/sceneFile.js';
import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

const ctrl = (key, extra = {}) => ({ key, ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, ...extra });
const names = (scene) => scene.sceneFile.entities.map((e) => e.name);

function withStorage(storage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('Ctrl+C then Ctrl+V: a copy a step off, named anew, looking the same; one undo; selected', () => {
  const world = makeWorld();
  try {
    withStorage(memoryStorage(), () => {
      const { editMode, scene } = world;
      world.select('Block1');
      assert.equal(editMode.onKey(ctrl('c')), true);
      const before = names(scene).length;
      assert.equal(editMode.onKey(ctrl('v')), true);
      const copy = world.record('Block2');
      assert.ok(copy, `pasted as Block2: ${names(scene)}`);
      assert.deepEqual([copy.x, copy.y, copy.config], [300 + 16, 200 + 16, { width: 100, height: 20 }]);
      assert.equal(placedSeed(copy), placedSeed(world.record('Block1')), 'its look: the original’s seed');
      assert.equal(editMode.selection.name, 'Block2');
      editMode.undo();
      assert.equal(names(scene).length, before);
      editMode.redo();
      assert.ok(world.record('Block2'));
    });
  } finally {
    world.done();
  }
});

test('several, with an entity param and a joint between them: the copies name each other', () => {
  const world = makeWorld();
  try {
    withStorage(memoryStorage(), () => {
      const { editMode, scene } = world;
      scene._fileJoints = new Map();
      scene.sceneFile.joints = [{ type: 'weld', a: 'Guard1', b: 'Door1' }, { type: 'weld', a: 'Block1', b: 'Ball1' }];
      editMode.multi.selectNames(['Guard1', 'Door1']);
      editMode.copySelected();
      editMode.paste();
      const guard = world.record('Guard2');
      const door = world.record('Door3'); // Door1 and Door2 are taken
      assert.ok(guard && door, names(scene).join());
      assert.equal(guard.config.door, 'Door3', 'the copy names the copied door');
      assert.deepEqual(guard.config.route, [900, 400, 1000, 400]);
      assert.deepEqual(scene.sceneFile.joints.at(-1), { type: 'weld', a: 'Guard2', b: 'Door3' });
      assert.equal(scene.sceneFile.joints.length, 3, 'only the joint between copied entities');
      assert.deepEqual(editMode.multi.selectedNames().sort(), ['Door3', 'Guard2']);
      editMode.undo();
      assert.equal(scene.sceneFile.joints.length, 2);
      assert.equal(world.record('Guard2'), null);
    });
  } finally {
    world.done();
  }
});

test('Ctrl+X copies and deletes; a paste in a level where the name is free keeps it; a class the scene lacks is left out', () => {
  const world = makeWorld();
  try {
    withStorage(memoryStorage(), () => {
      const { editMode, scene } = world;
      world.select('Ball1');
      assert.equal(editMode.onKey(ctrl('x')), true);
      assert.equal(world.record('Ball1'), null);
      editMode.onKey(ctrl('v'));
      assert.ok(world.record('Ball1'), 'the smallest free number: its own name again');
      assert.equal(editMode.status, 'Pasted Ball1');
      assert.equal('seed' in world.record('Ball1'), false, 'its own name gives its seed');

      writeClipboard({ kind: CLIPBOARD_KIND, version: 1, entities: [{ name: 'Ufo1', class: 'Ufo', x: 0, y: 0 }], joints: [] });
      const count = names(scene).length;
      editMode.paste();
      assert.equal(names(scene).length, count);
      assert.match(editMode.status, /not in this scene/);
    });
  } finally {
    world.done();
  }
});

test('pastePlan at the pointer: the copies’ box centered there, snapped', () => {
  const world = makeWorld();
  try {
    const payload = copyEntities(world.scene, ['Block1', 'Ball1']); // centers 300,200 and 500,100: box center 400,150
    const plan = pastePlan(world.scene, payload, 1000, 1000, 16);
    const dx = Math.round((1000 - 400) / 16) * 16;
    const dy = Math.round((1000 - 150) / 16) * 16;
    assert.deepEqual(plan.records.map((r) => [r.x, r.y]), [[300 + dx, 200 + dy], [500 + dx, 100 + dy]]);
  } finally {
    world.done();
  }
});

test('the clipboard: localStorage first (another tab), this page’s copy when storage throws, nothing from other JSON', () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    writeClipboard({ kind: CLIPBOARD_KIND, version: 1, entities: [{ name: 'A1', class: 'A', x: 1, y: 2 }], joints: [] });
    storage.map.set('weed.editor.clipboard', JSON.stringify({ kind: CLIPBOARD_KIND, version: 1, entities: [{ name: 'B1' }], joints: [] }));
    assert.equal(readClipboard().entities[0].name, 'B1', 'what another tab copied last');
    storage.map.set('weed.editor.clipboard', '{"not":"ours"}');
    assert.equal(readClipboard(), null);
  });
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  withStorage(throwing, () => {
    writeClipboard({ kind: CLIPBOARD_KIND, version: 1, entities: [{ name: 'C1', class: 'C', x: 0, y: 0 }], joints: [] });
    assert.equal(readClipboard().entities[0].name, 'C1', 'this page’s copy');
  });
});

test('a duplicate looks like its original too', () => {
  const world = makeWorld();
  try {
    world.select('Pebble1');
    world.editMode.duplicateSelected();
    assert.equal(placedSeed(world.record('Pebble2')), placedSeed(world.record('Pebble1')));
  } finally {
    world.done();
  }
});
