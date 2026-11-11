// DX-GUARDS C3: entity classes that do not do what they say, named once when the scene registers them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';

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
