// The planet manager seeds and meshes the disk in onSpawned. The ship, lamp
// and water emitter must be spawned from the manager (after that rebuild), not
// from the scene's createNewGame(): a main-thread spawn creates the player's
// physics body before the static terrain fixtures exist, so the ship falls
// through the disk while the logic workers are still meshing it and ends up
// embedded in solid rock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sceneSrc = readFileSync(
  new URL('../../demos/planetPhysicsScene/planetPhysicsScene.js', import.meta.url),
  'utf8',
);
const managerSrc = readFileSync(
  new URL('../../demos/planetPhysicsScene/gameObjects/planetWorldGridManager.js', import.meta.url),
  'utf8',
);

test('planet scene spawns only the manager; the manager spawns the actors', () => {
  const at = sceneSrc.indexOf('createNewGame()');
  assert.notEqual(at, -1, 'createNewGame() not found');
  const block = sceneSrc.slice(at, sceneSrc.indexOf('\n  }', at) + 4);
  assert.match(block, /spawnEntity\(PlanetWorldGridManager/, 'the scene must spawn the manager');
  assert.doesNotMatch(block, /spawnEntity\(PlanetShip/, 'the ship must not spawn before the disk is meshed');
  assert.doesNotMatch(block, /spawnEntity\(PlanetLamp/);
  assert.doesNotMatch(block, /spawnEntity\(PlanetPull/);
});

test('planet manager spawns actors after the disk rebuild, guarded once', () => {
  const superAt = managerSrc.indexOf('super.onSpawned(spawnConfig);');
  const spawnAt = managerSrc.indexOf('PlanetShip.spawn(');
  assert.ok(superAt >= 0, 'onSpawned must call super.onSpawned');
  assert.ok(spawnAt > superAt, 'actors must spawn after the disk rebuild');
  assert.match(managerSrc, /if \(this\._actorsSpawned\) return;/);
  assert.match(managerSrc, /this\._actorsSpawned = false;/);
  assert.match(managerSrc, /this\._actorsSpawned = true;/);
  assert.match(managerSrc, /PlanetLamp\.spawn\(/);
  assert.match(managerSrc, /PlanetPull\.spawn\(/);
});
