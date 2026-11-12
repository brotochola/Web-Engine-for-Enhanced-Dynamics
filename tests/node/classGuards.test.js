// DX-GUARDS C3, C4, C5: entity classes that do not do what they say, named once when the scene registers them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { isEmptyMethod } from '../../src/util/classGuards.js';

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    fn();
  } finally {
    console.warn = saved;
  }
  return lines;
}

const WORLD = { worldWidth: 2000, worldHeight: 2000 };

test('C3: tickInterval without staggeredUpdates is named; with it, silent', () => {
  class Drone extends GameObject {
    static tickInterval = 4;
    tick() {
      this.x += 1;
    }
  }
  class Hive extends Scene {
    static entities = [[Drone, 8]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Hive({})), [
    "WeedJS: Drone has static tickInterval = 4, but the scene's logic.staggeredUpdates is off, so it ticks every frame. " +
      "Set logic: { staggeredUpdates: true } in the scene's config.",
  ]);
  class StaggeredHive extends Scene {
    static entities = [[Drone, 8]];
    static config = { ...WORLD, logic: { staggeredUpdates: true } };
  }
  assert.deepEqual(warningsOf(() => new StaggeredHive({})), []);
  class Rock extends GameObject {
    static tickInterval = 4; // no tick: never visited, nothing to say
  }
  class Field extends Scene {
    static entities = [[Rock, 8]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Field({})), []);
});

test('C4: an empty tick is named, with the class that wrote it; a tick that works or none is silent', () => {
  class Idle extends GameObject {
    tick() {}
  }
  class Unit extends GameObject {
    tick(dtRatio) {
      // nothing yet
    }
  }
  class Archer extends Unit {}
  class Busy extends GameObject {
    tick() {
      this.x += 1;
    }
  }
  class Plain extends GameObject {}
  class Camp extends Scene {
    static entities = [[Idle, 4], [Archer, 4], [Busy, 4], [Plain, 4]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Camp({})), [
    "WeedJS: Idle's tick() is empty, yet the logic workers call it on every Idle each frame. Delete it, or set static " +
      "tickInterval = 0 if it is there to stop a parent's tick.",
    "WeedJS: Archer's tick() (from Unit) is empty, yet the logic workers call it on every Archer each frame. Delete it, " +
      "or set static tickInterval = 0 if it is there to stop a parent's tick.",
  ]);
  class Muted extends Busy {
    static tickInterval = 0;
    tick() {}
  }
  class Quiet extends Scene {
    static entities = [[Muted, 4]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Quiet({})), [], 'tickInterval 0: the workers skip the type');
});

test('isEmptyMethod reads the body, not a brace in a parameter', () => {
  const o = {
    a() {},
    b(x = {}) {},
    c(x = {}) { return x; },
    d() { /* soon */ },
    e() { return 1; },
  };
  assert.equal(isEmptyMethod(o.a), true);
  assert.equal(isEmptyMethod(o.b), true);
  assert.equal(isEmptyMethod(o.c), false);
  assert.equal(isEmptyMethod(o.d), true);
  assert.equal(isEmptyMethod(o.e), false);
});

test('C5: a class listed twice, two classes with one name, a parent after its child: each says what happened', () => {
  class Tank extends GameObject {}
  class Twice extends Scene {
    static entities = [[Tank, 4], [Tank, 8]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Twice({})), [
    'WeedJS: Tank is listed twice in static entities: the entry [Tank, 8] is ignored and its pool stays 4. List it once.',
  ]);

  const makeTwin = () => class Twin extends GameObject {};
  const TwinA = makeTwin();
  const TwinB = makeTwin();
  class Twins extends Scene {
    static entities = [[TwinA, 4], [TwinB, 4]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Twins({})), [
    'WeedJS: two entity classes are named Twin: the second is not registered, so it has no pool and cannot spawn ' +
      '(the workers find entity classes by name). Rename one.',
  ]);

  class Enemy extends GameObject {}
  class Grunt extends Enemy {}
  class Backwards extends Scene {
    static entities = [[Grunt, 4], [Enemy, 6]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Backwards({})), [
    'WeedJS: Enemy is listed in static entities after its subclasses: Grunt, which extends it, registered it first ' +
      'with no pool, so [Enemy, 6] is ignored and Enemy.spawn() finds no slot. List Enemy before the classes that extend it.',
  ]);
  class Forwards extends Scene {
    static entities = [[Enemy, 6], [Grunt, 4]];
    static config = { ...WORLD };
  }
  assert.deepEqual(warningsOf(() => new Forwards({})), []);
  assert.equal(Enemy.poolSize, 6, 'listed first, the parent has its pool');
});
