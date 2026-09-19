/**
 * Same as MeshFillPanScene plus look-on-stage (rockContour). Isolates H3 from H2.
 * Primary: pixi_STEP_MS. Load: BODY_COUNT, MESH_FILL_INSTANCES, MESH_RT_DRAWS.
 */
import WEED from '/src/index.js';
import { MeshFillIsland } from './compoundFixture/meshFillIsland.js';
import { CameraOrbitDriver, stepCameraOrbit } from './pixiPeel/cameraOrbitDriver.js';

const { Scene, Camera, LAYER_KIND, BLEND_MODES } = WEED;

function lookPanBackend() {
  const search = globalThis.location && globalThis.location.search;
  if (typeof search === 'string') {
    const q = new URLSearchParams(search).get('backend');
    if (q === 'webgl' || q === 'webgpu') return q;
  }
  return 'webgl';
}

export const ISLAND_COUNT = 6500;
export const TRIANGLES_PER_ISLAND = 8;
export const VERTS_PER_POLY = 8;
export const WORLD_W = 12000;
export const WORLD_H = 12000;

export class MeshFillLookPanScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x11e8,
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
    renderer: { backend: lookPanBackend(), noLimitFPS: false },
    lighting: { enabled: false },
    layers: {
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2.9,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        ySorting: false,
        shader: {
          fragment: 'rockContour',
          containerBlend: BLEND_MODES.NORMAL,
          uniforms: {
            uCutoff: { value: 0.08, type: 'f32' },
            uRimWidth: { value: 0.0018, type: 'f32' },
            uRimColor: { value: [1, 1, 1], type: 'vec3<f32>' },
            uRimAlpha: { value: 0.85, type: 'f32' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      rocky: '/demos/img/rocky.jpg',
    },
    shaders: {
      rockContour: {
        webgl: '/demos/shaders/rockContour.frag',
        webgpu: '/demos/shaders/rockContour.wgsl',
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
      seed: 0x11e8,
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
