/**
 * Static MESH fill + camera orbit. Forces RT every frame; pack should skip.
 * Passthrough look: engine allocates cl.rt only when a look exists.
 * Primary: pixi_STEP_MS. Load: BODY_COUNT, MESH_FILL_INSTANCES. Gate: MESH_RT_DRAWS ≈ 1.
 */
import WEED from '/src/index.js';
import { MeshFillIsland } from './compoundFixture/meshFillIsland.js';
import { CameraOrbitDriver, stepCameraOrbit } from './pixiPeel/cameraOrbitDriver.js';

const { Scene, Camera, LAYER_KIND, BLEND_MODES } = WEED;

export const ISLAND_COUNT = 6500;
export const TRIANGLES_PER_ISLAND = 8;
export const VERTS_PER_POLY = 8;
export const WORLD_W = 12000;
export const WORLD_H = 12000;

export class MeshFillPanScene extends Scene {
  static config = {
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
      maxFixturePoolSize: ISLAND_COUNT * TRIANGLES_PER_ISLAND + 64,
      sleeping: true,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
    layers: {
      // Engine only allocates fill RT when a look exists. Passthrough is
      // the cheapest look that still hits _renderMeshFillToRt (H2 path).
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2.9,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        ySorting: false,
        shader: { fragment: 'passthroughLook' },
      },
    },
  };

  static assets = {
    textures: {},
    shaders: {
      passthroughLook: {
        webgl: '/tests/bench/stressScenes/pixiPeel/passthroughLook.frag',
        webgpu: '/tests/bench/stressScenes/pixiPeel/passthroughLook.wgsl',
      },
    },
  };

  static entities = [
    [MeshFillIsland, ISLAND_COUNT],
    [CameraOrbitDriver, 1],
  ];

  create() {
    const cols = 64;
    const spacing = 150;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(MeshFillIsland, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        triangles: TRIANGLES_PER_ISLAND,
        vertsPerPoly: VERTS_PER_POLY,
        tint: 0x88aa66,
        spin: 0,
      });
    }
    this.spawnEntity(CameraOrbitDriver, {
      cx: WORLD_W * 0.5,
      cy: WORLD_H * 0.5,
      radius: 720,
      zoom0: 0.4,
      zoomAmp: 0.06,
      seed: 0x11e7,
    });
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.4);
    this._orbT = 0;
  }

  update() {
    this._orbT += 0.045;
    stepCameraOrbit(this._orbT, WORLD_W * 0.5, WORLD_H * 0.5, 720, 0.4, 0.06);
  }
}
