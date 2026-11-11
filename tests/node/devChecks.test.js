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

test('the production bundle takes the stub, on the page and in the workers', () => {
  for (const file of ['webpack.bundle.config.js', 'webpack.config.js']) {
    const config = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(
      config,
      /src\/core\/debug\/devChecks\.js'\)\]:\s*\r?\n\s*path\.resolve\(__dirname, 'src\/core\/debug\/stubs\/devChecks\.js'\)/,
      file,
    );
  }
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

// ---------------------------------------------------------------------------------------------------------------------
// E2: a field first written after onSpawned.
// ---------------------------------------------------------------------------------------------------------------------

import { Transform } from '../../src/components/transform.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

/** A one-slot pool for `C` at index 0, its instance made by the class itself, as a logic worker makes it. */
function onePool(C) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(1)), 1);
  Transform.x = new Float32Array(1);
  Transform.y = new Float32Array(1);
  Transform.rotation = new Float32Array(1);
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(1);
  resetFreeList(top, links, 1, 1);
  C.startIndex = 0;
  C.endIndex = 1;
  C.poolSize = 1;
  C.entityType = 0;
  C.freeList = links;
  C.freeListTop = top;
  C._componentClassMap = {};
  const instance = Object.create(C.prototype);
  instance.index = 0;
  instance._hasComponents = {};
  instance._spawnAborted = false;
  C.instances = [instance];
  C._activeList = new Int32Array([1, 0]);
  Transform.active[0] = 0;
  return instance;
}

test('E2: a field first written after onSpawned is named by the audit, once; one written in onSpawned is not', () => {
  class Runner extends GameObject {
    onSpawned() {
      this.lane = 2;
    }
  }
  const runner = onePool(Runner);
  const lines = warningsOf(() => {
    Runner.spawn({});
    runner.target = 7; // what a tick would do
    real.auditFields((C) => C.getFirstActiveInstance(), 1e9);
    real.auditFields((C) => C.getFirstActiveInstance(), 2e9);
  });
  assert.deepEqual(lines, [
    "WeedJS: Runner's field target is first written after onSpawned: the object changes shape, every method that saw " +
      'the old one deoptimizes, and the field lives only in this worker. Declare it in the constructor (this.target = …).',
  ]);
});

