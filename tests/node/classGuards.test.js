// DX-GUARDS C3, C4: entity classes that do not do what they say, named once when the scene registers them.
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
