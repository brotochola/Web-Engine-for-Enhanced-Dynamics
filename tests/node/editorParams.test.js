// Editing a placed entity's spawn params (VISUAL_EDITOR_PLAN.md D4, D6; ED-7, ED-9): a field per declared param, its
// default beside it and a reset to it; a key/value box for a class that declares none. A change edits the entity's
// record in the scene file's document (a default is left out) and respawns the entity from it, and every entity
// that refers to it by an entity param; the selection follows the respawned entity.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Messages } from '../../src/core/messages.js';
import { Transform } from '../../src/components/transform.js';
import { setParam, setConfig, respawnPlaced, recordOf } from '../../src/core/debug/editor/sceneDocument.js';
import { buildParamFields, defaultText, toHex } from '../../src/core/debug/editor/paramWidgets.js';
import { Selection } from '../../src/core/debug/editor/selection.js';
import { describeSpawnParams, KIND_ENUM, KIND_COLOR, KIND_STRING } from '../../src/core/spawnParams.js';

// ---- a scene with a document and classes that record their spawns ----

function makeScene() {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(64) }, []);
  const calls = [];
  let next = 10;
  const spawner = (name) => ({
    spawn(cfg) {
      calls.push(['spawn', name, { ...cfg }]);
      return { index: next++ };
    },
    despawn(i) {
      calls.push(['despawn', name, i]);
    },
  });
  class Platform {
    static spawnParams = {
      width: { value: 220, min: 8, max: 4000, step: 1 },
      height: { value: 36, min: 8, max: 1000, step: 1 },
      tint: { value: 0x495870, type: 'color' },
    };
  }
  Object.assign(Platform, spawner('Platform'));
  class Lever {
    static spawnParams = { door: { value: null, type: 'entity', class: 'Platform' } };
  }
  Object.assign(Lever, spawner('Lever'));
  class Crate {}
  Object.assign(Crate, spawner('Crate'));
  const scene = {
    sceneFile: {
      format: 1,
      script: 's.js',
      entities: [
        { name: 'Ground', class: 'Platform', x: 600, y: 2050, config: { width: 1200 } },
        { name: 'Lever1', class: 'Lever', x: 100, y: 100, config: { door: 'Ground' } },
        { name: 'Crate1', class: 'Crate', x: 5, y: 6, config: { weight: 2 } },
      ],
    },
    registeredClasses: [{ class: Platform }, { class: Lever }, { class: Crate }],
    _namedEntities: new Map([
      ['Ground', 1 * 65536],
      ['Lever1', 2 * 65536],
      ['Crate1', 3 * 65536],
    ]),
  };
  return { scene, calls };
}

test('a param set to a value is written to the record, and the entity respawns from it', () => {
  const { scene, calls } = makeScene();
  const index = setParam(scene, 'Ground', 'height', 60);
  assert.equal(index, 10);
  assert.deepEqual(recordOf(scene, 'Ground').record.config, { width: 1200, height: 60 });
  assert.deepEqual(calls.slice(0, 2), [
    ['despawn', 'Platform', 1],
    ['spawn', 'Platform', { x: 600, y: 2050, width: 1200, height: 60 }],
  ]);
  assert.equal(scene._namedEntities.get('Ground'), 10 * 65536, 'the name points at the new entity');
  assert.deepEqual(calls.slice(2), [
    ['despawn', 'Lever', 2],
    ['spawn', 'Lever', { x: 100, y: 100, door: 10 }],
  ], 'the lever that names it respawns, with its new index');
});

test('a param set back to its default is left out of the record, and an empty config with it', () => {
  const { scene } = makeScene();
  setParam(scene, 'Ground', 'width', 220);
  assert.equal('config' in recordOf(scene, 'Ground').record, false);
  setParam(scene, 'Lever1', 'door', null);
  assert.equal('config' in recordOf(scene, 'Lever1').record, false, 'an entity param of none');
  assert.equal(setParam(scene, 'Nobody', 'width', 1), -1);
});

test('a class without spawnParams takes its whole config; a name whose entity is gone is only spawned', () => {
  const { scene, calls } = makeScene();
  assert.equal(setConfig(scene, 'Crate1', { weight: 3, color: 'red' }), 10);
  assert.deepEqual(calls, [
    ['despawn', 'Crate', 3],
    ['spawn', 'Crate', { x: 5, y: 6, weight: 3, color: 'red' }],
  ]);
  setConfig(scene, 'Crate1', {});
  assert.equal('config' in recordOf(scene, 'Crate1').record, false);
  calls.length = 0;
  scene._namedEntities.set('Ground', 1 * 65536 + 1); // a generation that is no longer live: nothing to despawn
  respawnPlaced(scene, 'Ground');
  assert.deepEqual(calls[0][0], 'spawn', 'only the spawn');
});

// ---- the fields, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.title = '';
    this.type = '';
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
  /** Depth-first: every element under this one. */
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

