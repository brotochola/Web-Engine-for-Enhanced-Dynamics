/**
 * E-504 (src/render/worldRectCache.js): a worldRect layer is painted again only when what it shows changed: the camera,
 * the canvas' size, its uniforms or pictures (`changed`), or every frame when its shader reads the frame's time; and it
 * adapts: a view that keeps changing draws on the stage instead, one that holds goes back to the target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createWorldRectCache,
  readsFrameTime,
  worldRectCacheStale,
  worldRectCacheStep,
  WORLD_RECT_DIRECT,
  WORLD_RECT_DIRECT_AFTER,
  WORLD_RECT_HOLD_FRAMES,
  WORLD_RECT_PAINT,
  WORLD_RECT_SHOW,
} from '../../src/render/worldRectCache.js';

const VIEW = [1.5, 120.25, -40, 0, 1280, 760];

test('the first frame paints; the same view does not paint again; any change of the view or its contents does', () => {
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

test('the step: paint on a change; a view that keeps changing goes to the stage; one that holds comes back painted', () => {
  const c = createWorldRectCache();
  const view = VIEW.slice();
  const step = (changed = false) => worldRectCacheStep(c, ...view, changed);
  assert.equal(step(), WORLD_RECT_PAINT, 'the first frame paints');
  assert.equal(step(), WORLD_RECT_SHOW, 'held: the target shows');
  // A camera that moves every frame: WORLD_RECT_DIRECT_AFTER paints, then the stage.
  const moving = [];
  for (let f = 0; f < WORLD_RECT_DIRECT_AFTER + 3; f++) {
    view[1] += 1;
    moving.push(step());
  }
  assert.deepEqual(moving, [
    ...Array(WORLD_RECT_DIRECT_AFTER).fill(WORLD_RECT_PAINT),
    WORLD_RECT_DIRECT, WORLD_RECT_DIRECT, WORLD_RECT_DIRECT,
  ]);
  // It stops: the stage until it held WORLD_RECT_HOLD_FRAMES frames, then the target, painted once, then shown.
  const stopped = [];
  for (let f = 0; f < WORLD_RECT_HOLD_FRAMES + 2; f++) stopped.push(step());
  assert.deepEqual(stopped, [
    ...Array(WORLD_RECT_HOLD_FRAMES - 1).fill(WORLD_RECT_DIRECT),
    WORLD_RECT_PAINT, WORLD_RECT_SHOW, WORLD_RECT_SHOW,
  ]);
  // A single change does not leave the target; changes every frame (a picture, the frame's time) do.
  view[2] += 1;
  assert.equal(step(), WORLD_RECT_PAINT);
  assert.equal(step(), WORLD_RECT_SHOW);
  const everyFrame = [];
  for (let f = 0; f < WORLD_RECT_DIRECT_AFTER + 2; f++) everyFrame.push(step(true));
  assert.equal(everyFrame.at(-1), WORLD_RECT_DIRECT, 'a shader that changes every frame ends on the stage');
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
