import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { ShapeType } from '../../src/util/configDefaults.js';

// DX 3.2. A sprite was sized with setScale(width / textureWidth, …), so the
// game had to know the texture was 8 px wide, and the collider was sized again
// by hand. setDisplaySize takes world px; collider.fitToSprite copies the
// drawn box (and the anchor offset) onto the collider.

const N = 4;
const SHEET = 2;
const ANIM = 5;

function setup() {
  for (const C of [Transform, SpriteRenderer, Collider, RigidBody]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  SpriteSheetRegistry._frameSizeCache.clear();
  for (let i = 0; i < N; i++) {
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.spritesheetId[i] = SHEET;
    SpriteRenderer.animationState[i] = ANIM;
    SpriteRenderer.scaleX[i] = 1;
    SpriteRenderer.scaleY[i] = 1;
    SpriteRenderer.anchorX[i] = 0.5;
    SpriteRenderer.anchorY[i] = 0.5;
    Collider.active[i] = 1;
  }
}

function withFrame(w, h, fn) {
  const real = SpriteSheetRegistry.getFrameDimensionsById;
  let calls = 0;
  SpriteSheetRegistry.getFrameDimensionsById = (sheet, anim) => {
    calls++;
    return sheet === SHEET && anim === ANIM ? { w, h } : null;
  };
  try {
    fn(() => calls);
  } finally {
    SpriteSheetRegistry.getFrameDimensionsById = real;
  }
}

function sprite(index) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = { SpriteRenderer: true, Collider: true };
  return go;
}

test('setDisplaySize scales to world px; without a height it keeps the aspect', () => {
  setup();
  withFrame(8, 4, () => {
    const go = sprite(0);
    assert.equal(go.setDisplaySize(32, 8), go);
    assert.deepEqual([SpriteRenderer.scaleX[0], SpriteRenderer.scaleY[0]], [4, 2]);
    go.setDisplaySize(16);
    assert.deepEqual([SpriteRenderer.scaleX[0], SpriteRenderer.scaleY[0]], [2, 2]);
  });
});

test('frameSizeOf caches a known size by number and does not cache an unknown one', () => {
  setup();
  withFrame(8, 4, (calls) => {
    const a = SpriteSheetRegistry.frameSizeOf(SHEET, ANIM);
    const b = SpriteSheetRegistry.frameSizeOf(SHEET, ANIM);
    assert.equal(a, b);
    assert.deepEqual(a, { w: 8, h: 4 });
    assert.equal(calls(), 1);
    assert.equal(SpriteSheetRegistry.frameSizeOf(SHEET, ANIM + 1), null);
    assert.equal(SpriteSheetRegistry.frameSizeOf(SHEET, ANIM + 1), null);
    assert.equal(calls(), 3, 'unknown sizes are asked again: a sheet may register later');
    assert.equal(SpriteSheetRegistry.frameSizeOf(0, ANIM), null, 'sheet 0 is no sprite');
  });
});

test('setDisplaySize without a sprite warns once per class and changes nothing', () => {
  setup();
  SpriteRenderer.spritesheetId[1] = 0;
  const original = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(m);
  try {
    class Blank extends GameObject {}
    const go = Object.assign(Object.create(Blank.prototype), { index: 1, _hasComponents: { SpriteRenderer: true } });
    go.setDisplaySize(10);
    go.setDisplaySize(20);
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Blank\.setDisplaySize needs a sprite/);
  assert.equal(SpriteRenderer.scaleX[1], 1);
});

test('fitToSprite: a box takes the drawn size; the anchor and a flip move its offset', () => {
  setup();
  withFrame(8, 4, () => {
    const c = new Collider(2);
    Collider.shapeType[2] = ShapeType.Box;
    SpriteRenderer.scaleX[2] = -4; // flipped, 32 px wide
    SpriteRenderer.scaleY[2] = 2; //  8 px tall
    SpriteRenderer.anchorX[2] = 0; // anchored at its left edge (mirrored by the flip)
    SpriteRenderer.anchorY[2] = 1; // and at its feet
    assert.equal(c.fitToSprite(), true);
    assert.deepEqual([Collider.width[2], Collider.height[2]], [32, 8]);
    assert.equal(Collider.offsetX[2], -16, 'centre is half the width to the left once flipped');
    assert.equal(Collider.offsetY[2], -4, 'centre is half the height above the feet');
  });
});

test('fitToSprite: a circle takes half the smaller side × factor; a polygon is left alone', () => {
  setup();
  withFrame(8, 4, () => {
    const c = new Collider(3);
    Collider.shapeType[3] = ShapeType.Circle;
    SpriteRenderer.scaleX[3] = 4;
    SpriteRenderer.scaleY[3] = 4; // 32 × 16
    assert.equal(c.fitToSprite(0.5), true);
    assert.equal(Collider.radius[3], 4);
    assert.equal(Collider.shapeType[3], ShapeType.Circle);
    assert.equal(Collider.offsetX[3], 0);
    Collider.shapeType[3] = ShapeType.Polygon;
    const original = console.warn;
    console.warn = () => {};
    try {
      assert.equal(c.fitToSprite(), false);
    } finally {
      console.warn = original;
    }
  });
});
