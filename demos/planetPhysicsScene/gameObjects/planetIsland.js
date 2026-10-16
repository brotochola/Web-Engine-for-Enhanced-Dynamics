// Loose chunk of the Box2D planet. Same mesh as the terrain demo, pulled toward the core.

import { TerrainIsland } from '../../destructibleTerrainScene/gameObjects/terrainIsland.js';
import { WorldGrid } from '../../destructibleTerrainScene/worldGrid.js';
import WEED from '/src/index.js';

const { RigidBody } = WEED;

export class PlanetIsland extends TerrainIsland {
  tick() {
    const g = WorldGrid.gravityCenter;
    if (!g || this.rigidBody.static) return;
    const i = this.index;
    const dx = g.x - this.x;
    const dy = g.y - this.y;
    const len = Math.hypot(dx, dy) || 1;
    RigidBody.ax[i] = (dx / len) * g.g;
    RigidBody.ay[i] = (dy / len) * g.g;
  }
}
