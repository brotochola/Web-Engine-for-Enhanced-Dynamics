/**
 * Stationary spatial hunt at 30k. Same density as StationarySpatialHuntScene (22k frozen).
 * Fase 0 of the doc-hyp campaign: REBUILD_MS vs NEIGHBOR_MS, home-row skips.
 */
import WEED from '/src/index.js';
import { StationarySpatialEntity } from './stationary/stationarySpatialEntity.js';

const { Scene, Camera } = WEED;

const N = 30000;
const COLS = 200;
const SPACING = 45;
const WORLD = Math.ceil(COLS * SPACING + 800);

export class StationarySpatial30kScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 128,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 8000 },
    lighting: { enabled: false },
  };

  static assets = { textures: { ball: '/demos/img/bola.png' } };

  static entities = [[StationarySpatialEntity, N]];

  create() {
    const startX = 300;
    const startY = 300;
    for (let i = 0; i < N; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      this.spawnEntity(StationarySpatialEntity, {
        x: startX + col * SPACING,
        y: startY + row * SPACING,
        radius: 10,
        visualRange: 170,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.22);
  }
}
