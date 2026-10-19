// Camera roll for the planet scene: the world must rotate so the local
// outward radial (the planet's "up" under the ship) stays at screen top as the
// ship travels around the disk. Mirrors Camera.worldToScreen's rotation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { radialCameraAngle, CX, CY } from '../../demos/planetPhysicsScene/planetGravity.js';

function rotate(x, y, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: c * x - s * y, y: s * x + c * y };
}

test('radial camera angle maps local up to screen top all around the planet', () => {
  const radius = 1500;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const x = CX + Math.cos(a) * radius;
    const y = CY + Math.sin(a) * radius;
    const rot = radialCameraAngle(x, y);
    const outX = Math.cos(a);
    const outY = Math.sin(a);
    const up = rotate(outX, outY, rot);
    assert.ok(Math.abs(up.x) < 1e-9, `screen up x=${up.x} at angle ${a}`);
    assert.ok(Math.abs(up.y + 1) < 1e-9, `screen up y=${up.y} at angle ${a}`);
  }
});

test('radial camera angle is 0 above the core and -PI/2 to its right', () => {
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  assert.ok(Math.abs(radialCameraAngle(CX, CY - 1000)) < 1e-12);
  assert.ok(Math.abs(radialCameraAngle(CX + 1000, CY) + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(wrap(radialCameraAngle(CX, CY + 1000)) + Math.PI) < 1e-12);
  assert.ok(Math.abs(wrap(radialCameraAngle(CX - 1000, CY)) - Math.PI / 2) < 1e-12);
});
