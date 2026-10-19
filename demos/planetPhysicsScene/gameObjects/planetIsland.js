// Loose chunk of the Box2D planet. Same mesh as the terrain demo, pulled toward the core.

import { TerrainIsland } from './terrainIsland.js';
import { WorldGrid } from '../worldGrid.js';
import WEED from '/src/index.js';

const { RigidBody } = WEED;

export class PlanetIsland extends TerrainIsland {
  tick() {
    const g = WorldGrid.gravityCenter;
    if (!g || this.rigidBody.static) return;
    const i = this.index;
    const dx = g.x - this.x;
    const dy = g.y - this.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    RigidBody.ax[i] = (dx / len) * g.g;
    RigidBody.ay[i] = (dy / len) * g.g;
  }
}

/** Broken-off chunk. Cells are already cleared, so the body itself is the save. */
export class LooseIsland extends PlanetIsland {
  static serializable = true;
}
