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
