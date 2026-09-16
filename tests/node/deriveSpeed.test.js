import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';

test('GameObject.deriveSpeed defaults false; subclass opt-in', () => {
  assert.equal(GameObject.deriveSpeed, false);

  class NeedsSpeed extends GameObject {
    static deriveSpeed = true;
  }
  class Quiet extends GameObject {}

  assert.equal(NeedsSpeed.deriveSpeed, true);
  assert.equal(Quiet.deriveSpeed, false);
  assert.equal(Quiet.deriveSpeed === true, false);
});

test('deriveSpeed inherits unless subclass sets false', () => {
  class NeedsSpeed extends GameObject {
    static deriveSpeed = true;
  }
  class ChildKeeps extends NeedsSpeed {}
  class ChildOff extends NeedsSpeed {
    static deriveSpeed = false;
  }

  assert.equal(ChildKeeps.deriveSpeed, true);
  assert.equal(ChildOff.deriveSpeed, false);
});

test('deriveSpeedByType stamps opted-in entityType ids', () => {
  const registered = [
    { entityType: 0, deriveSpeed: false },
    { entityType: 1, deriveSpeed: true },
    { entityType: 2, deriveSpeed: false },
    { entityType: 3, deriveSpeed: true },
  ];
  const deriveSpeedByType = new Uint8Array(registered.length);
  for (const classInfo of registered) {
    if (classInfo.deriveSpeed === true) deriveSpeedByType[classInfo.entityType] = 1;
  }

  assert.equal(deriveSpeedByType[0], 0);
  assert.equal(deriveSpeedByType[1], 1);
  assert.equal(deriveSpeedByType[2], 0);
  assert.equal(deriveSpeedByType[3], 1);
});
