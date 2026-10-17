import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Joint } from '../../src/core/joint.js';
import { JOINT_TYPE } from '../../src/box2d/box2dConstants.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function boot(maxJoints = 8) {
  Joint.reset();
  const sab = new SharedArrayBuffer(Joint.getBufferSize(maxJoints, 8));
  Joint.initializeArrays(sab, maxJoints, 8);
  const freeListSab = new SharedArrayBuffer(maxJoints * 2);
  const freeListTopSab = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTopSab), new Uint16Array(freeListSab), maxJoints, 1);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeListSab, freeListTopSab);
}

test('prismatic fields alias the revolute and weld columns', () => {
  boot();
  const idx = Joint.addPrismatic({
    entityA: 1,
    entityB: 2,
    axisAngle: 1.25,
    enableLimit: true,
    lowerTranslation: -10,
    upperTranslation: 40,
    enableMotor: true,
    motorSpeed: 3,
    maxMotorForce: 12,
  });
  assert.ok(idx >= 0);
  assert.equal(Joint.type[idx], JOINT_TYPE.PRISMATIC);
  assert.equal(Joint.linearHertz[idx], 1.25);
  assert.equal(Joint.lowerAngle[idx], -10);
  assert.equal(Joint.upperAngle[idx], 40);
  assert.equal(Joint.maxMotorTorque[idx], 12);
  assert.equal(Joint.enableMotor[idx], 1);

  Joint.update(idx, { axisAngle: 0.5, maxMotorForce: 4, lowerTranslation: -2 });
  assert.equal(Joint.linearHertz[idx], 0.5);
  assert.equal(Joint.maxMotorTorque[idx], 4);
  assert.equal(Joint.lowerAngle[idx], -2);

  Joint.update(idx, { maxMotorTorque: 9 });
  assert.equal(Joint.maxMotorTorque[idx], 9);

  const saved = Joint.serializeActive();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].axisAngle, 0.5);
  assert.equal(saved[0].maxMotorForce, 9);
  Joint.remove(idx);
  const again = Joint.restoreFromSave(saved, null);
  assert.equal(again.length, 1);
  assert.equal(Joint.linearHertz[again[0]], 0.5);
  assert.equal(Joint.upperAngle[again[0]], 40);
  assert.equal(Joint.maxMotorTorque[again[0]], 9);

  const idx2 = Joint.addPrismatic({ entityA: 1, entityB: 2, maxMotorTorque: 15 });
  assert.equal(Joint.maxMotorTorque[idx2], 15);
  Joint.remove(idx2);

  Joint.reset();
});

test('physics host creates a prismatic joint through createPrismaticJointLocal', () => {
  const host = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');
  const api = readFileSync(join(root, 'src/box2d/physicsApi.js'), 'utf8');
  assert.match(host, /world\.createPrismaticJointLocal\(/);
  assert.match(api, /createPrismaticJointLocal\(options = \{\}\)/);
  assert.match(api, /return this\.createPrismaticJoint\(/);
});
