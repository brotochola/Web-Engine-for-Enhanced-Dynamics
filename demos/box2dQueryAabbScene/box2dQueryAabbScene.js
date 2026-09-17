import WEED from '/src/index.js';
import {
  Box2dQueryAabbProbe,
  Box2dQueryAabbTarget,
} from './gameObjects/box2dQueryAabbProbe.js';

const { Scene, Camera } = WEED;

/**
 * Minimal scene: 3 static boxes + probe that runs sync Box2d.queryAABB once.
 * Open in demos and check console / scene message for ok=true.
 */
export class Box2dQueryAabbScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    seed: 1,
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
    textures: {
      box: '/demos/img/box_100_100.png',
    },
  };

  static entities = [
    [Box2dQueryAabbTarget, 8],
    [Box2dQueryAabbProbe, 1],
  ];

  create() {
    const cx = 1000;
    const cy = 1000;
    this.spawnEntity(Box2dQueryAabbTarget, { x: cx - 40, y: cy, size: 40 });
    this.spawnEntity(Box2dQueryAabbTarget, { x: cx + 40, y: cy, size: 40 });
    this.spawnEntity(Box2dQueryAabbTarget, { x: cx, y: cy - 40, size: 40 });
    // Probe + 3 targets in AABB → expectedMin 4
    this.spawnEntity(Box2dQueryAabbProbe, {
      x: cx,
      y: cy,
      expectedMin: 4,
    });
    Camera.centerOn(cx, cy);
    Camera.setZoom(1);
  }

  onMessageFromGameObject(data) {
    if (data?.type === 'box2dQueryAabbSelfCheck') {
      console.log('[Box2dQueryAabbScene] self-check', data);
      this._queryAabbSelfCheck = data;
    }
  }
}
