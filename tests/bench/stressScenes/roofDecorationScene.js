import WEED from '/src/index.js';
import { face } from './faces/faceLightLayout.js';

const { Scene, Camera, Sun, Decoration, GameObject, SpriteRenderer } = WEED;

/**
 * N-450's still: pixel depth on, an oblique camera, a house of faces (its front and its roof, DX-FACES) and two
 * decorations that are no face, each sorted by the painter in front of the house while drawn over it:
 * - a water tank (blue), world-owned, standing on the roof: its y at roof height, its sortOffsetY bringing the point it
 *   sorts at to the house's front line (the barrio's Accesorio: a tank, an air conditioner, an antenna);
 * - a flag (red) attached to a pole that stands in front of the house, hung high on it: it sorts at the pole's foot.
 * Each is drawn over the roof, whose plane depth stands where the painter's foot is not. The tank's top stands above the
 * roof's back edge, over nothing, so that part shows whatever the depth does (as the accessories' did).
 *
 * `?hour=` (default 13), `?backend=webgpu`. The sprite paths, one key each (faceLightScene's): `?indexed=0` (two
 * streams), `?nearest=1` (a nearest atlas: the plain rows' edge cull), `?pack=pixi` (keyed frames). `?tank=0` and
 * `?flag=0` leave one out.
 */
function query(key) {
  return WEED.params?.get(key) ?? null;
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const HOUR = queryNumber('hour', 13);
const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const TANK = query('tank') !== '0';
const FLAG = query('flag') !== '0';
const WORLD_W = 1280;
const WORLD_H = 720;
const GROUND = 0.5;
const HEIGHT = 0.866;
const TEXTURE_PX = 8; // _white

// The house, in the floor's coordinates (faceLightLayout.js): x along the screen, y towards the camera, z up.
const HOUSE_X = 440;
const HOUSE_W = 400;
const HOUSE_FRONT = 700;
const HOUSE_DEPTH = 240;
const HOUSE_H = 120;
/** The house's front line on the screen: every face of it sorts there (its foot). */
const FRONT_LINE = HOUSE_FRONT * GROUND;

export const stressSceneConfig = {
  requested: { hour: HOUR, backend: BACKEND, tank: TANK ? 1 : 0, flag: FLAG ? 1 : 0 },
};

/** A thin grey pole, feet-anchored, in front of the house: the flag's parent. */
class RoofDecorationPole extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('_white');
    this.setTint(0x808080);
    this.setAnchor(0.5, 1);
    this.setScale(8 / TEXTURE_PX, 200 / TEXTURE_PX);
  }
}

export class RoofDecorationScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 450,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 64 },
    renderer: {
      backend: BACKEND,
      pixelDepth: true,
      ySort: true,
      indexedSprites: query('indexed') !== '0',
      atlasScaleMode: query('nearest') === '1' ? 'nearest' : 'linear',
      noLimitFPS: false,
      maxVisibleRenderables: 256,
    },
    preRender: { noLimitFPS: false, ...(query('pack') === 'pixi' ? { packGpuSprites: 'pixi', sortSprites: 'pixi' } : {}) },
    camera: { floorScaleY: GROUND, heightScaleY: HEIGHT },
    lighting: {
      enabled: true,
      baseAmbient: 0.35,
      maxLights: 4,
      resolution: 1,
      sun: { enabled: true, angle: 135, elevation: 40, intensity: 1, startHour: HOUR, dayCycle: { enabled: false }, skyLight: 0.4 },
    },
  };
  static assets = { textures: {} };
  static entities = [[RoofDecorationPole, 1]];

  create() {
    Sun.setTimeOfDay(HOUR);
    const g = GROUND;
    const h = HEIGHT;
    const back = HOUSE_FRONT - HOUSE_DEPTH;
    const faces = [
      face('front', [HOUSE_X, HOUSE_FRONT, HOUSE_H], [HOUSE_W, 0, 0], [0, 0, -HOUSE_H], g, h),
      face('roof', [HOUSE_X, back, HOUSE_H], [HOUSE_W, 0, 0], [0, HOUSE_DEPTH, 0], g, h),
    ];
    for (const f of faces) {
      Decoration.spawn({
        x: f.x,
        y: f.y,
        texture: '_white',
        tint: 0xe8e0d0,
        scaleX: f.scaleX / TEXTURE_PX,
        scaleY: f.scaleY / TEXTURE_PX,
        skewX: f.skewX,
        skewY: f.skewY,
        anchorX: 0.5,
        anchorY: 0.5,
        // Every face of the house sorts at its front line.
        sortOffsetY: FRONT_LINE - f.y,
        faceNormalX: f.normal[0],
        faceNormalY: f.normal[1],
        faceNormalZ: f.normal[2],
        faceHeight: f.height,
      });
    }
    if (TANK) {
      // On the roof's middle: drawn standing up from there, sorted a pixel in front of the house's front line.
      const roofY = (HOUSE_FRONT - HOUSE_DEPTH / 2) * g - HOUSE_H * h;
      Decoration.spawn({
        x: HOUSE_X + HOUSE_W * 0.6,
        y: roofY,
        texture: '_white',
        tint: 0x2050e0,
        scaleX: 70 / TEXTURE_PX,
        scaleY: 90 / TEXTURE_PX,
        anchorX: 0.5,
        anchorY: 1,
        sortOffsetY: FRONT_LINE + 1 - roofY,
      });
    }
    if (FLAG) {
      // The pole stands 60 floor px in front of the house; the flag hangs near its top, over the roof.
      const pole = RoofDecorationPole.spawn({ x: HOUSE_X + 90, y: (HOUSE_FRONT + 60) * g });
      Decoration.spawn({
        parent: pole.index,
        localX: 26,
        localY: -176,
        texture: '_white',
        tint: 0xe02020,
        scaleX: 44 / TEXTURE_PX,
        scaleY: 28 / TEXTURE_PX,
        anchorX: 0.5,
        anchorY: 0.5,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
