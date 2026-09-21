import WEED from '/src/index.js';
import { StationarySpatialEntity } from './stationary/stationarySpatialEntity.js';

const { Scene, Camera } = WEED;

/** Frozen after 8 ms hunt. Same density as catalog Stationary. */
export const STATIONARY_HUNT = {
  n: 22000,
  cols: 160,
  spacing: 45,
  visualRange: 170,
  radius: 10,
};

const world = Math.ceil(STATIONARY_HUNT.cols * STATIONARY_HUNT.spacing + 800);

export class StationarySpatialHuntScene extends Scene {
  static config = {
    worldWidth: world,
    worldHeight: world,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 128,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 8000 },
    lighting: { enabled: false },
  };

  static assets = { textures: { ball: '/demos/img/bola.png' } };

  static entities = [[StationarySpatialEntity, STATIONARY_HUNT.n]];

  create() {
    const { n, cols, spacing, radius, visualRange } = STATIONARY_HUNT;
    const startX = 300;
    const startY = 300;
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(StationarySpatialEntity, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        radius,
        visualRange,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.28);
  }
}

export class StationarySpatialHunt32Scene extends StationarySpatialHuntScene {
  static config = { ...StationarySpatialHuntScene.config, entityIdWidth: 32 };
}
