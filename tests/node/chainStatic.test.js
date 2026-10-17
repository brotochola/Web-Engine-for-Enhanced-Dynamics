import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { ShapeType } from '../../src/util/configDefaults.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('a dynamic chain is stored as a static body', () => {
  const n = 1;
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  RigidBody.active[0] = 1;
  RigidBody.static[0] = 0;
  Collider.active[0] = 1;
  Collider.shapeType[0] = ShapeType.Chain;
  Collider.width[0] = 10;
  Collider.height[0] = 4;
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    RigidBody.syncMassFromCollider(0);
    assert.equal(RigidBody.static[0], 1);
    assert.equal(RigidBody.mass[0], 0);
    assert.equal(RigidBody.invMass[0], 0);
    assert.equal(RigidBody.inertia[0], 0);
    assert.equal(RigidBody.invInertia[0], 0);
    assert.equal(warns.length, 1);
    RigidBody.syncMassFromCollider(0);
    assert.equal(warns.length, 1);
  } finally {
    console.warn = orig;
  }

  const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');
  assert.match(post, /const chain = shape === ShapeType\.Chain;/);
  assert.match(post, /views\.rbStatic\[i\] !== 0 \|\| chain/);
  assert.match(post, /views\.rbStatic\[i\] \|\| chain \? Box2dBodyType\.STATIC/);
});

test('setChain warns once when the outline is too short', () => {
  ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(8, 1)), 8, 1);
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    assert.equal(Collider.setChain(0, new Float32Array([0, 0, 1, 0]), null, false), false);
    assert.equal(Collider.setChain(0, new Float32Array([0, 0, 1, 0]), null, false), false);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /count/);
  assert.equal(ChainPoints.lastError.code, 'count');
});
