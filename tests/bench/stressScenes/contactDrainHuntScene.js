import WEED from '/src/index.js';
import { ContactDrainBody } from './contactDrain/contactDrainBody.js';

const { Scene, Camera } = WEED;

/** Frozen after 8 ms hunt. Tax uses pool 65535 (u16 legal). Capacity scene uses 70000. */
export const CONTACT_DRAIN_HUNT = {
  balls: 4096,
  pool: 65535,
  world: 2800,
  seed: 0xc0a7,
};

const WORLD_W = CONTACT_DRAIN_HUNT.world;
const WORLD_H = CONTACT_DRAIN_HUNT.world;

export class ContactDrainHuntScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: CONTACT_DRAIN_HUNT.seed,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 980 },
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 5000 },
    lighting: { enabled: false },
  };

  static assets = { textures: { ball: '/demos/img/bola.png' } };

  static entities = [[ContactDrainBody, CONTACT_DRAIN_HUNT.pool]];

  create() {
    let a = CONTACT_DRAIN_HUNT.seed >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    this.spawnEntity(ContactDrainBody, {
      x: WORLD_W * 0.5,
      y: WORLD_H - 24,
      shape: 'box',
      width: WORLD_W - 80,
      height: 48,
      isStatic: true,
    });
    this.spawnEntity(ContactDrainBody, {
      x: 24,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: 48,
      height: WORLD_H,
      isStatic: true,
    });
    this.spawnEntity(ContactDrainBody, {
      x: WORLD_W - 24,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: 48,
      height: WORLD_H,
      isStatic: true,
    });

    const cx = WORLD_W * 0.5;
    const pileTop = 160;
    const cols = 32;
    for (let i = 0; i < CONTACT_DRAIN_HUNT.balls; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(ContactDrainBody, {
        x: cx - 240 + col * 16 + rng() * 4,
        y: pileTop + row * 12 + rng() * 4,
        radius: 7 + rng() * 3,
        shape: 'circle',
        isStatic: false,
      });
    }

    Camera.centerOn(cx, WORLD_H * 0.62);
    Camera.setZoom(0.4);
  }
}

export class ContactDrainHunt32Scene extends ContactDrainHuntScene {
  static config = { ...ContactDrainHuntScene.config, entityIdWidth: 32 };
}

/** Raised after 8 ms hunt on width 32 (4096 balls → logic0 5.75 ms). */
export const CONTACT_DRAIN_BEST32 = {
  balls: 5300,
  pool: 65535,
  world: 2800,
  seed: 0xc0a7,
};

export class ContactDrainBest32Scene extends ContactDrainHuntScene {
  static config = { ...ContactDrainHuntScene.config, entityIdWidth: 32 };
  static entities = [[ContactDrainBody, CONTACT_DRAIN_BEST32.pool]];

  create() {
    const WORLD_W = CONTACT_DRAIN_BEST32.world;
    const WORLD_H = CONTACT_DRAIN_BEST32.world;
    let a = CONTACT_DRAIN_BEST32.seed >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    this.spawnEntity(ContactDrainBody, {
      x: WORLD_W * 0.5,
      y: WORLD_H - 24,
      shape: 'box',
      width: WORLD_W - 80,
      height: 48,
      isStatic: true,
    });
    this.spawnEntity(ContactDrainBody, {
      x: 24,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: 48,
      height: WORLD_H,
      isStatic: true,
    });
    this.spawnEntity(ContactDrainBody, {
      x: WORLD_W - 24,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: 48,
      height: WORLD_H,
      isStatic: true,
    });

    const cx = WORLD_W * 0.5;
    const pileTop = 120;
    const cols = 40;
    for (let i = 0; i < CONTACT_DRAIN_BEST32.balls; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(ContactDrainBody, {
        x: cx - 320 + col * 16 + rng() * 4,
        y: pileTop + row * 11 + rng() * 4,
        radius: 6 + rng() * 3,
        shape: 'circle',
        isStatic: false,
      });
    }

    Camera.centerOn(cx, WORLD_H * 0.62);
    Camera.setZoom(0.35);
  }
}

export class ContactDrainCap32Scene extends ContactDrainHuntScene {
  static config = { ...ContactDrainHuntScene.config, entityIdWidth: 32 };
  static entities = [[ContactDrainBody, 70000]];
}
