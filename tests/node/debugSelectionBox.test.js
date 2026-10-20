import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsDebugRenderer } from '../../src/core/debug/rendering/physicsDebugRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';

// B29 (debug selection box offset). The selected sprite's box read its anchor
// with `|| 0.5`, so a top-left anchor (0) drew the box half a sprite off, and
// it used |scale|, so a flipped sprite's box was not mirrored. It now uses the
// shader's corners: (v - anchor) * size * scale.

const ctx = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}),
  set: () => true,
});

function boxFor({ anchorX, anchorY, scaleX = 1, scaleY = 1 }) {
  const n = 1;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  Transform.x = new Float32Array([100]);
  Transform.y = new Float32Array([100]);
  Transform.rotC = new Float32Array([1]);
  Transform.rotS = new Float32Array([0]);
  Transform.active[0] = 1;
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(n)), n);
  SpriteRenderer.active[0] = 1;
  SpriteRenderer.anchorX[0] = anchorX;
  SpriteRenderer.anchorY[0] = anchorY;
  SpriteRenderer.scaleX[0] = scaleX;
  SpriteRenderer.scaleY[0] = scaleY;
  SpriteRenderer.inheritTransformRotation[0] = 1;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  const r = new PhysicsDebugRenderer();
  r.drawSelectedEntity(ctx, {}, { x: 0, y: 0, rotation: 0 }, 1, { getSelectedEntity: () => 0 }, null);
  const q = r._quad;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// getOriginalWidth/Height have no sheet here, so the box is the 20x20 fallback.
test('a top-left anchor boxes the sprite from its anchor, not half a sprite off', () => {
  assert.deepEqual(boxFor({ anchorX: 0, anchorY: 0 }), { minX: 100, maxX: 120, minY: 100, maxY: 120 });
});

test('a flipped sprite box is mirrored about its anchor', () => {
  assert.deepEqual(boxFor({ anchorX: 0.5, anchorY: 0.25, scaleY: -1 }), { minX: 90, maxX: 110, minY: 85, maxY: 105 });
});
