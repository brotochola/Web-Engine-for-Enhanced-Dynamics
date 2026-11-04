import WEED from '/src/index.js';

const { Scene, Camera, GameObject } = WEED;

/**
 * N-115: the only sprites on this canvas are decorations attached to entities, so a bundle that loses them draws black.
 * scripts/smokeBundleBrowser.mjs runs it through each ESM bundle: its other scene has no decoration at all.
 */
const WIDTH = 640;
const HEIGHT = 360;

export class AttachedDecorationSmokeAnchor extends GameObject {
  static components = [];

  onSpawned() {
    this.x = 80 + (this.index % 4) * 160;
    this.y = 100 + (Math.floor(this.index / 4) % 2) * 160;
    this.addDecoration('_white', 0, 0, 8, 8, 0, { anchorX: 0.5, anchorY: 0.5, tint: 0x40c070 });
  }
}

export class AttachedDecorationSmokeScene extends Scene {
  static config = {
    worldWidth: WIDTH,
    worldHeight: HEIGHT,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 64 },
    renderer: { backend: 'webgl', ySort: true, maxVisibleRenderables: 256 },
    lighting: { enabled: false },
  };
  static entities = [[AttachedDecorationSmokeAnchor, 8]];

  create() {
    for (let i = 0; i < 8; i++) AttachedDecorationSmokeAnchor.spawn();
    Camera.centerOn(WIDTH * 0.5, HEIGHT * 0.5);
  }
}
