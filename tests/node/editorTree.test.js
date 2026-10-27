// The editor page's scene list (VISUAL_EDITOR_PLAN.md ED-15), without the DOM: the scene's classes in order, each
// with the records its file places and the live entities code spawned; rows for the open groups only; a refresh that
// says whether anything changed; and the row of an entity, its group opened.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Messages } from '../../src/core/messages.js';
import { TreeModel, ROW_GROUP, ROW_AUTHORED, ROW_RUNTIME } from '../../src/core/debug/editor/entityTree.js';

const N = 32;

function makeScene() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
  const cls = (name, startIndex, poolSize) => ({ class: { name, startIndex, poolSize, endIndex: startIndex + poolSize } });
  const scene = {
    registeredClasses: [cls('Player', 0, 2), cls('Platform', 2, 8), cls('Flash', 10, 4), cls('Coin', 14, 16)],
    sceneFile: {
      entities: [
        { name: 'Platform1', class: 'Platform' },
        { name: 'Platform2', class: 'Platform' },
        { name: 'Coin1', class: 'Coin' },
      ],
    },
    _namedEntities: new Map([
      ['Platform1', 2 * 65536],
      ['Platform2', 3 * 65536],
      ['Coin1', 14 * 65536],
    ]),
  };
  for (const i of [0, 2, 3, 14, 15, 16, 11]) Transform.active[i] = 1; // 11: a Flash
  return scene;
}

const rows = (model) => {
  const out = [];
  for (let r = 0; r < model.rowCount; r++) {
    const at = model.locate(r);
    const kind = at.kind === ROW_GROUP ? 'group' : at.kind === ROW_AUTHORED ? 'placed' : 'runtime';
    out.push(`${kind} ${at.group.name} ${at.kind === ROW_RUNTIME ? at.group.runtime[at.item] : at.kind === ROW_AUTHORED ? at.group.authored[at.item] : ''}`.trim());
  }
  return out;
};

test('groups follow the scene’s classes, without the engine’s own; closed groups are one row each', () => {
  const scene = makeScene();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  assert.deepEqual(model.groups.map((g) => g.name), ['Player', 'Platform', 'Coin']);
  assert.deepEqual(rows(model), ['group Player', 'group Platform', 'group Coin']);
  assert.equal(model.locate(3), null, 'past the last row');
});

test('an open group lists the file’s records, then the live entities the file does not name', () => {
  const scene = makeScene();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  for (const group of model.groups) group.open = true;
  assert.deepEqual(rows(model), [
    'group Player',
    'runtime Player 0',
    'group Platform',
    'placed Platform Platform1',
    'placed Platform Platform2',
    'group Coin',
    'placed Coin Coin1',
    'runtime Coin 15',
    'runtime Coin 16',
  ]);
});

test('a refresh says when the live entities changed; a slot the file named and code took again is runtime', () => {
  const scene = makeScene();
  const model = new TreeModel();
  model.build(scene);
  assert.equal(model.refresh(scene), true, 'the first count');
  assert.equal(model.refresh(scene), false, 'nothing moved');
  Transform.active[17] = 1;
  assert.equal(model.refresh(scene), true, 'a coin spawned');
  assert.equal(model.groups[2].runtimeCount, 3);
  // Coin1 despawns, and its slot goes to a coin code spawns (its generation moved on).
  Messages.spawnGen[14] = 1;
  assert.equal(model.refresh(scene), true);
  model.groups[2].open = true;
  assert.deepEqual(
    rows(model).filter((r) => r.startsWith('runtime Coin')),
    ['runtime Coin 14', 'runtime Coin 15', 'runtime Coin 16', 'runtime Coin 17'],
  );
});

test('the document is listed again on build; open groups stay open', () => {
  const scene = makeScene();
  const model = new TreeModel();
  model.build(scene);
  model.groups[1].open = true;
  scene.sceneFile.entities.push({ name: 'Platform3', class: 'Platform' });
  model.build(scene);
  model.refresh(scene);
  assert.equal(model.groups[1].open, true);
  assert.deepEqual(model.groups[1].authored, ['Platform1', 'Platform2', 'Platform3']);
});

test('reveal: the row of an entity, by its name when the file places it, its group opened', () => {
  const scene = makeScene();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  assert.equal(model.reveal(3, 'Platform2'), 3, 'Player, Platform, Platform1, Platform2');
  assert.equal(model.groups[1].open, true);
  // Player, Platform, Platform1, Platform2, Coin, Coin1, #15, #16
  assert.equal(model.reveal(16, null), 7, 'a runtime coin, after the file’s coin');
  assert.equal(model.reveal(30, null), -1, 'not live');
  assert.equal(model.reveal(11, null), -1, 'the engine’s own classes are not listed');
});
