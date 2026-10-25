import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';

// A `wasm` key that is not a switch (a kernel whose JavaScript path left the engine) is named once and ignored.

function applyDefaults(wasm) {
  const scene = { config: { wasm } };
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    Scene.prototype._applyConfigDefaults.call(scene);
  } finally {
    console.warn = warn;
  }
  return { config: scene.config, warnings };
}

test('a wasm key that is not a switch is warned about once, and the switches still apply', () => {
  const name = 'notASwitchForThisTest';
  assert.ok(!Object.hasOwn(WASM_DEFAULTS, name));
  const first = applyDefaults({ [name]: false, gpuPack: false });
  assert.equal(first.warnings.filter((w) => w.includes(`wasm.${name}`)).length, 1, 'named once');
  assert.equal(first.config.wasm.gpuPack, false, 'a real switch still applies');
  const second = applyDefaults({ [name]: false });
  assert.equal(second.warnings.filter((w) => w.includes(`wasm.${name}`)).length, 0, 'not again');
});
