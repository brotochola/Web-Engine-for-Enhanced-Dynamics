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

// ---- the filter (ED-62) ----

/**
 * A city as littleCity has it, 9,808 rows: 500 runtime cars, 8,000 runtime people (of a pool of 10,000), 65 placed
 * houses, 1,243 placed trees.
 */
function makeCity() {
  const n = 12000;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(n) }, []);
  const cls = (name, startIndex, poolSize) => ({ class: { name, startIndex, poolSize, endIndex: startIndex + poolSize } });
  const entities = [];
  const named = new Map();
  const place = (className, count, start) => {
    for (let k = 1; k <= count; k++) {
      const name = `${className}${k}`;
      entities.push({ name, class: className });
      named.set(name, (start + k - 1) * 65536);
      Transform.active[start + k - 1] = 1;
    }
  };
  for (let i = 0; i < 8500; i++) Transform.active[i] = 1; // the cars and 8,000 people
  place('CityHouse', 65, 10500);
  place('CityTree', 1243, 10580);
  return {
    registeredClasses: [cls('TrafficCar', 0, 500), cls('CityPerson', 500, 10000), cls('CityHouse', 10500, 80), cls('CityTree', 10580, 1300)],
    sceneFile: { entities },
    _namedEntities: named,
  };
}

const groupOf = (model, name) => model.groups.find((g) => g.name === name);

test('the filter keeps the rows whose class or name holds the text, case aside: under their classes, unfolded', () => {
  const scene = makeCity();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  assert.equal(model.rowCount, 4, 'four closed classes');

  assert.equal(model.setFilter('tree'), true);
  assert.equal(model.matchCount, 1243, 'the class matches: all of its rows');
  assert.equal(model.rowCount, 1244, 'CityTree, unfolded, and its 1,243 trees');
  assert.deepEqual(rows(model).slice(0, 3), ['group CityTree', 'placed CityTree CityTree1', 'placed CityTree CityTree2']);
  assert.equal(rows(model)[1243], 'placed CityTree CityTree1243');
  assert.equal(model.locate(1244), null);
  assert.equal(model.setFilter('  TREE '), false, 'the same filter, case and spaces aside');

  model.setFilter('Tree12');
  // CityTree12, CityTree120..129, CityTree1200..1243.
  assert.equal(model.matchCount, 1 + 10 + 44);
  assert.deepEqual(rows(model).slice(0, 4), ['group CityTree', 'placed CityTree CityTree12', 'placed CityTree CityTree120', 'placed CityTree CityTree121']);
  assert.equal(model.matchesOf(groupOf(model, 'CityTree')), 55, 'its class’s count');

  model.setFilter('person');
  assert.equal(model.matchCount, 8000, 'runtime entities show under a class that matches');
  assert.deepEqual(rows(model).slice(0, 3), ['group CityPerson', 'runtime CityPerson 500', 'runtime CityPerson 501']);

  model.setFilter('city');
  assert.equal(model.matchCount, 8000 + 65 + 1243);
  assert.deepEqual(
    rows(model).filter((r) => r.startsWith('group')),
    ['group CityPerson', 'group CityHouse', 'group CityTree'],
    'a class nothing of which matches is not listed',
  );

  model.setFilter('house1');
  assert.deepEqual(rows(model), [
    'group CityHouse',
    'placed CityHouse CityHouse1',
    ...Array.from({ length: 10 }, (_, k) => `placed CityHouse CityHouse1${k}`),
  ]);

  model.setFilter('zzz');
  assert.equal(model.matchCount, 0);
  assert.equal(model.rowCount, 0);
  assert.equal(model.locate(0), null);

  model.setFilter('');
  assert.equal(model.rowCount, 4, 'cleared: every class, closed as they were');
});

test('a keystroke filters into each class’s index list, kept from one query to the next; 10,000 rows in about a millisecond', () => {
  const scene = makeCity();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  model.setFilter('tree1');
  model.setFilter('house');
  const trees = groupOf(model, 'CityTree');
  const lists = [trees.matched, trees.authoredLower];
  const queries = ['c', 'ci', 'cit', 'city', 'cityt', 'cityh', 'cityho', 'tree9', 'tree99', 'house6', '1', '12', ''];
  for (const query of queries) model.setFilter(query);
  assert.equal(trees.matched, lists[0], 'the same index list');
  assert.equal(trees.authoredLower, lists[1], 'the names lowercased once per document');
  // Timed, with a loose bound (Node, and a test run that is busy).
  const start = performance.now();
  const rounds = 40;
  for (let k = 0; k < rounds; k++) for (const query of queries) model.setFilter(query);
  const each = (performance.now() - start) / (rounds * queries.length);
  assert.ok(each < 5, `${each.toFixed(3)} ms a keystroke`);
});

test('under the filter a click folds a class until the filter changes; cleared, the groups are open or closed as before', () => {
  const scene = makeCity();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  groupOf(model, 'CityHouse').open = true;
  model.setFilter('city');
  const trees = groupOf(model, 'CityTree');
  assert.equal(model.isOpen(trees), true, 'unfolded by the filter');
  model.toggle(trees);
  assert.equal(model.isOpen(trees), false);
  assert.equal(model.rowCount, 3 + 8000 + 65, 'folded: its row alone');
  assert.equal(trees.open, false, 'its own state untouched');
  model.setFilter('cit');
  assert.equal(model.isOpen(trees), true, 'another filter unfolds it again');
  model.setFilter('');
  assert.deepEqual(model.groups.map((g) => g.open), [false, false, true, false]);
  assert.equal(model.rowCount, 4 + 65);
});

test('under the filter, an entity’s row is its place among the matches; one the filter leaves out has none', () => {
  const scene = makeCity();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  model.setFilter('tree12');
  const tree120 = 10580 + 119;
  assert.equal(model.rowOf(tree120, 'CityTree120'), 2, 'CityTree, CityTree12, CityTree120');
  assert.equal(model.rowOf(10580, 'CityTree1'), -1, 'left out');
  assert.equal(model.rowOf(600, null), -1, 'a runtime person: its class does not match');
  model.toggle(groupOf(model, 'CityTree'));
  assert.equal(model.rowOf(tree120, 'CityTree120'), -1, 'folded');
  assert.equal(model.reveal(tree120, 'CityTree120'), 2, 'reveal unfolds it');
  model.setFilter('person');
  assert.equal(model.rowOf(600, null), 1 + 100, 'runtime: by its index');
});

test('the filter holds over a change of the document, and a class that matches follows its live entities', () => {
  const scene = makeCity();
  const model = new TreeModel();
  model.build(scene);
  model.refresh(scene);
  model.setFilter('tree12');
  scene.sceneFile.entities.push({ name: 'CityTree1244', class: 'CityTree' });
  model.build(scene);
  model.refresh(scene);
  assert.equal(model.matchCount, 56, 'the new record matches');
  assert.equal(rows(model).at(-1), 'placed CityTree CityTree1244');
  model.setFilter('person');
  for (let i = 500; i < 600; i++) Transform.active[i] = 0;
  assert.equal(model.refresh(scene), true);
  assert.equal(model.matchCount, 7900, 'a hundred people despawned');
});
