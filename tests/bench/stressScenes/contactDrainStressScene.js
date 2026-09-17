import WEED from '/src/index.js';
import { ContactDrainBody } from './contactDrain/contactDrainBody.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0a7;
const BALLS = 256;
const WORLD_W = 1400;
const WORLD_H = 1400;

/** Seeded overlapping pile with CollisionListener so logic0 drains begin/stay/end every tick. */
export class ContactDrainStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
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
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };

  static entities = [[ContactDrainBody, BALLS + 3]];

  create() {
    let a = SEED >>> 0;
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
    const pileTop = 180;
    for (let i = 0; i < BALLS; i++) {
      const col = i % 16;
      const row = (i / 16) | 0;
      this.spawnEntity(ContactDrainBody, {
        x: cx - 120 + col * 16 + rng() * 4,
        y: pileTop + row * 14 + rng() * 4,
        radius: 8 + rng() * 4,
        shape: 'circle',
        isStatic: false,
      });
    }

    Camera.centerOn(cx, WORLD_H * 0.62);
    Camera.setZoom(0.55);
  }
}
