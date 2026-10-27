// The editor page's console in Chromium (VISUAL_EDITOR_PLAN.md ED-18, tests/bench/editorShellSmoke.mjs): talkers log
// from their logic worker when they spawn, and the odd ones throw in their tick, so the console shows a worker's log,
// one of the load included, and a game code error with its count.
import WEED from '/src/index.js';

const { Scene, GameObject } = WEED;

export class Talker extends GameObject {
  onSpawned() {
    console.info(`talker #${this.index} spawned`);
  }

  tick() {
    if (this.index % 2 === 1) throw new Error('talker tick broke');
  }
}

export class EditorConsoleScene extends Scene {
  static config = {
    worldWidth: 1000,
    worldHeight: 1000,
    seed: 1,
    spatial: { numberOfSpatialWorkers: 0 },
    logic: { numberOfLogicWorkers: 1 },
    particle: { maxParticles: 0, decals: false },
    physics: { enabled: false },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  static entities = [[Talker, 8]];

  create() {
    for (let i = 0; i < 2; i++) Talker.spawn({ x: 100 + i * 50, y: 100 });
  }
}