test('E2: the audit runs once a second at most, and not when the checks are off', () => {
  class Jumper extends GameObject {}
  const jumper = onePool(Jumper);
  const lines = warningsOf(() => {
    Jumper.spawn({});
    real.auditFields((C) => C.getFirstActiveInstance(), 3e9);
    jumper.height = 1;
    real.auditFields((C) => C.getFirstActiveInstance(), 3e9 + 500);
  });
  assert.deepEqual(lines, [], 'half a second later: not yet');
  const off = warningsOf(() => {
    real.setDevChecks(false);
    real.auditFields((C) => C.getFirstActiveInstance(), 5e9);
  });
  assert.deepEqual(off, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// E3: a body flag written after the body exists.
// ---------------------------------------------------------------------------------------------------------------------

import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { BODY_DIRTY, bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';

/** Two physics entities of class `C`, the body-sync buffers bound; slot 0's body waits to be made. */
function bodies(C) {
  const N = 2;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  const flags = bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(N * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(N * 4),
  }).dirtyFlags;
  GameObject.classByType[5] = C;
  for (let i = 0; i < N; i++) {
    Transform.entityType[i] = 5;
    Transform.active[i] = 1;
    RigidBody.active[i] = 1;
    Collider.active[i] = 1;
  }
  flags[0] = BODY_DIRTY.LIFECYCLE;
  return flags;
}

test('E3: collider.isTrigger and rigidBody.fixedRotation written after the body is made are named', () => {
  class Crate extends GameObject {}
  const flags = bodies(Crate);
  const lines = warningsOf(() => {
    new Collider(0).isTrigger = 1; // the body is still to be made: it reads this
    new RigidBody(0).fixedRotation = 1;
    flags[0] = 0; // the physics step made it
    new Collider(0).isTrigger = 0;
    new RigidBody(0).fixedRotation = 0;
    new Collider(1).isTrigger = 1; // once per class
  });
  assert.deepEqual(lines, [
    'WeedJS: Crate writes collider.isTrigger after its Box2D body exists, so the body does not change. Set it before ' +
      'the body exists: in onSpawned or the spawn config.',
    'WeedJS: Crate writes rigidBody.fixedRotation after its Box2D body exists, so the body does not change. Use ' +
      'this.setFixedRotation(v) (or this.fixedRotation = v), which updates the body.',
  ]);
  assert.equal(Collider.isTrigger[0], 0, 'the column is still written');
  assert.equal(RigidBody.fixedRotation[0], 0);
});

test('E3: without physics, or with the body still to be made, nothing is said', () => {
  class Barrel extends GameObject {}
  bodies(Barrel);
  const lines = warningsOf(() => {
    new Collider(0).isTrigger = 1;
    bindBodySyncBuffers(null); // physics off
    new Collider(1).isTrigger = 1;
  });
  assert.deepEqual(lines, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// E4: a mass set by hand, replaced by the collider's.
// ---------------------------------------------------------------------------------------------------------------------

import { ShapeType } from '../../src/util/configDefaults.js';

/** Entity 0 and 1, circles of radius 10 (mass 100π), dynamic. */
function circles(C) {
  bodies(C);
  bindBodySyncBuffers(null);
  for (const i of [0, 1]) {
    Collider.shapeType[i] = ShapeType.Circle;
    Collider.radius[i] = 10;
    RigidBody.static[i] = 0;
    RigidBody.syncMassFromCollider(i);
  }
  real.slotReleased(0);
  real.slotReleased(1);
}

test('E4: a mass set in onSpawned, replaced by the spawn\'s sync from the collider, is named', () => {
  class Boulder extends GameObject {}
  circles(Boulder);
  const lines = warningsOf(() => {
    new RigidBody(0).mass = 50; // in onSpawned
    RigidBody.syncMassFromCollider(0, true); // GameObject.spawn, after onSpawned
  });
  assert.deepEqual(lines, [
    "WeedJS: Boulder's rigidBody.mass, set by hand to 50, was replaced by its collider's 314.159: spawn sets the mass " +
      'from the collider after onSpawned (PHYSICS.md, "Mass"). Set it after the spawn returns.',
  ]);
});

test('E4: a mass set by hand, replaced when the collider\'s shape changes, is named', () => {
  class Ball extends GameObject {}
  circles(Ball);
  const lines = warningsOf(() => {
    new RigidBody(0).mass = 2;
    new Collider(0).radius = 20;
  });
  assert.deepEqual(lines, [
    "WeedJS: Ball's rigidBody.mass, set by hand to 2, was replaced by its collider's 1256.637: a change of the " +
      "collider's shape sets the mass from it again. Set the mass after the shape.",
  ]);
});

test('E4: a mass set after the shape, the same mass, a static body, or a released slot are silent', () => {
  class Rock extends GameObject {}
  circles(Rock);
  const lines = warningsOf(() => {
    new Collider(0).radius = 20;
    new RigidBody(0).mass = 2; // after the shape: kept
    new RigidBody(1).mass = Math.fround(Math.PI * 100);
    RigidBody.syncMassFromCollider(1, true); // the same mass back
    RigidBody.static[0] = 1;
    new Collider(0).radius = 30; // a static body's mass does not move it
    new RigidBody(1).mass = 7;
    real.slotReleased(1); // despawned: the next entity in the slot set nothing
    RigidBody.syncMassFromCollider(1, true);
  });
  assert.deepEqual(lines, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// E7: a key name the keyboard map does not have.
// ---------------------------------------------------------------------------------------------------------------------

import { Keyboard } from '../../src/core/keyboard.js';

function keyboard() {
  const map = { a: 0, s: 1, ' ': 2, shift: 3, arrowleft: 4, f1: 5 };
  Keyboard.initialize(new Uint8Array(12), map);
  return map;
}

test('E7: a key name the engine does not read is named once, with the nearest it reads', () => {
  keyboard();
  const lines = warningsOf(() => {
    assert.equal(Keyboard.isDown('spacee'), false);
    assert.equal(Keyboard.isDown('spacee'), false);
    assert.equal(Keyboard.isPressed('arowleft'), false);
    assert.equal(Keyboard.isDown('pageup'), false);
  });
  const reads = 'It reads the letters, digits, punctuation, arrows (arrowleft …), f1 to f12, space, enter, escape, tab, ' +
    'backspace, delete, shift, control, alt and meta: KeyboardEvent.key, in any case.';
  assert.deepEqual(lines, [
    `WeedJS: Keyboard: "spacee" is not a key the engine reads, so it is never down. Did you mean "space"? ${reads}`,
    `WeedJS: Keyboard: "arowleft" is not a key the engine reads, so it is never down. Did you mean "arrowleft"? ${reads}`,
    `WeedJS: Keyboard: "pageup" is not a key the engine reads, so it is never down. ${reads}`,
  ]);
});

test('E7: keys it reads, in any case and by their other names, are silent', () => {
  keyboard();
  const lines = warningsOf(() => {
    for (const k of ['a', 'A', 'space', 'Space', 'spacebar', ' ', 'Shift', 'ArrowLeft', 'F1']) Keyboard.isDown(k);
  });
  assert.deepEqual(lines, []);
});
