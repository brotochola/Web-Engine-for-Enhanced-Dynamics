// Camera roll for the planet scene: the world must rotate so the local
// outward radial (the planet's "up" under the ship) stays at screen top as the
// ship travels around the disk. Mirrors Camera.worldToScreen's rotation.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/registerWebRoot.mjs';
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

// B28 (boot camera at the wrong pole). The ship moved to the east of the disk
// but create() still centered the camera above the north pole at angle 0, so
// the first follow crossed a quarter of the planet and turned the view 90°.
// Runs the scene's real create() (the demo loads through the web-root hook).
test('create() starts the camera on the ship spawn, rolled to its local up', async () => {
  const { Camera } = await import('../../src/core/camera.js');
  const { PlanetPhysicsScene } = await import('../../demos/planetPhysicsScene/planetPhysicsScene.js');
  const { SHIP_SPAWN_X, SHIP_SPAWN_Y } = await import('../../demos/planetPhysicsScene/planetGravity.js');
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, 1280, 720);
  Camera.setWorldBounds(9000, 9000);
  PlanetPhysicsScene.prototype.create.call({ _spawnWalls() {}, _buildPanel() {} });
  assert.ok(Math.abs(Camera.rotation - radialCameraAngle(SHIP_SPAWN_X, SHIP_SPAWN_Y)) < 1e-6, `rotation ${Camera.rotation}`);
  assert.ok(Math.abs(Camera.centerX - SHIP_SPAWN_X) < 1e-3, `centerX ${Camera.centerX}`);
  assert.ok(Math.abs(Camera.centerY - SHIP_SPAWN_Y) < 1e-3, `centerY ${Camera.centerY}`);
  assert.ok(Math.abs(radialCameraAngle(SHIP_SPAWN_X, SHIP_SPAWN_Y) + Math.PI / 2) < 1e-12, 'east of the core');
});

test('the manager spawns the ship at the same point', async () => {
  const { readFileSync } = await import('node:fs');
  const manager = readFileSync(new URL('../../demos/planetPhysicsScene/gameObjects/planetWorldGridManager.js', import.meta.url), 'utf8');
  assert.match(manager, /PlanetShip\.spawn\(\{\s*x: SHIP_SPAWN_X,\s*y: SHIP_SPAWN_Y,/);
});
