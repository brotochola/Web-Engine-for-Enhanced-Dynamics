import WEED from '/src/index.js';
import { RayStressDriver } from './ray/rayStressDriver.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { RayStressBusyBall } from './ray/rayStressBusyBall.js';

const { Scene, Camera } = WEED;

const OBSTACLE_COUNT = 2000;
const BUSY_BALL_COUNT = 800;
const SEED = 0xc0ffee;

/**
 * Shared L2 Ray vs Box2D stress scene.
 * Subclasses set static backend ('weedjs'|'box2d') and static physicsLoad ('idle'|'busy').
 */
export class RayVsBox2dStressScene extends Scene {
  static backend = 'weedjs';
  static physicsLoad = 'idle';

  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 4000,
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
    [RayStressDriver, 1],
    [RayStressEntity, OBSTACLE_COUNT],
    [RayStressBusyBall, BUSY_BALL_COUNT],
  ];

  create() {
    const backend = this.constructor.backend === 'box2d' ? 'box2d' : 'weedjs';
    const busy = this.constructor.physicsLoad === 'busy';

    if (busy) {
      this.config.physics.gravity = { x: 0, y: 980 };
    }

    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const margin = 64;
    const worldW = this.config.worldWidth;
    const worldH = this.config.worldHeight;

    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      const isBox = rng() >= 0.7;
      this.spawnEntity(RayStressEntity, {
        x: margin + rng() * (worldW - 2 * margin),
        y: margin + rng() * (worldH - 2 * margin),
        shape: isBox ? 'box' : 'circle',
        radius: 4 + rng() * 16,
        width: 8 + rng() * 32,
        height: 8 + rng() * 32,
        collisionLayer: (rng() * 6) | 0,
      });
    }

    if (busy) {
      // Floor strip so the pile stays awake/colliding.
      this.spawnEntity(RayStressEntity, {
        x: worldW * 0.5,
        y: worldH - 40,
        shape: 'box',
        width: worldW - 80,
        height: 40,
        collisionLayer: 0,
      });
      for (let i = 0; i < BUSY_BALL_COUNT; i++) {
        this.spawnEntity(RayStressBusyBall, {
          x: margin + 200 + rng() * (worldW - 2 * margin - 400),
          y: margin + rng() * (worldH * 0.55),
          radius: 6 + rng() * 10,
        });
      }
    }

    this.spawnEntity(RayStressDriver, { seed: SEED, backend });

    Camera.centerOn(worldW * 0.5, worldH * 0.5);
    Camera.setZoom(0.45);
  }
}

export class RayVsBox2dWeedIdleScene extends RayVsBox2dStressScene {
  static backend = 'weedjs';
  static physicsLoad = 'idle';
}

export class RayVsBox2dWeedBusyScene extends RayVsBox2dStressScene {
  static backend = 'weedjs';
  static physicsLoad = 'busy';
}

export class RayVsBox2dBoxIdleScene extends RayVsBox2dStressScene {
  static backend = 'box2d';
  static physicsLoad = 'idle';
}

export class RayVsBox2dBoxBusyScene extends RayVsBox2dStressScene {
  static backend = 'box2d';
  static physicsLoad = 'busy';
}
