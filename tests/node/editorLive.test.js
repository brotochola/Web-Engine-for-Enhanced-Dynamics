// The inspector's live values (VISUAL_EDITOR_PLAN.md D8, ED-17): a field writes the live entity through its page
// instance (setPosition for x and y, a component's setter for its column), a refresh shows what changed but never
// over a field being typed in, and "Copy to scene" writes the live position and the params named like a column of
// the entity's components into its record, as one change.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { LiveInspector, copyablePairs, tidyNumber } from '../../src/core/debug/editor/liveInspector.js';
import { recordOf, editPlaced } from '../../src/core/debug/editor/sceneDocument.js';

const N = 8;

class Platform {
  static spawnParams = {
    width: { value: 220 },
    tint: { value: 0x495870, type: 'color' },
    label: { value: '' },
    door: { value: null, type: 'entity' },
    speed: { value: 3 },
  };
}

function initSoA() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
}

test('copyablePairs: each number, color, bool or enum param named like a column of the entity’s components', () => {
  initSoA();
  const pairs = copyablePairs(Platform, [Transform, Collider, SpriteRenderer]);
  assert.deepEqual(
    pairs.map((p) => `${p.key}←${p.Comp.name}`),
    ['width←Collider', 'tint←SpriteRenderer'],
    'a string, an entity and a param no column has (speed) are left out',
  );
});

test('tidyNumber: a float32 column as the decimal it was set from', () => {
  assert.equal(tidyNumber(Math.fround(0.3)), 0.3);
  assert.equal(tidyNumber(Math.fround(1234.56)), 1234.56);
  assert.equal(tidyNumber(640), 640);
  assert.equal(tidyNumber(-2), -2);
});

/** A selection of the placed Platform1 (index 3), with an editor whose changes go through editPlaced. */
function selectionOf(scene) {
  const changes = [];
  const selection = {
    authored: true,
    name: 'Platform1',
    debugUI: { scene },
    editor: {
      editSelected: (label, write) => {
        changes.push(label);
        return editPlaced(scene, 'Platform1', write)?.index ?? -1;
      },
    },
  };
  return { selection, changes };
}

function platformScene() {
  let next = 20;
  class P extends Platform {
    static spawn() {
      return { index: next++ };
    }
    static despawn() {}
  }
  Object.defineProperty(P, 'name', { value: 'Platform' });
  return {
    sceneFile: { entities: [{ name: 'Platform1', class: 'Platform', x: 100, y: 200, config: { width: 400, tint: 0x112233 } }] },
    registeredClasses: [{ class: P }],
    _namedEntities: new Map([['Platform1', 3 * 65536]]),
  };
}

test('Copy to scene: the live position and the named columns into the record, one change; a default is left out', () => {
  initSoA();
  const scene = platformScene();
  const { selection, changes } = selectionOf(scene);
  const live = Object.create(LiveInspector.prototype);
  Object.assign(live, { selection, _index: 3, _pairs: copyablePairs(Platform, [Transform, Collider, SpriteRenderer]) });
  Transform.x[3] = Math.fround(512.3);
  Transform.y[3] = 1800;
  Collider.width[3] = 640;
  SpriteRenderer.tint[3] = 0x495870; // the declared default
  assert.ok(live.copyToScene() >= 0, 'respawned');
  assert.deepEqual(changes, ['copy live Platform1 to the scene']);
  assert.deepEqual(recordOf(scene, 'Platform1').record, { name: 'Platform1', class: 'Platform', x: 512.3, y: 1800, config: { width: 640 } });
  selection.authored = false;
  assert.equal(live.copyToScene(), -1, 'a runtime entity has no record');
});

test('a field writes the live entity: x and y through setPosition, a column through its setter, a color in hex', () => {
  initSoA();
  const calls = [];
  const entity = {
    setPosition: (x, y) => calls.push(['setPosition', x, y]),
    collider: {
      get width() {
        return Collider.width[3];
      },
      set width(v) {
        calls.push(['collider.width', v]);
        Collider.width[3] = v;
      },
    },
  };
  const get = GameObject.get;
  GameObject.get = (i) => (i === 3 ? entity : null);
  try {
    const live = Object.create(LiveInspector.prototype);
    Object.assign(live, { _index: 3 });
    Transform.y[3] = 50;
    assert.equal(live._write(Transform, 'x', ' 75 '), true);
    assert.equal(live._write(Collider, 'width', '128'), true);
    assert.equal(live._write(SpriteRenderer, 'tint', '0xFF8800'), true, 'no setter on this entity: the column');
    assert.equal(SpriteRenderer.tint[3], 0xff8800);
    assert.equal(live._write(Collider, 'width', 'wide'), false);
    assert.equal(live._write(Collider, 'width', ''), false);
    assert.deepEqual(calls, [['setPosition', 75, 50], ['collider.width', 128]]);
  } finally {
    GameObject.get = get;
  }
});

test('a refresh writes a field only when its value changed, and never the one being typed in', () => {
  initSoA();
  const doc = { activeElement: null };
  const input = (name) => ({ value: '', ownerDocument: doc, name });
  const width = { name: 'width', input: input('width'), shown: NaN };
  const height = { name: 'height', input: input('height'), shown: NaN };
  const live = Object.create(LiveInspector.prototype);
  Object.assign(live, { _index: 2, _sections: [{ Comp: Collider, open: true, rows: [width, height] }] });
  Collider.width[2] = 64;
  Collider.height[2] = 16;
  live.update();
  assert.deepEqual([width.input.value, height.input.value], ['64', '16']);
  width.input.value = 'typed';
  live.update();
  assert.equal(width.input.value, 'typed', 'unchanged value: not written again');
  Collider.width[2] = 80;
  doc.activeElement = width.input;
  live.update();
  assert.equal(width.input.value, 'typed', 'the field being typed in keeps what is typed');
  doc.activeElement = null;
  live.update();
  assert.equal(width.input.value, '80');
  live._sections[0].open = false;
  Collider.width[2] = 90;
  live.update();
  assert.equal(width.input.value, '80', 'a closed section is not read');
});
