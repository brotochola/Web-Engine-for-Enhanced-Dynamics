import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundManager } from '../../src/core/soundManager.js';
import { Camera } from '../../src/core/camera.js';

// N-13 follow-up. Sound pan and the off-screen falloff were taken along world x
// against the viewport box. Under a turned camera screen x is another world
// axis, so a sound on the right of the screen panned to the center.

const W = 1280;
const H = 720;

function bootCamera(rot) {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = 1;
  data[5] = 1;
  data[1] = 1000 - W / 2;
  data[2] = 500 - H / 2;
  Camera.setAngle(rot);
  globalThis.Camera = Camera;
}

test('pan follows screen x under a turned camera', () => {
  bootCamera(Math.PI / 2);
  try {
    // At 90 degrees, screen right is world up: 300 px above the focus.
    const s = SoundManager._computeSpatial(1000, 500 - 300);
    assert.ok(s.pan > 0.1, `pan ${s.pan}`);
    assert.equal(s.audible, 1);
    assert.equal(s.gain, 1, 'on screen');

    // World right of the focus is screen down at 90 degrees: centered pan.
    const d = SoundManager._computeSpatial(1000 + 300, 500);
    assert.ok(Math.abs(d.pan) < 1e-6, `pan ${d.pan}`);
  } finally {
    delete globalThis.Camera;
  }
});

test('the off-screen falloff is measured from the turned screen', () => {
  bootCamera(Math.PI / 2);
  try {
    // Screen x = W/2 + 740 -> 100 px past the right edge of the turned screen.
    const s = SoundManager._computeSpatial(1000, 500 - 740);
    assert.ok(Math.abs(s.gain - (1 - 100 / W)) < 1e-4, `gain ${s.gain}`);
  } finally {
    delete globalThis.Camera;
  }
});

test('an unturned camera gives the same pan and gain as before', () => {
  bootCamera(0);
  try {
    for (const [x, y] of [[1000, 500], [1300, 400], [-400, 500], [2000, 2000], [1000, 500 + H]]) {
      const s = SoundManager._computeSpatial(x, y);
      const left = 1000 - W / 2;
      const top = 500 - H / 2;
      const right = left + W;
      const bottom = top + H;
      const pan = Math.max(-1, Math.min(1, (x - (left + right) * 0.5) / (W * 1.5)));
      const dxOut = x < left ? left - x : x > right ? x - right : 0;
      const dyOut = y < top ? top - y : y > bottom ? y - bottom : 0;
      const outside = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
      const gain = outside <= 0 ? 1 : Math.max(0, 1 - outside / W);
      assert.ok(Math.abs(s.pan - pan) < 1e-9, `pan at ${x},${y}: ${s.pan} vs ${pan}`);
      assert.ok(Math.abs(s.gain - gain) < 1e-9, `gain at ${x},${y}: ${s.gain} vs ${gain}`);
    }
  } finally {
    delete globalThis.Camera;
  }
});
