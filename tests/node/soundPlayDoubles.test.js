import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { rng, rngInto, seededRandom } from '../../src/util/utils.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// E-542: SoundManager.play's doubles go through a Float64Array, never across a call. The two helpers that took it
// there answer as the forms they stand for: Camera.worldToScreenInPlace as worldToScreen (bit for bit, any zoom and
// angle), rngInto as rng() (the same draws from the seeded generator, and any other generator's own call).

const W = 1280;
const H = 720;

function bootCamera(zoom, rotation, x, y) {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = zoom;
  data[5] = zoom;
  data[1] = x;
  data[2] = y;
  Camera.setAngle(rotation);
}

test('worldToScreenInPlace writes the point worldToScreen returns, at any zoom and angle', () => {
  const r = mulberry32(0xe542);
  const f = new Float64Array(5);
  const out = { x: 0, y: 0 };
  for (const zoom of [0.25, 0.5, 1, 1.75, 3]) {
    for (const rotation of [0, 0.3, Math.PI / 2, -1.1, Math.PI]) {
      bootCamera(zoom, rotation, 300 + r() * 2000, 100 + r() * 1500);
      for (let k = 0; k < 50; k++) {
        const wx = (r() - 0.25) * 6000;
        const wy = (r() - 0.25) * 4000;
        Camera.worldToScreen(wx, wy, out);
        f[2] = wx;
        f[3] = wy;
        Camera.worldToScreenInPlace(f, 2);
        assert.equal(f[2], out.x, `x at zoom ${zoom}, angle ${rotation}, (${wx}, ${wy})`);
        assert.equal(f[3], out.y, `y at zoom ${zoom}, angle ${rotation}, (${wx}, ${wy})`);
      }
    }
  }
});

test('rngInto draws what rng() draws, from the seeded generator and from any other', () => {
  const saved = globalThis.rng;
  try {
    globalThis.rng = seededRandom(542, 'a');
    const fromRng = Array.from({ length: 64 }, () => rng());
    globalThis.rng = seededRandom(542, 'a');
    const f = new Float64Array(3);
    const fromInto = Array.from({ length: 64 }, () => {
      rngInto(f, 1);
      return f[1];
    });
    assert.deepEqual(fromInto, fromRng);

    // Not a seededRandom generator: its own call.
    let calls = 0;
    globalThis.rng = () => {
      calls++;
      return 0.125 * calls;
    };
    rngInto(f, 2);
    rngInto(f, 0);
    assert.deepEqual([calls, f[2], f[0]], [2, 0.125, 0.25]);
  } finally {
    globalThis.rng = saved;
  }
});
