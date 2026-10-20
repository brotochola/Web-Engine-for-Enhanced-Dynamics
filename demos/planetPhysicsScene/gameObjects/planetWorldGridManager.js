// Planet variant of the destructible-terrain manager. Same grid, chunks,
// extraction, meshing, retarget and tools. The only differences are gravity
// (loose chunks are pulled toward the planet core each logic tick instead of
// falling down a world gravity well) and actor spawn timing: the ship, lamp and
// water emitter are spawned here, after the initial disk rebuild, so their
// bodies are created after the static terrain fixtures. Spawning them from the
// scene at boot let the ship fall through the terrain while the logic workers
// were still building the fixtures.

import { WorldGridManager } from '/demos/destructibleTerrainScene/gameObjects/worldGridManager.js';
import { TerrainIsland } from '/demos/destructibleTerrainScene/gameObjects/terrainIsland.js';
import { PlanetShip } from './planetShip.js';
import { PlanetLamp } from './planetLamp.js';
import { PlanetPull } from './planetPull.js';
import { CX, CY, G, RADIUS, CELL, SHIP_SPAWN_X, SHIP_SPAWN_Y } from '../planetGravity.js';
import WEED from '/src/index.js';

const { Transform, RigidBody } = WEED;

const SURFACE_Y = CY - RADIUS * CELL;
const ACTOR_SPAWN_DELAY = 2;

function hasActive(EntityClass) {
  const active = EntityClass.getAllActive();
  return !!(active && active.length);
}

export class PlanetWorldGridManager extends WorldGridManager {
  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    this._benchRemesh = !!spawnConfig.benchRemesh;
    this._resume = !!spawnConfig.resume;
    this._actorsSpawned = false;
    this._actorDelay = ACTOR_SPAWN_DELAY;
  }

  tick(dtRatio, deltaTime, accumulatedTime) {
    super.tick(dtRatio, deltaTime, accumulatedTime);
    this._pullLooseIslands();
    this._spawnActors();
  }

  // Every loose piece, however it was made (melt-off, laser split, shatter shard).
  // World gravity is 0 here, so a piece this misses hovers forever.
  _pullLooseIslands() {
    const list = TerrainIsland.getAllActive();
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      if (RigidBody.static[idx]) continue;
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
      x: SHIP_SPAWN_X,
      y: SHIP_SPAWN_Y,
      forceProcessOnLogicWorker: 0,
      benchRemesh: this._benchRemesh,
    });
    // A loaded save already restored the lamp (serializable) and the LiquidFun water.
    if (!this._resume || !hasActive(PlanetLamp)) {
      PlanetLamp.spawn({
        x: CX + 90,
        y: SURFACE_Y - 60,
        forceProcessOnLogicWorker: 0,
      });
    }
    if (!hasActive(PlanetPull)) {
      PlanetPull.spawn({ forceProcessOnLogicWorker: 0, poured: this._resume });
    }
  }
}
