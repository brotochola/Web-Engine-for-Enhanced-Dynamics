import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { patchClass } from '../../src/core/debug/hotSwap.js';
import { isEngineAccessor } from '../../src/core/engineAccessors.js';

// E-289: each entity class gets its own compiled neighborCount and getNeighbor (GameObject's are shared by every class,
// so their field loads went megamorphic). The copies must read what GameObject's read, mark readers as they do, leave
// a class's own versions alone, and survive a hot swap.

const N = 12;
const MAX_NEIGHBORS = 4;
const baseCount = Object.getOwnPropertyDescriptor(GameObject.prototype, 'neighborCount').get;
const baseGet = GameObject.prototype.getNeighbor;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  const stride = 1 + MAX_NEIGHBORS;
  const neighborBuffer = new SharedArrayBuffer(N * stride * 2);
  Grid.initialize({ neighborBuffer }, { cellSize: 64, gridWidth: 1, gridHeight: 1, maxNeighbors: MAX_NEIGHBORS, entityIdBytes: 2 });
  const readers = new SharedArrayBuffer(GameObject.ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT);
  GameObject.initializeArrays(N, neighborBuffer, null, null, null, null, 0, readers);
  const rows = Grid.neighborData;
  for (let e = 0; e < N; e++) {
    const n = e % (MAX_NEIGHBORS + 1);
    rows[e * stride] = n;
    for (let k = 0; k < n; k++) rows[e * stride + 1 + k] = (e * 5 + k * 3) % N;
  }
  return new Uint8Array(readers);
}

function make(Classes) {
  for (const C of Classes) GameObject._assignComponentClassMap(C);
  const ents = [];
  for (let i = 0; i < N; i++) ents.push(new Classes[i % Classes.length](i, {}, null));
  return ents;
}

test('E-289: a class gets its own neighbour reads, which read what GameObject\'s read', () => {
  setup();
  class Walker extends GameObject {}
  class Runner extends Walker {}
  class Ant extends GameObject {}
  const ents = make([Walker, Runner, Ant]);
  for (const C of [Walker, Runner, Ant]) {
    const own = Object.getOwnPropertyDescriptor(C.prototype, 'neighborCount');
    assert.ok(own && typeof own.get === 'function' && own.get !== baseCount, `${C.name}: its own neighborCount`);
    assert.ok(Object.prototype.hasOwnProperty.call(C.prototype, 'getNeighbor') && C.prototype.getNeighbor !== baseGet);
    assert.ok(isEngineAccessor(own), `${C.name}: neighborCount marked as the engine's`);
    assert.ok(isEngineAccessor(Object.getOwnPropertyDescriptor(C.prototype, 'getNeighbor')));
  }
  assert.notEqual(Object.getOwnPropertyDescriptor(Walker.prototype, 'neighborCount').get, Object.getOwnPropertyDescriptor(Ant.prototype, 'neighborCount').get);
  for (const e of ents) {
    const n = e.neighborCount;
    assert.equal(n, baseCount.call(e), `entity ${e.index}: count`);
    for (let k = 0; k < n; k++) assert.equal(e.getNeighbor(k), baseGet.call(e, k), `entity ${e.index}: neighbour ${k}`);
  }
  // GameObject keeps its own.
  assert.equal(Object.getOwnPropertyDescriptor(GameObject.prototype, 'neighborCount').get, baseCount);
  Grid.reset();
});

test('E-289: the copies mark the reader type once, and a page instance on every read', () => {
  const readers = setup();
  class Bat extends GameObject {}
  GameObject._assignComponentClassMap(Bat);
  const e = new Bat(3, {}, null);
  Transform.entityType[3] = 7;
  assert.equal(readers[7], 0);
  assert.equal(e.neighborCount, 3);
  assert.equal(readers[7], 1);
  readers[7] = 0;
  assert.equal(e.neighborCount, 3);
  assert.equal(readers[7], 0, 'a worker instance marks once');
  const page = new Bat(4, {}, null, { page: true });
  Transform.entityType[4] = 9;
  assert.equal(page.neighborCount, 4);
  assert.equal(readers[9], 1);
  readers[9] = 0;
  assert.equal(page.neighborCount, 4);
  assert.equal(readers[9], 1, 'a page instance marks on every read');
  Grid.reset();
});

test('E-289: a class that writes its own neighbour reads keeps them, and so do its subclasses', () => {
  setup();
  class Custom extends GameObject {
    get neighborCount() {
      return 99;
    }
    getNeighbor() {
      return -1;
    }
  }
  class Child extends Custom {}
  class Half extends GameObject {
    getNeighbor(k) {
      return 1000 + k;
    }
  }
  const [c, ch, h] = make([Custom, Child, Half]);
  assert.equal(c.neighborCount, 99);
  assert.equal(c.getNeighbor(0), -1);
  assert.equal(ch.neighborCount, 99);
  assert.equal(ch.getNeighbor(0), -1);
  assert.ok(!Object.prototype.hasOwnProperty.call(Child.prototype, 'neighborCount'));
  assert.ok(!Object.prototype.hasOwnProperty.call(Child.prototype, 'getNeighbor'));
  assert.equal(h.getNeighbor(2), 1002);
  assert.equal(h.neighborCount, baseCount.call(h), 'the read it did not write is the engine copy');
  assert.ok(isEngineAccessor(Object.getOwnPropertyDescriptor(Half.prototype, 'neighborCount')));
  Grid.reset();
});

test('E-289: a hot swap keeps the running class\'s neighbour reads', () => {
  setup();
  class Live extends GameObject {
    tick() {
      return 1;
    }
  }
  const [e] = make([Live]);
  const count = Object.getOwnPropertyDescriptor(Live.prototype, 'neighborCount').get;
  const get = Live.prototype.getNeighbor;
  class Fresh extends GameObject {
    tick() {
      return 2;
    }
  }
  patchClass(Live, Fresh);
  assert.equal(e.tick(), 2);
  assert.equal(Object.getOwnPropertyDescriptor(Live.prototype, 'neighborCount').get, count);
  assert.equal(Live.prototype.getNeighbor, get);
  assert.equal(e.neighborCount, baseCount.call(e));
  Grid.reset();
});
