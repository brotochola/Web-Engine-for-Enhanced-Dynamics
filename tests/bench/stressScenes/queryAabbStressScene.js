import WEED from '/src/index.js';
import { Box2dQueryAabbTarget } from '/demos/box2dQueryAabbScene/gameObjects/box2dQueryAabbProbe.js';
import { QueryAabbChurnProbe } from './queryAabb/queryAabbChurnProbe.js';

const { Scene, Camera } = WEED;

export class QueryAabbStressScene extends Scene {
  static config = {
    worldWidth: 3000,
    worldHeight: 3000,
    seed: 42,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { box: '/demos/img/box_100_100.png' },
  };

  static entities = [
    [Box2dQueryAabbTarget, 256],
    [QueryAabbChurnProbe, 1],
  ];

  create() {
    const cx = 1500;
    const cy = 1500;
    for (let i = 0; i < 200; i++) {
      const col = i % 20;
      const row = (i / 20) | 0;
      this.spawnEntity(Box2dQueryAabbTarget, {
        x: 900 + col * 48,
        y: 900 + row * 48,
        size: 28,
      });
    }
    this.spawnEntity(QueryAabbChurnProbe, { x: cx, y: cy });
    Camera.centerOn(cx, cy);
    Camera.setZoom(0.45);
  }
}
