/**
 * E-504 (src/render/worldRectCache.js): a cached worldRect layer is drawn again only when what it shows changed: the
 * camera, the canvas' size, its uniforms or pictures (`changed`), or every frame when its shader reads the frame's time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createWorldRectCache, readsFrameTime, worldRectCacheStale } from '../../src/render/worldRectCache.js';

const VIEW = [1.5, 120.25, -40, 0, 1280, 760];

test('the first frame draws; the same view does not draw again; any change of the view or its contents does', () => {
  const c = createWorldRectCache();
  assert.equal(worldRectCacheStale(c, ...VIEW, false), true, 'the first frame');
  assert.equal(worldRectCacheStale(c, ...VIEW, false), false, 'the camera held');
  assert.equal(worldRectCacheStale(c, ...VIEW, false), false, 'still held');
  for (let field = 0; field < VIEW.length; field++) {
    const moved = VIEW.slice();
    moved[field] += field === 3 ? 0.01 : 1;
    assert.equal(worldRectCacheStale(c, ...moved, false), true, `field ${field} changed`);
    assert.equal(worldRectCacheStale(c, ...moved, false), false, `field ${field} held after`);
    assert.equal(worldRectCacheStale(c, ...VIEW, false), true, `field ${field} back`);
  }
  assert.equal(worldRectCacheStale(c, ...VIEW, true), true, 'a uniform or a picture changed');
  assert.equal(worldRectCacheStale(c, ...VIEW, false), false);
});

test('a shader whose source reads uTime or uDt changes every frame; the camera uniforms, or a longer name, do not', () => {
  assert.equal(readsFrameTime(null), false);
  assert.equal(readsFrameTime('uniform float uZoom; uniform vec2 uCameraPos; void main() { x = uZoom; }'), false);
  assert.equal(readsFrameTime('uniform float uTime; void main() { x = sin(uTime); }'), true);
  assert.equal(readsFrameTime('let d = customUniforms.uDt;'), true);
  assert.equal(readsFrameTime('uniform float uTimeOfDay;'), false);
  // The barrio's floor (a worldRect shader that reads neither): cached.
  const floor = new URL('../../demos/buenosAiresScene/floor.frag', import.meta.url);
  assert.equal(readsFrameTime(fs.readFileSync(floor, 'utf8')), false);
});
