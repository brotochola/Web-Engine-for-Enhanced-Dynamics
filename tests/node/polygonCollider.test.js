import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { ShapeType, MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';

function initComponents(count = 4) {
  const cSize = Collider.getBufferSize(count);
  const rSize = RigidBody.getBufferSize(count);
  Collider.initializeArrays(new SharedArrayBuffer(cSize), count);
  RigidBody.initializeArrays(new SharedArrayBuffer(rSize), count);
  for (let i = 0; i < count; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    RigidBody.static[i] = 0;
  }
}

test('ShapeType uses WASM C numbering (Box=0, Circle=1, Polygon=2)', () => {
  assert.equal(ShapeType.Box, 0);
  assert.equal(ShapeType.Circle, 1);
  assert.equal(ShapeType.Polygon, 2);
});

test('radius setter sets ShapeType.Circle; width setter sets ShapeType.Box', () => {
  initComponents();
  const c = Object.create(Collider.prototype);
  c.index = 0;
  c.radius = 5;
  assert.equal(Collider.shapeType[0], ShapeType.Circle);
  c.width = 10;
  c.height = 12;
  assert.equal(Collider.shapeType[0], ShapeType.Box);
});

test('ShapeType.Box + width/height syncs mass from rectangle area', () => {
  initComponents();
  assert.equal(MAX_POLYGON_VERTICES, 8);
  Collider.shapeType[0] = ShapeType.Box;
  Collider.width[0] = 20;
  Collider.height[0] = 40;
  RigidBody.syncMassFromCollider(0);
  assert.equal(Collider.shapeType[0], ShapeType.Box);
  assert.ok(Math.abs(RigidBody.mass[0] - 800) < 1e-3);
});

test('Collider.makePolygon rejects bad count and accepts triangle', () => {
  initComponents();
  assert.equal(Collider.makePolygon(1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]), false);
  assert.ok(Collider.makePolygon(1, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ]));
  assert.equal(Collider.polyCount[1], 3);
  assert.equal(Collider.shapeType[1], ShapeType.Polygon);
  assert.ok(RigidBody.mass[1] > 0);
});
