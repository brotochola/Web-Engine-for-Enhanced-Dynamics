import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { swapModule, hotModuleUrl } from '../../src/core/debug/hotSwap.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Component } from '../../src/core/component.js';

// Hot reload used to reload the page (save, F5, load). A game script now swaps
// in place: the running classes get the new code, the shared memory and the
// instances stay. These pin what may swap, what forces a reload, and that the
// new module's classes stand for the running ones.

/** A module's classes as a fresh evaluation would build them. */
function version({ speed = 3, tickBody = 'return 1;', components = '[Health]', extra = '', schema = '{ hp: Float32Array }' } = {}) {
  return new Function('GameObject', 'Component', `
    class Health extends Component { static ARRAY_SCHEMA = ${schema}; }
    class Base extends GameObject { label() { return 'base'; } }
    class Boid extends Base {
      static components = ${components};
      static SPEED = ${speed};
      tick() { ${tickBody} }
      label() { return 'boid:' + super.label(); }
      static make() { return 'made'; }
      ${extra}
    }
    class FlockScene { static entities = [[Boid, 4]]; static config = { worldWidth: 100 }; }
    return { FlockScene, Boid, Health };
  `)(GameObject, Component);
}

/** Registration as the engine does it: pool statics, component views, accessors. */
function register(ns) {
  const { Boid, Health } = ns;
  Object.assign(Boid, { entityType: 3, startIndex: 10, poolSize: 4, instances: [], _activeList: new Uint16Array(5), _componentClassMap: { health: Health } });
  Object.defineProperty(Boid.prototype, 'health', { get: () => 'accessor', configurable: true });
  Boid.prototype._componentAccessorsCreated = true;
  Health.hp = new Float32Array(16);
  Boid.instances.push(Object.create(Boid.prototype));
  return ns;
}

test('a swap gives running instances the new code, keeps the engine’s statics and accessors', () => {
  const live = register(version({ extra: 'helper() { return "old"; }' }));
  const instance = live.Boid.instances[0];
  const fresh = version({ speed: 5, tickBody: 'return 2;' });

  const result = swapModule({ FlockScene: live.FlockScene }, { FlockScene: fresh.FlockScene });
  assert.equal(result.reload, null);
  assert.deepEqual(result.swapped.sort(), ['Base', 'Boid', 'FlockScene', 'Health']);
  assert.equal(instance.tick(), 2, 'the pooled instance runs the new tick');
  assert.equal(instance.label(), 'boid:base', 'super still resolves');
  assert.equal(instance.helper, undefined, 'a method the new code dropped is gone');
  assert.equal(instance.health, 'accessor', 'component accessors stay');
  assert.equal(live.Boid.SPEED, 5, 'a changed static constant applies');
  assert.equal(live.Boid.make(), 'made');
  assert.equal(live.Boid.startIndex, 10, 'pool statics stay');

  // New code that names its own module's classes reaches the running ones.
  assert.equal(fresh.Boid.startIndex, 10);
  assert.equal(fresh.Boid.instances, live.Boid.instances);
  assert.equal(fresh.Boid._activeList, live.Boid._activeList);
  assert.equal(fresh.Health.hp, live.Health.hp, 'component views are shared');
  assert.ok(instance instanceof fresh.Boid);
  assert.ok(live.Boid.prototype instanceof Object.getPrototypeOf(fresh.Boid), 'subclass checks through the new base class');
});

test('what the engine built from a class’s shape asks for a reload, and nothing is patched', () => {
  const cases = [
    [{ components: '[]' }, /Boid.components changed/],
    [{ schema: '{ hp: Float32Array, armor: Float32Array }' }, /Health.ARRAY_SCHEMA changed/],
    [{ extra: 'onMessage() {}' }, /onMessage\(\) was added/],
    [{ extra: 'static tickInterval = 4;' }, /Boid.tickInterval changed/],
  ];
  for (const [change, why] of cases) {
    const live = register(version());
    const result = swapModule({ FlockScene: live.FlockScene }, { FlockScene: version(change).FlockScene });
    assert.match(String(result.reload), why);
    assert.deepEqual(result.swapped, []);
    assert.equal(live.Boid.instances[0].tick(), 1, 'nothing patched');
  }
  const live = register(version());
  const bigger = version();
  bigger.FlockScene.entities = [[bigger.Boid, 8]];
  assert.match(String(swapModule({ FlockScene: live.FlockScene }, { FlockScene: bigger.FlockScene }).reload), /entities changed/);
});

test('exports that are not classes swap only when unchanged', () => {
  const same = function helper(a) { return a + 1; };
  const sameAgain = function helper(a) { return a + 1; };
  const other = function helper(a) { return a + 2; };
  assert.equal(swapModule({ helper: same, LIMIT: 3 }, { helper: sameAgain, LIMIT: 3 }).reload, null);
  assert.match(swapModule({ helper: same }, { helper: other }).reload, /helper is not a class and changed/);
  assert.match(swapModule({ LIMIT: 3 }, { LIMIT: 4 }).reload, /LIMIT changed/);
  assert.match(swapModule({}, { NEW: 1 }).reload, /NEW was added/);
});

test('bundled workers swap a one-file scene evaluated twice', async () => {
  const { evaluateBlobModule } = await import('../../src/util/utils.js');
  const { WORKER_WEED } = await import('../../src/workers/workerWeed.js');
  const source = (speed) => `const { Scene, GameObject } = WEED;
class Ant extends GameObject {
  tick() { return ${speed}; }
}
export class AntScene extends Scene {
  static entities = [[Ant, 2]];
}
`;
  const context = { WEED: WORKER_WEED };
  const live = evaluateBlobModule(source(1), 'http://x/ant.js', context);
  const Ant = live.AntScene.entities[0][0];
  Ant.instances = [Object.create(Ant.prototype)];
  const fresh = evaluateBlobModule(source(7), 'http://x/ant.js', context);
  const result = swapModule(live, fresh);
  assert.equal(result.reload, null);
  assert.equal(Ant.instances[0].tick(), 7);
});

test('a logic worker swaps a module it imported and answers what it swapped', async () => {
  const { loadWorker } = await import('../bench/workerHarness.mjs');
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-swap-'));
  const file = path.join(dir, 'ship.js');
  const gameObjectUrl = pathToFileURL(path.resolve('src/core/gameObject.js')).href;
  const write = (n) => fs.writeFileSync(file, `import { GameObject } from '${gameObjectUrl}';\nexport class Ship extends GameObject { tick() { return ${n}; } }\n`);
  try {
    write(1);
    const url = pathToFileURL(file).href;
    const { Ship } = await import(url);
    const ship = Object.create(Ship.prototype);
    write(2);
    const result = await worker.hotSwap({ url, version: 1 });
    assert.deepEqual(result, { swapped: ['Ship'], reload: null });
    assert.equal(ship.tick(), 2);
    assert.equal(hotModuleUrl(url, 1), `${url}?weedHot=1`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
