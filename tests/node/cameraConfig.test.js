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

test('pitch gives the floor sin(pitch) and heights cos(pitch); 90 straight down and 0 from the side are flat views', () => {
  const c = resolveCamera({ pitch: 47 });
  close(c.floorScaleY, Math.sin((47 * Math.PI) / 180));
  close(c.heightScaleY, Math.cos((47 * Math.PI) / 180));
  assert.equal(c.oblique, true);
  const down = resolveCamera({ pitch: 90 });
  assert.equal(down.floorScaleY, 1);
  assert.equal(down.heightScaleY, 0);
  assert.equal(down.oblique, false, 'straight down is flat');
  // OL-4: from the side the plane that faces the camera is the floor (the backdrop the lights pool on), drawn as it is,
  // and height points at the camera, as from above.
  const side = resolveCamera({ pitch: 0 });
  assert.equal(side.floorScaleY, 1, 'the backdrop is not foreshortened');
  assert.equal(side.heightScaleY, 0, 'a height rises no px');
  assert.equal(side.oblique, false, 'from the side is flat');
  assert.equal(cameraFloorScaleY({ camera: { pitch: 0 } }), 1, 'the same from a config as the game wrote it');
  assert.equal(cameraHeightScaleY({ camera: { pitch: 0 } }), 0);
  const kept = resolveCamera({ pitch: 0, floorScaleY: 0.5, heightScaleY: 0.25 });
  assert.equal(kept.floorScaleY, 0.5, 'a side view that sets the keys keeps them');
  assert.equal(kept.heightScaleY, 0.25);
  // Only 0 itself: a degree off the side is the trigonometry again, the floor at its smallest scale.
  const nearSide = resolveCamera({ pitch: 1 });
  assert.equal(nearSide.floorScaleY, GROUND_SCALE_Y_MIN, 'sin(1°) is below the smallest floor scale');
  close(nearSide.heightScaleY, Math.cos(Math.PI / 180));
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
  // DX-BARRIOS: lighting.faces as a whole (its heightScaleY was DX-CAMERA's first), with where each piece went.
  assert.deepEqual(items.map((i) => i.path), ['lighting.groundScaleY', 'lighting.faces']);
  assert.match(unknownConfigKeyText('Town', items[1]), /lighting\.sun\.skyLight/);
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

/**
 * OL-4: config.lighting.walls and wallFans as the scene resolves them, for a camera, lighting on or off, the scene's
 * lighting.walls (left out when null) and its debug.lightFans (left out when undefined); with the warnings it gave
 * and its component pools.
 */
function wallsFor(camera, { enabled = true, walls = true, lightFans } = {}) {
  class Lit extends Scene {
    static entities = [[Crate, 4]];
    static config = {
      worldWidth: 2000,
      worldHeight: 2000,
      camera,
      lighting: { enabled, baseAmbient: 0.5, ...(walls === null ? {} : { walls }) },
      ...(lightFans === undefined ? {} : { debug: { lightFans } }),
    };
  }
  let scene = null;
  const lines = warningsOf(() => {
    scene = new Lit({});
  });
  const { lighting } = scene.config;
  return { walls: lighting.walls, wallFans: lighting.wallFans, lines, pools: scene.componentPools };
}

test('walls are the scene\'s to ask for (lighting.walls), with lighting on, whatever its camera', () => {
  const down = wallsFor({ pitch: 90 });
  assert.equal(down.walls, true, 'straight down');
  assert.deepEqual(down.lines, []);
  assert.ok(down.pools.LightOccluder, 'the walls\' columns are pooled');
  assert.ok(down.pools.LightEmitter, 'and the lights the sweep runs for');
  // The sweep runs on the world as the screen shows it, where sight lines are straight whatever the floor's scale.
  for (const camera of [{ pitch: 0 }, undefined, { pitch: 47 }, { pitch: 45 }, { floorScaleY: 0.7 }, { pitch: 47, floorScaleY: 0.736, heightScaleY: 0.752 }]) {
    const name = JSON.stringify(camera);
    const lit = wallsFor(camera);
    assert.equal(lit.walls, true, name);
    assert.ok(lit.pools.LightOccluder, `${name}: the columns are pooled`);
    assert.deepEqual(lit.lines, [], `${name}: nothing to warn about`);
  }
  assert.equal(wallsFor({ pitch: 120 }).walls, true, 'clamped to 90');

  const unasked = wallsFor({ pitch: 90 }, { walls: null });
  assert.equal(unasked.walls, false, 'a flat camera alone asks for no walls');
  assert.equal(unasked.pools.LightOccluder, undefined, 'and pools no columns');
  assert.deepEqual(unasked.lines, []);
  assert.equal(wallsFor({ pitch: 90 }, { walls: false }).walls, false);
  const unlit = wallsFor({ pitch: 90 }, { enabled: false });
  assert.equal(unlit.walls, false, 'no lighting, no walls');
  assert.equal(unlit.pools.LightOccluder, undefined);
  assert.deepEqual(unlit.lines, [], 'and nothing to warn about');
  assert.equal(wallsFor({ pitch: 47 }, { walls: 'yes' }).walls, false, 'true asks for them, nothing else does');
});

test('the old fan pass (lighting.wallFans) follows debug.lightFans, and only in a scene that has walls', () => {
  assert.equal(wallsFor({ pitch: 90 }, { lightFans: true }).wallFans, true, 'walls and debug.lightFans: the old pass');
  assert.equal(wallsFor({ pitch: 90 }).wallFans, false, 'walls alone: the light pass reads them');
  assert.equal(wallsFor({ pitch: 90 }, { lightFans: false }).wallFans, false);
  assert.equal(wallsFor({ pitch: 90 }, { walls: null, lightFans: true }).wallFans, false, 'no walls, no fans');
  assert.equal(wallsFor({ pitch: 90 }, { enabled: false, lightFans: true }).wallFans, false, 'no lighting, no fans');
  const tilted = wallsFor({ floorScaleY: 0.7 }, { lightFans: true });
  assert.equal(tilted.walls, true);
  assert.equal(tilted.wallFans, true, 'on a foreshortened floor too');
});

test('a scene that still writes lighting.raycasted is told it is retired, and it asks for no walls', () => {
  class Old extends Scene {
    static entities = [[Crate, 4]];
    static config = {
      worldWidth: 2000,
      worldHeight: 2000,
      camera: { pitch: 90 },
      lighting: { enabled: true, baseAmbient: 0.5, raycasted: true },
    };
  }
  let scene = null;
  const lines = warningsOf(() => {
    scene = new Old({});
  });
  assert.equal(scene.config.lighting.walls, false, 'neither the old key nor a flat camera asks for walls');
  assert.equal(scene.config.lighting.wallFans, false);
  assert.equal(scene.componentPools.LightOccluder, undefined, 'no walls\' columns');
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.match(lines[0], /^WeedJS: Old\.config\.lighting\.raycasted does nothing any more \(walls are config\.lighting\.walls now.*\)\. Remove it\.$/);
});
