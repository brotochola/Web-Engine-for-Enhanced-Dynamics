/**
 * Stationary spatial past 65 535 entities: the scene's entity ids are 32-bit ('auto' from the declared count), so
 * the spatial publish and gather run their 32-bit paths (W8b). Same density as StationarySpatial30kScene, on a
 * square grid. `?entities=` sets the count (default 70 000).
 */
import WEED from '/src/index.js';
import { StationarySpatialEntity } from './stationary/stationarySpatialEntity.js';

const { Scene, Camera } = WEED;

const SCENE_QUERY =
  typeof location !== 'undefined' && location.search
    ? new URLSearchParams(location.search)
    : new URLSearchParams('');
const RAW = Number(SCENE_QUERY.get('entities'));
const N = Number.isFinite(RAW) && RAW > 0 ? Math.floor(RAW) : 70000;
const COLS = Math.ceil(Math.sqrt(N));
const SPACING = 45;
const WORLD = Math.ceil(COLS * SPACING + 800);

export class StationarySpatialWideScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 128,
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
      StationarySpatialEntity.spawn({
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
