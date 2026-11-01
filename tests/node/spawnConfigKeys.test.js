// E-169: _spawnAt applies a spawn config's x and y by name. They keep their place in the config's order (a setter
// that runs before them sees the slot's old position), and any other key's getter is read once, not twice.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

test('a spawn config sets x and y in its own order, and reads each other key once', { concurrency: false }, () => {
  const seen = [];
  let reads = 0;
  class Probe extends GameObject {
    get mark() {
      reads++;
      return 0;
    }
    set mark(value) {
      seen.push([value, Transform.x[this.index], Transform.y[this.index]]);
    }
  }
  Transform.active = new Uint8Array(2);
  Transform.x = new Float32Array([-1, -1]);
  Transform.y = new Float32Array([-1, -1]);
  Transform.rotation = new Float32Array(2);
  GameObject.nextTick = null;
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(2);
  resetFreeList(top, links, 2, 2);
  Object.assign(Probe, { startIndex: 0, poolSize: 2, entityType: 0, freeList: links, freeListTop: top });
  GameObject._assignComponentClassMap(Probe);
  Probe.instances = [new Probe(0, undefined, null, { page: true }), new Probe(1, undefined, null, { page: true })];

  const a = Probe.spawn({ mark: 1, x: 5, y: 6 });
  const b = Probe.spawn({ x: 7, mark: 2, y: 8 });
  assert.ok(a && b && a !== b, 'two slots');
  assert.deepEqual([Transform.x[a.index], Transform.y[a.index], Transform.x[b.index], Transform.y[b.index]], [5, 6, 7, 8]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 1);
  assert.notEqual(seen[0][1], 5, 'mark came before x');
  assert.deepEqual(seen[1].slice(0, 2), [2, 7], 'x came before mark');
  assert.notEqual(seen[1][2], 8, 'and y after it');
  assert.equal(reads, 2, 'one getter read for each spawn');
});

// N-98: `speed` is a getter without a setter. A config that named it threw "which has only a getter" inside _spawnAt,
// and a logic worker that set the spawn up logged FATAL ERROR and stopped.
test('a spawn key that names a read-only property is skipped, with one warning', { concurrency: false }, () => {
  class Car extends GameObject {
    get horn() {
      return 0;
    }
    set horn(value) {
      throw new RangeError(`no horn ${value}`);
    }
  }
  Transform.active = new Uint8Array(3);
  Transform.x = new Float32Array(3);
  Transform.y = new Float32Array(3);
  Transform.rotation = new Float32Array(3);
  GameObject.nextTick = null;
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(3);
  resetFreeList(top, links, 3, 3);
  Object.assign(Car, { startIndex: 0, poolSize: 3, entityType: 0, freeList: links, freeListTop: top });
  GameObject._assignComponentClassMap(Car);
  Car.instances = [0, 1, 2].map((i) => new Car(i, undefined, null, { page: true }));

  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const a = Car.spawn({ speed: 2, x: 5, y: 6 });
    const b = Car.spawn({ x: 7, speed: 3, y: 8 });
    assert.ok(a && b && a !== b, 'both spawned');
    assert.deepEqual([Transform.x[a.index], Transform.y[a.index], Transform.x[b.index], Transform.y[b.index]], [5, 6, 7, 8]);
    assert.equal(warnings.length, 1, 'one warning for the class and key');
    assert.match(warnings[0], /Car\.spawn\(\) skips the key "speed"/);
    assert.throws(() => Car.spawn({ horn: 1 }), RangeError, 'a setter that throws still throws');
  } finally {
    console.warn = warn;
  }
});
