import WEED from '/src/index.js';
import { QueryChurnTag } from '../components/queryChurnTag.js';
import { QueryChurnDriver } from '../gameObjects/queryChurnDriver.js';
import { QueryChurnEntity } from '../gameObjects/queryChurnEntity.js';

const { Scene, Camera, SpriteRenderer } = WEED;

export class QueryChurnScene extends Scene {
  static config = {
    worldWidth: 4500,
    worldHeight: 3500,
    seed: 515151,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 256,
      maxEntitiesPerCell: 96,
      noLimitFPS: true,
    },
    logic: {
      noLimitFPS: true,
      numberOfLogicWorkers: 1,
      staggeredUpdates: true,
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
      maxVisibleRenderables: 10000,
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

  static entities = [
    [QueryChurnDriver, 1],
    [QueryChurnEntity, 4096],
  ];

  static queries = [[QueryChurnTag, SpriteRenderer]];

  create() {
    this.spawnEntity(QueryChurnDriver, {});

    for (let i = 0; i < 2048; i++) {
      const col = i % 96;
      const row = (i / 96) | 0;
      this.spawnEntity(QueryChurnEntity, {
        x: 250 + col * 42,
        y: 250 + row * 42,
      });
    }

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.5);
  }
}
