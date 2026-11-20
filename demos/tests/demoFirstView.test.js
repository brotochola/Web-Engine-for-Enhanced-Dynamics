// N-166: four demos centred their first view on the middle of the world while every body lay on a floor out of view,
// so they opened on a black screen (Oriented Boxes, Constraint Boxes, Constraints) or on the empty cave (Burning
// Boxes). Each runs its real create() here (the demo loads through the web-root hook) with its floor's spawns caught,
// on a 1280 x 720 canvas at zoom 1: the floor's top edge must be in the first view, and the free camera's target where
// the view is, so its first frames do not pan back to the middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/helpers/registerWebRoot.mjs';

const W = 1280;
const H = 720;

const DEMOS = [
  { name: 'Oriented Boxes', scene: 'orientedBoxScene/orientedBoxScene.js', exportName: 'OrientedBoxScene', floor: 'ballsScene/gameObjects/floor.js', floorExport: 'Floor' },
  { name: 'Constraint Boxes', scene: 'constraintBoxScene/constraintBoxScene.js', exportName: 'ConstraintBoxScene', floor: 'ballsScene/gameObjects/floor.js', floorExport: 'Floor' },
  { name: 'Constraints', scene: 'constraintsTestScene/constraintsTestScene.js', exportName: 'ConstraintsTestScene', floor: 'ballsScene/gameObjects/floor.js', floorExport: 'Floor' },
  { name: 'Burning Boxes', scene: 'burningBoxesScene/burningBoxesScene.js', exportName: 'BurningBoxesScene', floor: 'burningBoxesScene/gameObjects/occludingFloor.js', floorExport: 'OccludingFloor' },
];

/** The scene's create() on a fresh camera, the floor class's spawns caught: the camera's view and the spawns. */
async function firstView(demo) {
  const { Camera } = await import('../../src/core/camera.js');
  const SceneClass = (await import(`../../demos/${demo.scene}`))[demo.exportName];
  const FloorClass = (await import(`../../demos/${demo.floor}`))[demo.floorExport];
  const { worldWidth, worldHeight } = SceneClass.config;
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data[0] = 1; // zoom 1, as the demos start (a zeroed buffer reads as the minimum zoom)
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(worldWidth, worldHeight);
  const spawns = [];
  const own = Object.getOwnPropertyDescriptor(FloorClass, 'spawn');
  Object.defineProperty(FloorClass, 'spawn', { value: (config) => spawns.push(config), configurable: true, writable: true });
  const saved = console.log;
  console.log = () => {};
  try {
    const scene = Object.create(SceneClass.prototype);
    scene.config = SceneClass.config;
    scene.rng = () => 0.5;
    SceneClass.prototype.create.call(scene);
  } finally {
    console.log = saved;
    if (own) Object.defineProperty(FloorClass, 'spawn', own);
    else delete FloorClass.spawn;
  }
  const top = Camera.centerY - H / (2 * Camera.zoom);
  return { Camera, spawns, top, bottom: top + H / Camera.zoom, worldHeight };
}

for (const demo of DEMOS) {
  test(`${demo.name}: the first view holds the floor its bodies land on`, async () => {
    const { Camera, spawns, top, bottom, worldHeight } = await firstView(demo);
    // The floor: the widest spawn in the world's lower half.
    const low = spawns.filter((s) => s.y > worldHeight / 2);
    assert.ok(low.length > 0, 'a floor was spawned');
    const floor = low.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
    const floorTop = floor.y - (floor.height || 0) / 2;
    assert.ok(floorTop >= top && floorTop <= bottom, `floor top ${floorTop} in the view ${top.toFixed(0)}..${bottom.toFixed(0)}`);
    assert.ok(Math.abs(Camera._freeFollowY - Camera.centerY) < 1, `free target y ${Camera._freeFollowY} at the view's centre ${Camera.centerY}`);
  });
}
