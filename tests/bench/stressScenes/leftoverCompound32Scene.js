import WEED from '/src/index.js';
import {
  CompoundFixtureSpatialScene,
  ISLAND_COUNT,
  TRIANGLES_PER_ISLAND,
  WORLD_W,
  WORLD_H,
} from './compoundFixtureSpatialScene.js';
import { CompoundSpatialIsland } from './compoundFixture/compoundSpatialIsland.js';

const { Camera } = WEED;

/** Same 6000 islands (fixture pool cap). Tighter grid + longer range to close ≥8 ms spatial. */
export const LEFTOVER_COMPOUND32 = {
  spacing: 85,
  visualRange: 360,
};

export class LeftoverCompound32Scene extends CompoundFixtureSpatialScene {
  static config = { ...CompoundFixtureSpatialScene.config, entityIdWidth: 32 };

  create() {
    const cols = 80;
    const { spacing, visualRange } = LEFTOVER_COMPOUND32;
    const startX = 400;
    const startY = 400;
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(CompoundSpatialIsland, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        rotation: (i * 0.17) % (Math.PI * 2),
        triangles: TRIANGLES_PER_ISLAND,
        visualRange,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.28);
  }
}
