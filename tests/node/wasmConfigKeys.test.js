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
  // A switch the engine still has (the first one left), set against its default.
  const real = Object.keys(WASM_DEFAULTS)[0];
  const first = applyDefaults({ [name]: false, ...(real ? { [real]: !WASM_DEFAULTS[real] } : {}) });
  assert.equal(first.warnings.filter((w) => w.includes(`wasm.${name}`)).length, 1, 'named once');
  if (real) assert.equal(first.config.wasm[real], !WASM_DEFAULTS[real], 'a real switch still applies');
  const gone = applyDefaults({ gpuPack: false });
  assert.equal(gone.warnings.filter((w) => w.includes('wasm.gpuPack')).length, 1, 'a removed switch is named too');
  const second = applyDefaults({ [name]: false });
  assert.equal(second.warnings.filter((w) => w.includes(`wasm.${name}`)).length, 0, 'not again');
});
