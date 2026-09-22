/**
 * Mostly static MESH islands plus a spinning minority.
 * Baseline reflows every instance once any pose changes.
 * packMovedMeshes refills only the spinners.
 */
import WEED from '/src/index.js';
import { MeshFillIsland, MeshFillSpinner } from './compoundFixture/meshFillIsland.js';

const { Scene, Camera, LAYER_KIND } = WEED;

export const ISLAND_COUNT = 6500;
export const SPIN_EVERY = 10;
const TRIANGLES = 8;
const VERTS = 8;
const WORLD_W = 12000;
const WORLD_H = 12000;

function meshConfig(packMoved) {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x11e7,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: ISLAND_COUNT * TRIANGLES + 64,
      sleeping: true,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      packMovedMeshes: packMoved,
    },
    lighting: { enabled: false },
    layers: {
      terrain: { kind: LAYER_KIND.MESH, zIndex: 2.9 },
    },
  };
}

function place(scene) {
  const cols = 64;
  const spacing = 150;
  const startX = 280;
  const startY = 280;
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const col = i % cols;
    const row = (i / cols) | 0;
    const spin = i % SPIN_EVERY === 0;
    scene.spawnEntity(spin ? MeshFillSpinner : MeshFillIsland, {
      x: startX + col * spacing,
      y: startY + row * spacing,
      triangles: TRIANGLES,
      vertsPerPoly: VERTS,
      tint: spin ? 0xaa7744 : 0x88aa66,
      spin: spin ? 0.04 : 0,
    });
  }
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(0.4);
}

export class MeshFillMixedScene extends Scene {
  static config = meshConfig(false);
  static assets = { textures: {} };
  static entities = [
    [MeshFillIsland, ISLAND_COUNT],
    [MeshFillSpinner, ISLAND_COUNT],
  ];
  create() {
    place(this);
  }
}

export class MeshFillMixedMovedScene extends MeshFillMixedScene {
  static config = meshConfig(true);
  static entities = [
    [MeshFillIsland, ISLAND_COUNT],
    [MeshFillSpinner, ISLAND_COUNT],
  ];
}

import { MeshFillMovingScene } from './meshFillMovingScene.js';

const movingBase = MeshFillMovingScene.config;

/** All-moving gate: packMovedMeshes must not make pixi 3% worse. */
export class MeshFillMovingPackedScene extends MeshFillMovingScene {
  static config = {
    ...movingBase,
    renderer: { ...movingBase.renderer, packMovedMeshes: true },
  };
}

