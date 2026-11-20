/**
 * N-254's fixture: a scene that fails while booting. Its one entity's module throws where a worker loads it, so the
 * scene never reports ready and the page itself throws nothing. runIntegratedWorkerBenchmark must end such a run at
 * once, with the error, instead of waiting out its watchdog (warm-up + window + 5 min).
 */
import WEED from '/src/index.js';
import { BrokenInWorker } from './bootFailure/brokenInWorker.js';

const { Scene } = WEED;

export class BootFailureScene extends Scene {
  static config = {
    worldWidth: 1000,
    worldHeight: 1000,
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[BrokenInWorker, 1]];

  create() {
    BrokenInWorker.spawn();
  }
}
