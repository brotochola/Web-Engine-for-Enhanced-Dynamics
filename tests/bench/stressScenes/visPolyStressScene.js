import WEED from '/src/index.js';
import { VisPolyLight } from './visPoly/visPolyLight.js';
import { VisPolyOccluder } from './visPoly/visPolyOccluder.js';

const { Scene, Camera } = WEED;

const SEED = 0x51f01;
const LIGHTS = 8;
const OCCLUDERS = 48;

/** Bench scene: raycasted lights + occluders. Predator default leaves this path off. */
export class VisPolyStressScene extends Scene {
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
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 4000 },
    lighting: {
      enabled: true,
      baseAmbient: 0.2,
      maxLights: 20,
      shadowsEnabled: true,
      raycasted: true,
      maxPolygonVertices: 5000,
    },
  };

  static entities = [
    [VisPolyLight, LIGHTS],
    [VisPolyOccluder, OCCLUDERS],
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
    for (let i = 0; i < LIGHTS; i++) {
      this.spawnEntity(VisPolyLight, {
        x: 400 + rng() * (w - 800),
        y: 400 + rng() * (h - 800),
      });
    }
    for (let i = 0; i < OCCLUDERS; i++) {
      this.spawnEntity(VisPolyOccluder, {
        x: 80 + rng() * (w - 160),
        y: 80 + rng() * (h - 160),
        width: 32 + rng() * 48,
        height: 32 + rng() * 48,
      });
    }
    Camera.centerOn(w * 0.5, h * 0.5);
    Camera.setZoom(0.35);
  }
}
