import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toyWorldBounce,
  toyWorldBounceChecksum,
  TOY_LEFT,
  TOY_RIGHT,
  TOY_TOP,
  TOY_BOTTOM,
} from '../../src/util/toyWorldBounce.js';

test('toyWorldBounce flips on cached world sides and is deterministic', () => {
  const xs = new Float32Array([TOY_LEFT + 1, TOY_RIGHT - 1]);
  const ys = new Float32Array([TOY_TOP + 1, TOY_BOTTOM - 1]);
  const vxs = new Float32Array([-10, 10]);
  const vys = new Float32Array([-10, 10]);
  const ids = new Uint16Array([0, 1]);

  toyWorldBounce(xs, ys, vxs, vys, ids, 2, 1, TOY_LEFT, TOY_RIGHT, TOY_TOP, TOY_BOTTOM);

  assert.equal(xs[0], TOY_LEFT);
  assert.equal(ys[0], TOY_TOP);
  assert.equal(vxs[0], 10);
  assert.equal(vys[0], 10);
  assert.equal(xs[1], TOY_RIGHT);
  assert.equal(ys[1], TOY_BOTTOM);
  assert.equal(vxs[1], -10);
  assert.equal(vys[1], -10);

  const xs2 = new Float32Array(xs);
  const ys2 = new Float32Array(ys);
  const vxs2 = new Float32Array(vxs);
  const vys2 = new Float32Array(vys);
  toyWorldBounce(xs, ys, vxs, vys, ids, 2, 1);
  toyWorldBounce(xs2, ys2, vxs2, vys2, ids, 2, 1);
  assert.equal(
    toyWorldBounceChecksum(xs, ys, vxs, vys, 2),
    toyWorldBounceChecksum(xs2, ys2, vxs2, vys2, 2),
  );
});
