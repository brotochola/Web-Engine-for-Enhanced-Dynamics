// The barrio's cars (demos/buenosAiresScene/carGeometry.js): where a car's picture draws its floor's points on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PICTURE_FLOOR_SCALE, floorPointInCarFrame, screenFootprint } from '../buenosAiresScene/carGeometry.js';

const DEG = Math.PI / 180;

test('a headlight hung in the car\'s frame lands where its picture draws that corner, at every heading', () => {
  const out = { x: 0, y: 0 };
  for (let theta = -175; theta <= 180; theta += 5) {
    // The car at `theta` on its floor, so its picture points at `angle` on the screen.
    const c = Math.cos(theta * DEG);
    const s = Math.sin(theta * DEG);
    const angle = Math.atan2(PICTURE_FLOOR_SCALE * s, c);
    for (const side of [-10, 0, 10]) {
      floorPointInCarFrame(angle, 39, side, out);
      // What physics does with a child's offset: turned by the car's rotation on the screen.
      const x = out.x * Math.cos(angle) - out.y * Math.sin(angle);
      const y = out.x * Math.sin(angle) + out.y * Math.cos(angle);
      assert.ok(Math.abs(x - (39 * c - side * s)) < 1e-9, `heading ${theta}, side ${side}: x`);
      assert.ok(Math.abs(y - PICTURE_FLOOR_SCALE * (39 * s + side * c)) < 1e-9, `heading ${theta}, side ${side}: y`);
    }
    // The middle of the front is straight ahead; along and across the screen its corners are square, between they are not.
    floorPointInCarFrame(angle, 39, 0, out);
    assert.ok(Math.abs(out.y) < 1e-9 && out.x > 0, `heading ${theta}: ahead`);
  }
  floorPointInCarFrame(0, 39, 10, out);
  assert.ok(Math.abs(out.x - 39) < 1e-9 && Math.abs(out.y - 10 * PICTURE_FLOOR_SCALE) < 1e-9);
});

test('a car\'s collider is as long as its picture draws it at that heading, with the footprint\'s area', () => {
  const out = { length: 0, width: 0 };
  for (let theta = 0; theta <= 90; theta += 5) {
    const c = Math.cos(theta * DEG);
    const s = Math.sin(theta * DEG);
    const angle = Math.atan2(PICTURE_FLOOR_SCALE * s, c);
    screenFootprint(39, 16, Math.cos(angle), Math.sin(angle), out);
    assert.ok(Math.abs(out.length - 2 * 39 * Math.hypot(c, PICTURE_FLOOR_SCALE * s)) < 1e-9, `heading ${theta}`);
    assert.ok(Math.abs(out.length * out.width - 4 * 39 * 16 * PICTURE_FLOOR_SCALE) < 1e-6, `heading ${theta}: the area`);
  }
});
