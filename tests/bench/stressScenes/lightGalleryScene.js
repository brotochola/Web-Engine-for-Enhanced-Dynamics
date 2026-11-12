import WEED from '/src/index.js';
import { GalleryBareLamp, GalleryBlock, GalleryLamp, GalleryProp } from './lightGallery/lightGalleryEntities.js';

const { Scene, Camera, LAYER_KIND, BLEND_MODES } = WEED;

/**
 * A still grid of lamps for byte-for-byte captures of the light API (DX-LIGHTAPI): each lamp sets a field the API has
 * (reach, colour, glow and its height and layer, the pool's height, the source's height, an offset on a turned entity,
 * a shadow reach shorter than the light's), with barrels that cast shadows around it, and with `?raycast=1` boxes that
 * block it. compareCaptures.mjs compares this scene written in one API against the same lamps written in another.
 *
 * `?raycast=1`, `?groundScaleY=` (default 1), `?backend=webgpu`, `?glowMode=sprite` (lighting.lightGlow), `?ambient=`
 * (default 0.05).
 */
const WORLD_W = 1280;
const WORLD_H = 720;

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

export const RAYCAST = queryNumber('raycast', 0) === 1;
export const GROUND_SCALE_Y = queryNumber('groundScaleY', 1);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const GLOW_MODE = query('glowMode') === 'sprite' ? 'sprite' : 'add';
export const AMBIENT = queryNumber('ambient', 0.05);

/**
 * The lamps, one per cell of a 4 × 3 grid (320 × 240 px). `bare`: no Collider. `range`: the Collider's visualRange
 * (left out: the light's whole reach). The fields are the light API's of the revision this file belongs to. They are
 * the old API's lamps (91248f19) through DX-LIGHTAPI's exact mapping: radius 10·√I, glow I·hasGlowSprite/25000,
 * glowOffsetY -glowHeightOffset, elevation the sourceHeight, a height h as offsetY -h and glowOffsetY +h.
 */
export const LAMPS = [
  { radius: 200 },
  { radius: 500, color: 0xffcc88, glow: 0.05 },
  { radius: 1000, color: 0x88ccff, glow: 0.4, glowOffsetY: -30 },
  { radius: 2000, color: 0xff8866, glow: 0.8, offsetY: -40, glowOffsetY: 40, bare: true },
  { radius: 1000, color: 0xffeecc, glow: 0.2, glowOffsetY: -60, elevation: 60 },
  { radius: 1400, color: 0xffd0a0, glow: 0.49, glowOffsetY: -110, elevation: 110, range: 200 },
  { radius: 700, color: 0xccffcc, glow: 0.098, offsetX: 40, rotation: Math.PI / 2, bare: true },
  { radius: 950, color: 0xfff1c4, offsetX: 30, offsetY: -20, rotation: Math.PI / 4 },
  { radius: 1200, color: 0xffcc88, glow: 0.288, layer: 'glows' },
  { radius: 260, color: 0xfff0d0 },
  { radius: 550, color: 0xffe8c0, glow: 0.0605, glowOffsetY: -10, range: 700 },
  { radius: 1260, color: 0xff9a40, offsetY: 20, glowOffsetY: -20 },
];

/** Barrels around each lamp (offsets from its cell's centre). */
const PROP_OFFSETS = [[70, 30], [-60, 50], [20, -70]];
/** Boxes around each lamp under `?raycast=1`. */
const BLOCK_OFFSETS = [[-80, -30], [90, -50]];

export const stressSceneConfig = {
  requested: { raycast: RAYCAST ? 1 : 0, groundScaleY: GROUND_SCALE_Y, backend: BACKEND, glowMode: GLOW_MODE, ambient: AMBIENT },
};

export class LightGalleryScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x11a7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, noLimitFPS: false, maxVisibleRenderables: 4000 },
    preRender: { noLimitFPS: false },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
      glows: { zIndex: 4, blendMode: BLEND_MODES.ADD, ySorting: false },
    },
    lighting: {
      enabled: true,
      baseAmbient: AMBIENT,
      maxLights: 32,
      shadowsEnabled: true,
      raycasted: RAYCAST,
      groundScaleY: GROUND_SCALE_Y,
      lightGlow: GLOW_MODE,
      maxShadowCastingLights: 16,
      maxShadowsPerLight: 32,
      maxPolygonVertices: 2048,
      resolution: 1,
      shadowResolution: 1,
      sun: { enabled: false },
    },
  };
  static assets = {
    textures: {
      ground: '/demos/img/box_100_100.png',
      barrel1: '/demos/img/bola.png',
    },
  };
  static entities = [
    [GalleryLamp, 16],
    [GalleryBareLamp, 16],
    [GalleryProp, 48],
    [GalleryBlock, 32],
  ];

  create() {
    for (let i = 0; i < LAMPS.length; i++) {
      const cx = 160 + (i % 4) * 320;
      const cy = 120 + Math.floor(i / 4) * 240;
      const spec = { ...LAMPS[i], x: cx, y: cy };
      if (spec.bare) GalleryBareLamp.spawn(spec);
      else GalleryLamp.spawn(spec);
      for (const [dx, dy] of PROP_OFFSETS) GalleryProp.spawn({ x: cx + dx, y: cy + dy });
      if (RAYCAST) {
        for (const [dx, dy] of BLOCK_OFFSETS) GalleryBlock.spawn({ x: cx + dx, y: cy + dy });
      }
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
