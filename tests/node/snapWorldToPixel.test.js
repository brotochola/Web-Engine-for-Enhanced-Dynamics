import test from 'node:test';
import assert from 'node:assert/strict';
import { snapWorldToPixel } from '../../src/render/instancedSpriteBatch.js';

test('snapWorldToPixel puts anchors on the same screen-pixel phase', () => {
  const zoom = 2;
  const cam = 10;
  const a = snapWorldToPixel(11.2, cam, zoom);
  const b = snapWorldToPixel(21.3, cam, zoom);
  assert.equal(((a - cam) * zoom) % 1, 0);
  assert.equal(((b - cam) * zoom) % 1, 0);
  assert.equal(snapWorldToPixel(11.2, cam, zoom), snapWorldToPixel(11.24, cam, zoom));
  assert.equal(snapWorldToPixel(5, 0, 0), 5);
});
