// The planet manager seeds and meshes the disk in onSpawned. The ship, lamp
// and water emitter must be spawned from the manager (after that rebuild), not
// from the scene's createNewGame(): a main-thread spawn creates the player's
// physics body before the static terrain fixtures exist, so the ship falls
// through the disk while the logic workers are still meshing it and ends up
// embedded in solid rock.
//
// Runs the demo's own methods (loaded through the web-root hook, review M8);
// these used to be regexes over the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/helpers/registerWebRoot.mjs';

const { PlanetPhysicsScene } = await import('../../demos/planetPhysicsScene/planetPhysicsScene.js');
const { PlanetWorldGridManager } = await import('../../demos/planetPhysicsScene/gameObjects/planetWorldGridManager.js');
const { WorldGridManager } = await import('../../demos/destructibleTerrainScene/gameObjects/worldGridManager.js');
const { PlanetShip } = await import('../../demos/planetPhysicsScene/gameObjects/planetShip.js');
const { PlanetLamp } = await import('../../demos/planetPhysicsScene/gameObjects/planetLamp.js');
const { PlanetPull } = await import('../../demos/planetPhysicsScene/gameObjects/planetPull.js');

/** Replace static members for the length of fn, then put them back. */
async function withStatics(patches, fn) {
  const saved = patches.map(([obj, key]) => [obj, key, Object.getOwnPropertyDescriptor(obj, key)]);
  try {
    for (const [obj, key, value] of patches) Object.defineProperty(obj, key, { value, configurable: true, writable: true });
    return await fn();
  } finally {
    for (const [obj, key, desc] of saved) {
      if (desc) Object.defineProperty(obj, key, desc);
      else delete obj[key];
    }
  }
}

test('createNewGame spawns only the manager', () => {
  const spawned = [];
  PlanetPhysicsScene.prototype.createNewGame.call({
    spawnEntity: (Cls) => spawned.push(Cls.name),
  });
  assert.deepEqual(spawned, ['PlanetWorldGridManager']);
});

test('onSpawned builds the disk and spawns no actor', async () => {
  const spawns = [];
  const rec = (name) => (cfg) => spawns.push(name);
  await withStatics(
    [
      [WorldGridManager.prototype, 'onSpawned', function () {}],
      [PlanetShip, 'spawn', rec('ship')],
      [PlanetLamp, 'spawn', rec('lamp')],
      [PlanetPull, 'spawn', rec('pull')],
    ],
    () => PlanetWorldGridManager.prototype.onSpawned.call({}, { resume: false }),
  );
  assert.deepEqual(spawns, []);
});

test('the actors spawn once, after the delay, from tick', async () => {
  const spawns = [];
  const rec = (name) => () => spawns.push(name);
  const manager = { _actorsSpawned: false, _actorDelay: 2, _benchRemesh: false, _resume: false };
  await withStatics(
    [
      [PlanetShip, 'spawn', rec('ship')],
      [PlanetLamp, 'spawn', rec('lamp')],
      [PlanetPull, 'spawn', rec('pull')],
      [PlanetLamp, 'getAllActive', () => []],
      [PlanetPull, 'getAllActive', () => []],
    ],
    () => {
      const step = () => PlanetWorldGridManager.prototype._spawnActors.call(manager);
      step();
      assert.deepEqual(spawns, [], 'still inside the delay');
      step();
      assert.deepEqual(spawns, ['ship', 'lamp', 'pull']);
      step();
      step();
      assert.deepEqual(spawns, ['ship', 'lamp', 'pull'], 'guarded once');
    },
  );
});
