import WEED from '/src/index.js';
import { NavStressAgent } from './navStress/navStressAgent.js';

const { Scene, Camera } = WEED;

/** `?agents=N`: the load knob (default 256, laid out as before); more agents go on a wider square grid. */
const AGENTS = (() => {
  const n = Number(WEED.params?.get('agents'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 256;
})();
const AGENT_COLS = AGENTS <= 256 ? 8 : Math.ceil(Math.sqrt(AGENTS));
const AGENT_SPACING = AGENTS <= 256 ? 40 : Math.min(40, 1880 / AGENT_COLS);

export class NavStressScene extends Scene {
  static config = {
    worldWidth: 2048,
    worldHeight: 2048,
    seed: 777,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    navigation: {
      enabled: true,
      cellSize: 32,
      maxFlowfields: 64,
      maxPaths: 64,
      maxProcessingMsPerFrame: 8,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static entities = [[NavStressAgent, AGENTS]];

  create() {
    const targets = 24;
    for (let i = 0; i < AGENTS; i++) {
      const t = i % targets;
      const col = t % 6;
      const row = (t / 6) | 0;
      NavStressAgent.spawn({
        x: 80 + (i % AGENT_COLS) * AGENT_SPACING,
        y: 80 + ((i / AGENT_COLS) | 0) * AGENT_SPACING,
        tx: 400 + col * 220,
        ty: 400 + row * 220,
      });
    }
    Camera.centerOn(1024, 1024);
    Camera.setZoom(0.4);
  }
}
