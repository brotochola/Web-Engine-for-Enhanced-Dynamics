// Planet variant of the destructible-terrain manager. Same grid, chunks,
// extraction, meshing, retarget and tools. The only differences are gravity
// (loose chunks are pulled toward the planet core each logic tick instead of
// falling down a world gravity well) and actor spawn timing: the ship, lamp and
// water emitter are spawned here, after the initial disk rebuild, so their
// bodies are created after the static terrain fixtures. Spawning them from the
// scene at boot let the ship fall through the terrain while the logic workers
// were still building the fixtures.

import { WorldGridManager } from '/demos/destructibleTerrainScene/gameObjects/worldGridManager.js';
import { PlanetShip } from './planetShip.js';
import { PlanetLamp } from './planetLamp.js';
import { PlanetPull } from './planetPull.js';
import { CX, CY, G, RADIUS, CELL } from '../planetGravity.js';
import WEED from '/src/index.js';

const { Transform, RigidBody } = WEED;

const SURFACE_Y = CY - RADIUS * CELL;
const ACTOR_SPAWN_DELAY = 2;

export class PlanetWorldGridManager extends WorldGridManager {
  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    this._benchRemesh = !!spawnConfig.benchRemesh;
    this._actorsSpawned = false;
    this._actorDelay = ACTOR_SPAWN_DELAY;
  }

  tick(dtRatio, deltaTime, accumulatedTime) {
    super.tick(dtRatio, deltaTime, accumulatedTime);
    this._pullLooseIslands();
    this._spawnActors();
  }

  _pullLooseIslands() {
    const list = this.dynamicIslands;
    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      if (!Transform.active?.[idx] || RigidBody.static[idx]) continue;
      const dx = CX - Transform.x[idx];
      const dy = CY - Transform.y[idx];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      RigidBody.ax[idx] = (dx / len) * G;
      RigidBody.ay[idx] = (dy / len) * G;
    }
  }

  _spawnActors() {
    if (this._actorsSpawned) return;
    if (--this._actorDelay > 0) return;
    this._actorsSpawned = true;
    PlanetShip.spawn({
      x: CX,
      y: SURFACE_Y - 120,
      forceProcessOnLogicWorker: 0,
      benchRemesh: this._benchRemesh,
    });
    PlanetLamp.spawn({
      x: CX + 90,
      y: SURFACE_Y - 60,
      forceProcessOnLogicWorker: 0,
    });
    PlanetPull.spawn({ forceProcessOnLogicWorker: 0 });
  }
}
