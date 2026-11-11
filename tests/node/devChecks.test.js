// DX-GUARDS: the debug build's run-time checks (src/core/debug/devChecks.js). On by default, off with
// config.debug.checks: false; the production bundle takes a stub with the same exports that does nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as real from '../../src/core/debug/devChecks.js';
import * as stub from '../../src/core/debug/stubs/devChecks.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';

class Probe extends GameObject {}
const sceneWith = (debug) => class Checked extends Scene {
  static entities = [[Probe, 2]];
  static config = { worldWidth: 2000, worldHeight: 2000, ...(debug ? { debug } : {}) };
};

test('a scene turns the checks on by default, and debug.checks: false turns them off', () => {
  real.setDevChecks(false);
  new (sceneWith(null))({});
  assert.equal(real.devChecksOn(), true);
  new (sceneWith({ checks: false }))({});
  assert.equal(real.devChecksOn(), false);
  new (sceneWith({ checks: true }))({});
  assert.equal(real.devChecksOn(), true);
});

test('the stub has every export of the real module, and does nothing', () => {
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(real).sort());
  for (const [name, fn] of Object.entries(stub)) {
    assert.equal(typeof fn, 'function', name);
  }
  stub.setDevChecks(true);
  assert.equal(stub.devChecksOn(), false);
});

test('the production bundle takes the stub', () => {
  const config = readFileSync(new URL('../../webpack.bundle.config.js', import.meta.url), 'utf8');
  assert.match(config, /src\/core\/debug\/devChecks\.js'\)\]:\s*\r?\n\s*path\.resolve\(__dirname, 'src\/core\/debug\/stubs\/devChecks\.js'\)/);
});

test('every worker turns them on or off from the scene config', () => {
  const worker = readFileSync(new URL('../../src/workers/abstractWorker.js', import.meta.url), 'utf8');
  assert.match(worker, /this\.config = data\.config \|\| \{\};\n\s*setDevChecks\(this\.config\.debug\?\.checks !== false\);/);
});

// ---------------------------------------------------------------------------------------------------------------------
// E1: a class field named like an accessor.
// ---------------------------------------------------------------------------------------------------------------------

import { Component } from '../../src/core/component.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    real.setDevChecks(true);
    fn();
  } finally {
    console.warn = saved;
  }
  return lines;
}

class Health extends Component {
  static ARRAY_SCHEMA = { hp: Float32Array };
}

/** A page instance of each class, as Scene._createPageInstances makes them, once a scene has registered the classes. */
function pageInstances(...classes) {
  const Registering = class Registering extends Scene {
    static entities = classes.map((C) => [C, 2]);
    static config = { worldWidth: 2000, worldHeight: 2000 };
  };
  new Registering({});
  return classes.map((C) => new C(C.startIndex, undefined, null, { page: true }));
}

test('E1: a field that hides a component\'s or the engine\'s accessor is named, once per class', () => {
  class Soldier extends GameObject {
    static components = [Health];
    health = 3;
    x = 10;
    ammo = 5;
  }
  const [soldier] = pageInstances(Soldier);
  const lines = warningsOf(() => {
    real.checkFirstInstance(soldier);
    real.checkFirstInstance(new Soldier(Soldier.startIndex + 1, undefined, null, { page: true }));
  });
  assert.deepEqual(lines, [
    'WeedJS: Soldier has a field named health, which hides its Health component: this.health is the field, never ' +
      'the component. Rename the field.',
    "WeedJS: Soldier has a field named x, which hides GameObject's x: on a Soldier, this.x is the field, not the " +
      "engine's x. If the field is meant, a name of its own keeps both: rename it.",
  ]);
});

test('E1: fields with names of their own, and the engine\'s own fields, are silent', () => {
  class Medic extends GameObject {
    static components = [Health];
    heals = 2;
    target = null;
  }
  class Plain extends GameObject {}
  const [medic, plain] = pageInstances(Medic, Plain);
  assert.deepEqual(warningsOf(() => real.checkFirstInstance(medic)), []);
  assert.deepEqual(warningsOf(() => real.checkFirstInstance(plain)), []);
});

test('E1: off, nothing is said', () => {
  class Hidden extends GameObject {
    x = 1;
  }
  const [hidden] = pageInstances(Hidden);
  const lines = warningsOf(() => {
    real.setDevChecks(false);
    real.checkFirstInstance(hidden);
  });
  assert.deepEqual(lines, []);
});
