/**
 * DBG-9: the Scene tab's camera section: what the logic camera is doing, the projection config.camera resolves to, and
 * the zoom slider's log scale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cameraProjectionText, cameraReadoutText, sliderToZoom, zoomToSlider } from '../../src/core/debug/panels/cameraSection.js';

function fakeCamera({ zoom = 1.5, cx = 400, cy = 300, rotation = 0, slot = 0, target = null, free = false } = {}) {
  const data = new Float32Array(17);
  data[6] = slot;
  return {
    isInitialized: true,
    _data: data,
    IDX_FOLLOW_ENTITY: 6,
    zoom,
    centerX: cx,
    centerY: cy,
    rotation,
    _free: free,
    getFollowTarget: () => target,
  };
}

test('the read-out names zoom, centre, turn and what the camera follows', () => {
  assert.equal(cameraReadoutText(fakeCamera()), 'zoom 1.500 · centre 400, 300 · turn 0.0° · follows nothing');
  assert.equal(
    cameraReadoutText(fakeCamera({ slot: 13, target: { x: 1, y: 2 }, rotation: Math.PI / 2, free: true })),
    'zoom 1.500 · centre 400, 300 · turn 90.0° · follows entity #12 · free camera',
  );
  assert.match(cameraReadoutText(fakeCamera({ target: { x: 10.4, y: 20.6 } })), /follows point 10, 21$/);
  assert.equal(cameraReadoutText({ isInitialized: false }), 'not initialized');
});

test('the projection: unset, oblique, and the two flat views', () => {
  assert.equal(
    cameraProjectionText(undefined),
    'pitch unset · yaw 0° · floorScaleY 1.000 · heightScaleY 1.000 · classic: the floor as drawn, heights as measured',
  );
  assert.match(cameraProjectionText({ pitch: 60 }), /pitch 60° .* floorScaleY 0\.866 · heightScaleY 0\.500 · oblique/);
  assert.match(cameraProjectionText({ pitch: 90 }), /flat \(pitch 90\): lit as any other view$/);
  assert.match(cameraProjectionText({ pitch: 0 }), /flat \(pitch 0\): lit as any other view$/);
});

test('the zoom slider is a log scale between min and max zoom, both ways', () => {
  assert.equal(zoomToSlider(0.1, 0.1, 10), 0);
  assert.equal(zoomToSlider(1, 0.1, 10), 500);
  assert.equal(zoomToSlider(10, 0.1, 10), 1000);
  assert.equal(zoomToSlider(50, 0.1, 10), 1000, 'clamped');
  assert.ok(Math.abs(sliderToZoom(500, 0.1, 10) - 1) < 1e-9);
  assert.equal(zoomToSlider(1, 2, 2), 0, 'an empty range');
});
