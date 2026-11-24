// The barrio's cars (demos/buenosAiresScene/carGeometry.js): where a car's picture draws its floor's points on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PICTURE_FLOOR_SCALE, PICTURE_HEIGHT_SCALE, pointInCarFrame, screenFootprint } from '../buenosAiresScene/carGeometry.js';
import { CARS } from '../img/autos/index.js';
import { CAR_LAMPS } from '../img/autos/lamps.js';

const DEG = Math.PI / 180;

test('a point hung in the car\'s frame lands where its picture draws it, at every heading', () => {
  const out = { x: 0, y: 0 };
  for (let theta = -175; theta <= 180; theta += 5) {
    // The car at `theta` on its floor, so its picture points at `angle` on the screen.
    const c = Math.cos(theta * DEG);
    const s = Math.sin(theta * DEG);
    const angle = Math.atan2(PICTURE_FLOOR_SCALE * s, c);
    for (const side of [-10, 0, 10]) {
      pointInCarFrame(angle, 39, side, 11, out);
      // What physics does with a child's offset: turned by the car's rotation on the screen.
      const x = out.x * Math.cos(angle) - out.y * Math.sin(angle);
      const y = out.x * Math.sin(angle) + out.y * Math.cos(angle);
      assert.ok(Math.abs(x - (39 * c - side * s)) < 1e-9, `heading ${theta}, side ${side}: x`);
      assert.ok(Math.abs(y - (PICTURE_FLOOR_SCALE * (39 * s + side * c) - PICTURE_HEIGHT_SCALE * 11)) < 1e-9, `heading ${theta}, side ${side}: y`);
    }
    // The middle of the front is straight ahead; along and across the screen its corners are square, between they are not.
    pointInCarFrame(angle, 39, 0, 0, out);
    assert.ok(Math.abs(out.y) < 1e-9 && out.x > 0, `heading ${theta}: ahead`);
  }
  pointInCarFrame(0, 39, 10, 0, out);
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

test('every car sheet has its lamps, at the front, off the middle and under the roof (demos/tools/measureCarLamps.mjs)', () => {
  assert.deepEqual(Object.keys(CAR_LAMPS), Object.keys(CARS));
  for (const [sheet, [ahead, side, height]] of Object.entries(CAR_LAMPS)) {
    assert.ok(ahead > 0.75 && ahead < 1.1, `${sheet}: ahead ${ahead}`);
    assert.ok(side > 0.4 && side < 1, `${sheet}: side ${side}`);
    assert.ok(height > 5 && height < CARS[sheet].zmax, `${sheet}: height ${height}`);
  }
});

test('the lamps are where the owner marked them on four cars, to a few px (2026-11-23)', () => {
  // Each car as it stood in the capture: its heading on its floor (degrees) and the two marks from its centre, world px.
  const marked = {
    hatch_azul: [52.75, [30.3, 13.5], [13.8, 19.1]],
    colectivo_amarillo: [43.13, [61.8, 19.8], [43.3, 32.9]],
    sedan_blanco: [120, [-26.3, 14.9], [-7.2, 20.3]],
    suv_negro: [137.5, [-31.9, 2.7], [-17.9, 13]],
  };
  const out = { x: 0, y: 0 };
  for (const [sheet, [heading, ...marks]] of Object.entries(marked)) {
    const box = CARS[sheet].box;
    const [ahead, side, height] = CAR_LAMPS[sheet];
    const angle = Math.atan2(PICTURE_FLOOR_SCALE * Math.sin(heading * DEG), Math.cos(heading * DEG));
    for (const [x, y] of marks) {
      const gaps = [-1, 1].map((which) => {
        pointInCarFrame(angle, (ahead * (box[1] - box[0])) / 2, (which * side * (box[3] - box[2])) / 2, height, out);
        const lampX = out.x * Math.cos(angle) - out.y * Math.sin(angle);
        const lampY = out.x * Math.sin(angle) + out.y * Math.cos(angle);
        return Math.hypot(lampX - x, lampY - y);
      });
      assert.ok(Math.min(...gaps) < 6, `${sheet}: ${Math.min(...gaps).toFixed(1)} px from the mark`);
    }
  }
});
