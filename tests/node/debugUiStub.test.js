import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugUI } from '../../src/core/debug/debugUi.js';
import { DebugUI as DebugUIStub } from '../../src/core/debug/stubs/debugUi.js';

// The production bundles alias debugUi.js to its stub (webpack.config.js debugStubAliases): the stub has every static
// the real one has, or a prod bundle throws where GameEngine calls it (SST-14's DebugUI.load did).

test('the production DebugUI stub has every static of the real one, and its load gives an overlay that does nothing', async () => {
  const statics = (cls) => Object.getOwnPropertyNames(cls).filter((k) => !['length', 'name', 'prototype'].includes(k)).sort();
  assert.deepEqual(statics(DebugUIStub), statics(DebugUI));
  const overlay = await DebugUIStub.load({ updateInterval: 250 });
  for (const m of ['attach', 'detach', 'destroy', 'toggle', 'show', 'hide', 'registerScenes']) {
    assert.equal(typeof overlay[m], 'function', m);
  }
});
