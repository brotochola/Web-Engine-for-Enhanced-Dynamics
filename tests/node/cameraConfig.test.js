// DX-CAMERA: config.camera says what the camera is, and the floor's foreshortening (light pools, cones, volumes) and
// the px a px of height rises (lighting.faces) come from it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { unknownConfigKeys, unknownConfigKeyText } from '../../src/util/configKeys.js';
import { resolveFaces } from '../../src/render/faceMap.js';
import { GROUND_SCALE_Y_MIN } from '../../src/util/lightRadius.js';
import {
  cameraFloorScaleY,
  cameraHeightScaleY,
  isObliqueCamera,
  resolveCamera,
} from '../../src/util/cameraView.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    fn();
  } finally {
    console.warn = saved;
  }
  return lines;
}

test('no camera draws what WeedJS always drew: a floor of 1, heights of 1, a flat view', () => {
  const c = resolveCamera(undefined);
  assert.equal(c.pitch, null);
  assert.equal(c.floorScaleY, 1);
  assert.equal(c.heightScaleY, 1);
  assert.equal(c.oblique, false);
  assert.equal(cameraFloorScaleY({}), 1);
  assert.equal(cameraHeightScaleY({}), 1);
});

test('pitch gives the floor sin(pitch) and heights cos(pitch); 90 is straight down, 0 from the side', () => {
  const c = resolveCamera({ pitch: 47 });
  close(c.floorScaleY, Math.sin((47 * Math.PI) / 180));
  close(c.heightScaleY, Math.cos((47 * Math.PI) / 180));
  assert.equal(c.oblique, true);
  const down = resolveCamera({ pitch: 90 });
  assert.equal(down.floorScaleY, 1);
  assert.equal(down.heightScaleY, 0);
  assert.equal(down.oblique, false, 'straight down is flat');
  const side = resolveCamera({ pitch: 0 });
  assert.equal(side.floorScaleY, GROUND_SCALE_Y_MIN, 'a floor seen edge-on keeps the smallest scale');
  assert.equal(side.heightScaleY, 1);
  assert.equal(isObliqueCamera({ pitch: 30 }), true);
});

test('floorScaleY and heightScaleY win over pitch: pictures that do not follow the trigonometry', () => {
  const lpc = resolveCamera({ pitch: 47, floorScaleY: 0.736, heightScaleY: 0.752 });
  assert.equal(lpc.floorScaleY, 0.736);
  assert.equal(lpc.heightScaleY, 0.752);
  assert.equal(resolveCamera({ floorScaleY: 0.7 }).heightScaleY, 1, 'only the floor: heights stay 1, as before');
  assert.equal(resolveCamera({ floorScaleY: 0.7 }).oblique, true);
});

test('values out of range are clamped, and a value that is no number is ignored, each named', () => {
  const problems = [];
  const c = resolveCamera({ pitch: 120, floorScaleY: 3, heightScaleY: -1, yaw: 'x' }, problems);
  assert.equal(c.pitch, 90);
  assert.equal(c.floorScaleY, 1);
  assert.equal(c.heightScaleY, 0);
  assert.equal(c.yaw, 0);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /camera\.pitch 120 is outside 0\.\.90: clamped/);
  assert.match(problems.join('\n'), /camera\.yaw is x, not a number: ignored/);
});

test('the old keys say where they went', () => {
  const items = unknownConfigKeys({ lighting: { groundScaleY: 0.7, faces: { enabled: true, heightScaleY: 0.8 } } });
  assert.deepEqual(items.map((i) => i.path), ['lighting.groundScaleY', 'lighting.faces.heightScaleY']);
  assert.match(unknownConfigKeyText('Town', items[0]), /config\.camera\.floorScaleY/);
  assert.match(unknownConfigKeyText('Town', items[1]), /config\.camera\.heightScaleY/);
  assert.deepEqual(unknownConfigKeys({ camera: { pitch: 47, yaw: 0, floorScaleY: 0.7, heightScaleY: 0.7 } }), []);
});

test('faces take the camera\'s heightScaleY', () => {
  assert.equal(resolveFaces({ faces: { enabled: true } }, { heightScaleY: 0.866 }).heightScaleY, 0.866);
  assert.equal(resolveFaces({ faces: { enabled: true } }, null).heightScaleY, 1);
  assert.equal(resolveFaces(null, { pitch: 60 }).heightScaleY, Math.cos(Math.PI / 3));
});

class Crate extends GameObject {}

test('a scene resolves its camera once and names what it fixed', () => {
  class Street extends Scene {
    static entities = [[Crate, 4]];
    static config = { worldWidth: 2000, worldHeight: 2000, camera: { pitch: 200, floorScaleY: 0.7 } };
  }
  let scene = null;
  const lines = warningsOf(() => {
    scene = new Street({});
  });
  assert.equal(scene.config.camera.pitch, 90);
  assert.equal(scene.config.camera.floorScaleY, 0.7);
  assert.equal(scene.config.camera.heightScaleY, 0);
  assert.deepEqual(lines, ['WeedJS: Street.config.camera.pitch 200 is outside 0..90: clamped']);
  class Plain extends Scene {
    static entities = [[Crate, 4]];
    static config = { worldWidth: 2000, worldHeight: 2000 };
  }
  assert.deepEqual(warningsOf(() => new Plain({})), []);
});
