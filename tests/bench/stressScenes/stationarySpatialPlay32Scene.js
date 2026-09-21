import WEED from '/src/index.js';
import { StationarySpatialEntity } from './stationary/stationarySpatialEntity.js';

const { Scene, Camera } = WEED;

/** Play-scale spatial with entityIdWidth 32. N is first-class even though it fits in 16 bits. */
export const STATIONARY_PLAY32 = {
  n: 30000,
  cols: 180,
  spacing: 45,
  visualRange: 170,
  radius: 10,
};

const world = Math.ceil(STATIONARY_PLAY32.cols * STATIONARY_PLAY32.spacing + 800);

export class StationarySpatialPlay32Scene extends Scene {
  static config = {
    worldWidth: world,
    worldHeight: world,
    seed: 424242,
    entityIdWidth: 32,
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

  static entities = [[StationarySpatialEntity, STATIONARY_PLAY32.n]];

  create() {
    const { n, cols, spacing, radius, visualRange } = STATIONARY_PLAY32;
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
    Camera.setZoom(0.22);
  }
}
