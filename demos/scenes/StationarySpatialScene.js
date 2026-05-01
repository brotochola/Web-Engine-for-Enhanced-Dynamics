import WEED from '/src/index.js';
import { StationarySpatialEntity } from '../gameObjects/stationarySpatialEntity.js';

const { Scene, Camera } = WEED;

export class StationarySpatialScene extends Scene {
  static config = {
    worldWidth: 5000,
    worldHeight: 5000,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 128,
      noLimitFPS: true,
    },
    logic: {
      noLimitFPS: true,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: true,
      maxCollisionPairs: 1,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      noLimitFPS: true,
      maxVisibleRenderables: 20000,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  static entities = [[StationarySpatialEntity, 9000]];

  create() {
    const cols = 100;
    const spacing = 45;
    const startX = 300;
    const startY = 300;

    for (let i = 0; i < 9000; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(StationarySpatialEntity, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        radius: 10,
        visualRange: 170,
      });
    }

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.45);
  }
}