function withDocument(fn) {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

const describeOf = (spawnParams) => {
  class C {}
  C.spawnParams = spawnParams;
  return describeSpawnParams(C);
};

function fields(spawnParams, config, names = []) {
  const changes = [];
  const configs = [];
  const container = new El('div');
  const description = spawnParams === null ? null : describeOf(spawnParams);
  buildParamFields(container, description, config, {
    onChange: (key, value) => changes.push([key, value]),
    onConfig: (c) => configs.push(c),
    entityNames: (className) => names.filter((n) => className === undefined || n.startsWith(className)),
  });
  const row = (key) => container.children.find((r) => r.dataset.key === key);
  return { container, row, changes, configs };
}

test('a number: a slider and a field within its range, the default beside it, a reset when set', () =>
  withDocument(() => {
    const { row, changes } = fields({ width: { value: 220, min: 8, max: 4000, step: 1 }, height: { value: 36 } }, { width: 1200 });
    const width = row('width');
    const slider = width.find((el) => el.type === 'range');
    const field = width.find((el) => el.type === 'number');
    assert.deepEqual([slider.min, slider.max, slider.step, slider.value, field.value], ['8', '4000', '1', '1200', '1200']);
    field.value = '400';
    field.onchange();
    field.value = '99999';
    field.onchange();
    field.value = 'abc';
    field.onchange();
    assert.equal(field.value, '1200', 'not a number: the field shows the value again');
    slider.value = '500';
    slider.oninput();
    assert.equal(field.value, '500', 'dragging shows the number');
    assert.deepEqual(changes, [['width', 400], ['width', 4000]], 'nothing while dragging');
    slider.onchange();
    assert.deepEqual(changes.at(-1), ['width', 500], 'once on letting go');
    const reset = width.find((el) => el.tagName === 'BUTTON');
    assert.equal(reset.style.visibility, 'visible');
    reset.onclick();
    assert.deepEqual(changes.at(-1), ['width', 220]);
    assert.match(width.textContent, /default 220/);
    assert.equal(row('height').find((el) => el.tagName === 'BUTTON').style.visibility, 'hidden', 'at its default');
    assert.equal(row('height').find((el) => el.type === 'range'), null, 'no range, no slider');
  }));

test('color, enum, bool, string, entity and points fields', () =>
  withDocument(() => {
    const { row, changes } = fields(
      {
        tint: { value: 0x495870, type: 'color' },
        mode: { value: 0, type: 'enum', options: { Loop: 0, PingPong: 1 }, label: 'Route mode', tip: 'how it walks' },
        locked: { value: false },
        next: { value: '' },
        door: { value: null, type: 'entity', class: 'Door' },
        route: { value: null, type: 'points' },
      },
      { tint: 0xff0000, door: 'Door9', route: [1, 2, 3, 4] },
      ['Door1', 'Door2', 'Lever1'],
    );
    const color = row('tint').find((el) => el.type === 'color');
    assert.equal(color.value, '#ff0000');
    color.value = '#00ff80';
    color.onchange();
    const select = row('mode').find((el) => el.tagName === 'SELECT');
    assert.deepEqual(select.children.map((o) => [o.value, o.textContent]), [['0', 'Loop'], ['1', 'PingPong']]);
    assert.match(row('mode').textContent, /Route mode/);
    select.value = '1';
    select.onchange();
    const box = row('locked').find((el) => el.type === 'checkbox');
    box.checked = true;
    box.onchange();
    const text = row('next').find((el) => el.type === 'text');
    text.value = '1-2.scene.json';
    text.onchange();
    const door = row('door').find((el) => el.tagName === 'SELECT');
    assert.deepEqual(
      door.children.map((o) => o.textContent),
      ['(none)', 'Door1', 'Door2', 'Door9 (missing)'],
      'the file’s Doors, and the name it holds though the file has none',
    );
    door.value = '';
    door.onchange();
    assert.match(row('route').textContent, /2 points/);
    assert.deepEqual(changes, [
      ['tint', 0x00ff80],
      ['mode', 1],
      ['locked', true],
      ['next', '1-2.scene.json'],
      ['door', null],
    ]);
    assert.equal(defaultText(KIND_ENUM, { options: { Loop: 0, PingPong: 1 } }, 1), 'PingPong');
    assert.equal(defaultText(KIND_COLOR, {}, 0x495870), '#495870');
    assert.equal(defaultText(KIND_STRING, {}, ''), '(empty)');
    assert.equal(toHex(0x0000ff), '#0000ff');
  }));

test('a class without spawnParams gets its config as JSON, applied when it parses as an object', () =>
  withDocument(() => {
    const { container, configs } = fields(null, { weight: 2 });
    const area = container.find((el) => el.tagName === 'TEXTAREA');
    assert.deepEqual(JSON.parse(area.value), { weight: 2 });
    area.value = '{ "weight": ';
    area.onchange();
    assert.equal(area.style.borderColor, '#f87171');
    area.value = '[1, 2]';
    area.onchange();
    area.value = '{ "weight": 5 }';
    area.onchange();
    assert.deepEqual(configs, [{ weight: 5 }]);
    assert.equal(area.style.borderColor, '');
  }));

test('the panel’s change edits the document, respawns, and the selection follows the new entity', () => {
  const { scene, calls } = makeScene();
  Transform.entityType = new Uint8Array(64);
  const debugUI = {
    scene,
    tools: { _classNameForType: () => 'Platform' },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
  };
  const selection = new Selection(debugUI);
  selection._show = () => {};
  let edits = 0;
  selection.onEdit = () => edits++;
  selection.select(1);
  assert.equal(selection.name, 'Ground');
  selection._hooks.onChange('height', 80);
  assert.deepEqual([selection.index, selection.name, edits], [10, 'Ground', 1]);
  assert.deepEqual(recordOf(scene, 'Ground').record.config, { width: 1200, height: 80 });
  assert.equal(calls.filter((c) => c[0] === 'spawn').length, 2, 'the platform and the lever that names it');
  assert.deepEqual(selection._hooks.entityNames('Platform'), [], 'its own name is not offered');
});
