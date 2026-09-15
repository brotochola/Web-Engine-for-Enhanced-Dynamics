import WEED from '/src/index.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { SteadyEmitter } from './steadyCombat/steadyEmitter.js';
import { SteadyMover } from './steadyCombat/steadyMover.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0a7;
const BOXES = 180;
const MOVERS = 24;
const EMITTERS = 6;

/** Fixed bodies + constant emit. Load should stay inside ±5% without Predator combat RNG. */
export class SteadyCombatScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 800 } },
    particle: { maxParticles: 8000, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 8000 },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };

  static entities = [
    [RayStressEntity, BOXES],
    [SteadyMover, MOVERS],
    [SteadyEmitter, EMITTERS],
  ];

  create() {
    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    for (let i = 0; i < BOXES; i++) {
      this.spawnEntity(RayStressEntity, {
        x: 80 + rng() * (w - 160),
        y: 80 + rng() * (h - 160),
        shape: 'box',
        width: 20 + rng() * 28,
        height: 20 + rng() * 28,
      });
    }
    for (let i = 0; i < MOVERS; i++) {
      this.spawnEntity(SteadyMover, {
        x: 200 + rng() * (w - 400),
        y: 200 + rng() * (h - 400),
        vx: (rng() - 0.5) * 120,
        vy: (rng() - 0.5) * 120,
      });
    }
    for (let i = 0; i < EMITTERS; i++) {
      this.spawnEntity(SteadyEmitter, {
        x: 400 + (i * (w - 800)) / Math.max(1, EMITTERS - 1),
        y: 400,
        count: 20,
      });
    }
    Camera.centerOn(w * 0.5, h * 0.5);
    Camera.setZoom(0.28);
  }
}
