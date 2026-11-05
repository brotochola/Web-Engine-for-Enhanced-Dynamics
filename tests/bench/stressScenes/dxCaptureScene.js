import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { DxCaptureLamp, DxCaptureProp, DxCaptureShade } from './dxCapture/dxCaptureEntities.js';

const { Scene, Camera, Sun, Decoration, LAYER_KIND, BLEND_MODES } = WEED;

/**
 * A still, seeded scene for byte-for-byte captures (compareCaptures.mjs): sprites that cast shadows over a light
 * ground, point lights, the sun stopped at an hour. A revision without a knob ignores its key, so the defaults compare
 * across revisions, and a knob compares against its own absence.
 *
 * `?hour=` (default 12), `?lights=` (default 8), `?backend=webgpu`, `?raycast=1`, `?night=1` (lighting.sun.night),
 * `?colors=1` (lighting.sun.colors). `?shade=1`: overlapping black squares on a MESH layer, `?shadeLook=1` with a look
 * shader that passes its RT through, `?shadeAlpha=` (default 1) the layer's alpha, `?shadeMeshAlpha=` (default 1) each
 * mesh's, `?shadeSun=` its alphaBySun (shadow, night, or ramp for { from: 0.1, to: 0.4 }). `?deco=1`: decorations on a
 * sprite layer, `?decoAlpha=` (default 1) the layer's alpha, `?decoLook=1` through a look, `?decoSun=` its alphaBySun.
 */
const SEED = 0xd7ca;
const WORLD_W = 1280;
const WORLD_H = 720;
const PROPS = 48;

function query(key) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(key);
  } catch {
    return null;
  }
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const HOUR = queryNumber('hour', 12);
export const LIGHTS = Math.max(0, Math.floor(queryNumber('lights', 8)));
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const RAYCAST = queryNumber('raycast', 0) === 1;
export const NIGHT = queryNumber('night', 0) === 1;
export const COLORS = queryNumber('colors', 0) === 1;
export const SHADE = queryNumber('shade', 0) === 1;
export const SHADE_LOOK = queryNumber('shadeLook', 0) === 1;
export const SHADE_ALPHA = queryNumber('shadeAlpha', 1);
export const SHADE_MESH_ALPHA = queryNumber('shadeMeshAlpha', 1);
export const DECO = queryNumber('deco', 0) === 1;
export const DECO_ALPHA = queryNumber('decoAlpha', 1);
export const DECO_LOOK = queryNumber('decoLook', 0) === 1;
const sunSpec = (key) => {
  const raw = query(key);
  return raw === 'ramp' ? { from: 0.1, to: 0.4 } : raw;
};
/** Moves the lamps down, for a picture to hold `?lampOffset=` against. */
export const LAMP_SHIFT = queryNumber('lampShift', 0);
export const stressSceneConfig = {
  requested: {
    hour: HOUR,
    lights: LIGHTS,
    backend: BACKEND,
    raycast: RAYCAST ? 1 : 0,
    night: NIGHT ? 1 : 0,
    colors: COLORS ? 1 : 0,
    shade: SHADE ? 1 : 0,
    shadeLook: SHADE_LOOK ? 1 : 0,
    shadeAlpha: SHADE_ALPHA,
    shadeMeshAlpha: SHADE_MESH_ALPHA,
    deco: DECO ? 1 : 0,
    decoAlpha: DECO_ALPHA,
  },
};

export class DxCaptureScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 64 },
    renderer: { backend: BACKEND, noLimitFPS: false, maxVisibleRenderables: 4000, maxMeshVerts: 4096, maxMeshIndices: 8192 },
    preRender: { noLimitFPS: false, packGpuSprites: 'pixi', sortSprites: 'pixi' },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
      overlay: {
        zIndex: 1.6,
        ySorting: false,
        alpha: DECO_ALPHA,
        ...(DECO_LOOK ? { shader: { fragment: 'dxPass', containerBlend: BLEND_MODES.NORMAL } } : {}),
        ...(sunSpec('decoSun') ? { alphaBySun: sunSpec('decoSun') } : {}),
      },
      shade: {
        kind: LAYER_KIND.MESH,
        zIndex: 1.5,
        alpha: SHADE_ALPHA,
        ...(sunSpec('shadeSun') ? { alphaBySun: sunSpec('shadeSun') } : {}),
        ...(SHADE_LOOK ? { shader: { fragment: 'dxPass', containerBlend: BLEND_MODES.NORMAL } } : {}),
      },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.1,
      maxLights: 32,
      shadowsEnabled: true,
      raycasted: RAYCAST,
      maxShadowCastingLights: 8,
      maxShadowsPerLight: 32,
      resolution: 1,
      shadowResolution: 1,
      sun: {
        enabled: true,
        startHour: HOUR,
        shadowAlpha: 0.6,
        dayCycle: { enabled: false },
        ...(NIGHT ? { night: { intensity: 0.3, color: 0x5473f2, from: 0.4, to: 0.1 } } : {}),
        ...(COLORS ? { colors: [{ hour: 0, color: 0xff00ff }, { hour: 24, color: 0x00ff00 }] } : {}),
      },
    },
  };
  static assets = {
    textures: {
      ground: '/demos/img/box_100_100.png',
      barrel1: '/demos/img/bola.png',
    },
    shaders: {
      dxPass: { webgl: '/tests/bench/stressScenes/shaders/dxPass.frag', webgpu: '/tests/bench/stressScenes/shaders/dxPass.wgsl' },
    },
  };
  static entities = [
    [DxCaptureProp, PROPS],
    [DxCaptureLamp, 64],
    [DxCaptureShade, 8],
  ];

  create() {
    const rng = mulberry32(SEED);
    Sun.setTimeOfDay(HOUR);
    for (let i = 0; i < PROPS; i++) {
      DxCaptureProp.spawn({ x: 40 + rng() * (WORLD_W - 80), y: 40 + rng() * (WORLD_H - 80) });
    }
    for (let i = 0; i < LIGHTS; i++) {
      DxCaptureLamp.spawn({ x: 80 + rng() * (WORLD_W - 160), y: 80 + rng() * (WORLD_H - 160) + LAMP_SHIFT });
    }
    if (DECO) {
      for (let i = 0; i < 4; i++) {
        Decoration.spawn({ x: 800 + i * 60, y: 200 + i * 30, texture: 'ground', layer: 'overlay', tint: 0x000000, scaleX: 1.5, scaleY: 1.5 });
      }
    }
    if (SHADE) {
      for (let i = 0; i < 4; i++) {
        DxCaptureShade.spawn({ x: 400 + i * 120, y: 300 + i * 40, alpha: SHADE_MESH_ALPHA });
      }
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
