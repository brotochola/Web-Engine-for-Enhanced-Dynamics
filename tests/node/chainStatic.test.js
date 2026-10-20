import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Collider } from '../../src/components/collider.js';
import { RigidBody, RIGID_BODY_CHAIN_STATIC } from '../../src/components/rigidBody.js';
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
    assert.equal(RigidBody.static[0], RIGID_BODY_CHAIN_STATIC);
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

// B29 (mass sync flips body type). The chain-static flag used to be 1, the same
// as a user's static, so a body that had a chain for a while stayed static for
// good after its collider became a polygon.
test('a body static only because of its chain is dynamic again without it', async () => {
  const { bindBodySyncBuffers, BODY_DIRTY } = await import('../../src/box2d/box2dBodySync.js');
  const n = 2;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(n * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(n * 4),
  };
  bindBodySyncBuffers(buffers);
  const flags = new Int32Array(buffers.bodyDirtyFlags);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  const orig = console.warn;
  console.warn = () => {};
  try {
    for (const i of [0, 1]) {
      RigidBody.active[i] = 1;
      Collider.active[i] = 1;
      Collider.shapeType[i] = ShapeType.Chain;
    }
    RigidBody.static[1] = 1; // the user's static
    RigidBody.syncMassFromCollider(0);
    RigidBody.syncMassFromCollider(1);
    assert.equal(RigidBody.static[0], RIGID_BODY_CHAIN_STATIC);
    assert.equal(RigidBody.static[1], 1);

    flags.fill(0);
    assert.equal(Collider.makePolygon(0, [0, 0, 10, 0, 10, 10, 0, 10]), true);
    assert.equal(Collider.makePolygon(1, [0, 0, 10, 0, 10, 10, 0, 10]), true);
    assert.equal(RigidBody.static[0], 0, 'dynamic again');
    assert.ok(RigidBody.invMass[0] > 0);
    assert.equal(flags[0] & BODY_DIRTY.BODY_TYPE, BODY_DIRTY.BODY_TYPE, 'physics told to switch the type');
    assert.equal(RigidBody.static[1], 1, 'a user static stays static');
    assert.equal(RigidBody.invMass[1], 0);
  } finally {
    console.warn = orig;
  }
});
