import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DebugFlags,
  DEBUG_FLAGS,
  DEBUG_SELECTED_ENTITY_OFFSET,
} from '../../src/core/debug/DebugFlags.js';

test('selected entity storage does not alias constraint and origin flags', () => {
  const debugBuffer = new SharedArrayBuffer(32);
  const flags = new DebugFlags(debugBuffer);

  flags.showConstraints(true);
  flags.showEntityOrigins(true);
  flags.setSelectedEntity(1234);

  assert.equal(DEBUG_SELECTED_ENTITY_OFFSET, 20);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS), true);
  assert.equal(flags.getSelectedEntity(), 1234);
});

test('enable() forwards debugDraws and constraints options', () => {
  const debugBuffer = new SharedArrayBuffer(32);
  const flags = new DebugFlags(debugBuffer);

  flags.enable({
    debugDraws: true,
    constraints: true,
  });

  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS), true);
});
