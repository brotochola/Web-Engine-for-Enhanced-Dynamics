import WEED from '/src/index.js';
import { EntityIdSpatialBody } from './entityIdSpatial/entityIdSpatialBody.js';

const { Scene, Camera } = WEED;

/** Frozen after 8 ms hunt. Same density as Stationary (spacing 45, visualRange 170). Physics off. */
export const ENTITY_ID_SPATIAL_300K = {
  n: 300000,
  spacing: 45,
  visualRange: 170,
  radius: 10,
  cellSize: 128,
  maxNeighbors: 128,
  maxEntitiesPerCell: 64,
  cols: 548,
};

const world = Math.ceil(ENTITY_ID_SPATIAL_300K.cols * ENTITY_ID_SPATIAL_300K.spacing + 600);

export class EntityIdSpatial300kScene extends Scene {
  static config = {
    entityIdWidth: 32,
    worldWidth: world,
    worldHeight: world,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: ENTITY_ID_SPATIAL_300K.cellSize,
      maxNeighbors: ENTITY_ID_SPATIAL_300K.maxNeighbors,
      maxEntitiesPerCell: ENTITY_ID_SPATIAL_300K.maxEntitiesPerCell,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 4000,
    },
    preRender: { skipCull: false },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };

  static entities = [[EntityIdSpatialBody, ENTITY_ID_SPATIAL_300K.n]];

  create() {
    const { n, cols, spacing } = ENTITY_ID_SPATIAL_300K;
    const startX = 300;
    const startY = 300;
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(EntityIdSpatialBody, {
        x: startX + col * spacing,
        y: startY + row * spacing,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.12);
  }
}
