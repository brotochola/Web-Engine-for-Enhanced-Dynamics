import WEED from '/src/index.js';
import { ComputeStressBox } from './compute/computeStressBox.js';

const { Scene, Camera } = WEED;

const BOX_COUNT = 64;
const SEED = 0xce11;
const TEX = 256;

/**
 * L2 compute stress: 256² ping-pong storage, 20 iterate+swap, 64 fed boxes.
 * Isolates bind-group / dispatch cost. Not a lattice; no fire shaders.
 */
export class ComputeStressScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 1500,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      maxEntitiesPerCell: 64,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
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
      backend: 'webgpu',
      noLimitFPS: false,
      maxVisibleRenderables: 256,
    },
    lighting: {
      enabled: false,
    },
    layers: {
      sim: {
        zIndex: 2.5,
        maxItems: 0,
        shader: {
          fragment: 'computeStressLook',
          compute: {
            source: 'computeStressSim',
            size: { width: TEX, height: TEX },
            passes: [
              { entry: 'jacobi', source: 'computeStressSim', iterate: 20, swap: ['t'] },
            ],
            textures: [
              { name: 't', format: 'rgba8unorm', pingPong: true, look: true },
            ],
          },
          maxBodies: 64,
        },
      },
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
    shaders: {
      computeStressLook: '/tests/bench/stressScenes/compute/computeStressLook.wgsl',
      computeStressSim: '/tests/bench/stressScenes/compute/computeStressSim.wgsl',
    },
  };

  static entities = [[ComputeStressBox, BOX_COUNT]];

  create() {
    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const margin = 80;
    const worldW = this.config.worldWidth;
    const worldH = this.config.worldHeight;
    for (let i = 0; i < BOX_COUNT; i++) {
      this.spawnEntity(ComputeStressBox, {
        x: margin + rng() * (worldW - 2 * margin),
        y: margin + rng() * (worldH - 2 * margin),
        width: 16 + rng() * 24,
        height: 16 + rng() * 24,
      });
    }
    Camera.x = 400;
    Camera.y = 300;
  }
}
