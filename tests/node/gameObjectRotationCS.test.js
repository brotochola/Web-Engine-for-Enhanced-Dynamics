import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
} from '../../src/box2d/box2dCommandRing.js';

// setRotationCS faces an entity along a unit direction without trig (the
// boids face their velocity this way, 40k of them).

function entity(index, hasBody) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = hasBody ? { RigidBody: true } : {};
  return go;
}

function withTransform(fn) {
  const saved = { rotation: Transform.rotation, rotC: Transform.rotC, rotS: Transform.rotS };
  Transform.rotation = new Float32Array(4);
  Transform.rotC = new Float32Array(4).fill(1);
  Transform.rotS = new Float32Array(4);
  try {
    fn();
  } finally {
    Object.assign(Transform, saved);
  }
}

test('a body gets the cos/sin and one SET_ROT_CS command; physics writes the angle', () => {
  withTransform(() => {
    const sab = createCommandRingSab(16);
    bindCommandRing(sab);
    const c = Math.SQRT1_2;
    const s = -Math.SQRT1_2;
    entity(2, true).setRotationCS(c, s);
    assert.ok(Math.abs(Transform.rotC[2] - c) < 1e-6);
    assert.ok(Math.abs(Transform.rotS[2] - s) < 1e-6);
    assert.equal(Transform.rotation[2], 0, 'the angle is left to physics');
    const sent = [];
    drainCommandRing(new Int32Array(sab), new Float32Array(sab), {
      setRotCS: (i, rc, rs) => sent.push([i, rc, rs]),
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 2);
    assert.ok(Math.abs(sent[0][1] - c) < 1e-6 && Math.abs(sent[0][2] - s) < 1e-6);
  });
});

test('an entity without a body gets its angle here', () => {
  withTransform(() => {
    const go = entity(1, false);
    go.setRotationCS(0, 1);
    assert.equal(Transform.rotC[1], 0);
    assert.equal(Transform.rotS[1], 1);
    assert.ok(Math.abs(go.rotation - Math.PI / 2) < 1e-6);
  });
});
