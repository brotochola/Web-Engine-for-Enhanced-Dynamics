import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DebugFlags,
  DEBUG_FLAGS,
  DEBUG_FLAG_COUNT,
  DEBUG_SELECTED_ENTITY_OFFSET,
} from '../../src/core/debug/debugFlags.js';
import { getInspectorPropertyNames } from '../../src/util/utils.js';
import { RigidBody } from '../../src/components/rigidBody.js';

test('selected entity storage does not alias joint and origin flags', () => {
  const debugBuffer = new SharedArrayBuffer(32);
  const flags = new DebugFlags(debugBuffer);

  flags.showJoints(true);
  flags.showEntityOrigins(true);
  flags.setSelectedEntity(1234);

  assert.equal(DEBUG_SELECTED_ENTITY_OFFSET, 20);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_JOINTS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS), true);
  assert.equal(flags.getSelectedEntity(), 1234);
});

test('constructor and disableAll keep selected entity at -1', () => {
  const debugBuffer = new SharedArrayBuffer(32);
  const flags = new DebugFlags(debugBuffer);

  assert.equal(flags.getSelectedEntity(), -1);

  flags.showJoints(true);
  flags.setSelectedEntity(7);
  flags.disableAll();

  assert.equal(flags.getSelectedEntity(), -1);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_JOINTS), false);
  assert.equal(DEBUG_FLAG_COUNT, 18);
});

test('enable() forwards debugDraws, joints, lights, and activeOnly', () => {
  const debugBuffer = new SharedArrayBuffer(32);
  const flags = new DebugFlags(debugBuffer);

  flags.enable({
    debugDraws: true,
    joints: true,
    lights: true,
    activeOnly: true,
  });

  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_JOINTS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_ACTIVE_ONLY), true);
});

test('getInspectorPropertyNames lists RigidBody HEAP extras when bound', () => {
  const names = getInspectorPropertyNames(RigidBody);
  assert.ok(names.includes('mass'));
  assert.ok(!names.includes('active'));

  const n = 2;
  RigidBody.vx = new Float32Array(n);
  RigidBody.vy = new Float32Array(n);
  RigidBody.angularVelocity = new Float32Array(n);
  RigidBody.sleeping = new Uint8Array(n);
  try {
    const withHeap = getInspectorPropertyNames(RigidBody);
    assert.ok(withHeap.includes('vx'));
    assert.ok(withHeap.includes('vy'));
    assert.ok(withHeap.includes('angularVelocity'));
    assert.ok(withHeap.includes('sleeping'));
  } finally {
    RigidBody.vx = null;
    RigidBody.vy = null;
    RigidBody.angularVelocity = null;
    RigidBody.sleeping = null;
  }
});
