import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { CompareLamp, CompareProp, CompareWalker } from './light3dCompare/light3dCompareEntities.js';

const { Scene, Camera, LAYER_KIND, Sun } = WEED;

/**
 * E-386 (a): one population on main and on dx/light3d, so that a sitting against main reads what the branch costs a scene
 * that lights as it always did, and each of the branch's pieces can then be switched on in the same scene. People walking
 * (civil1 to civil4, animated, each a ShadowCaster), still props that cast (houses, trees, barrels, rocks) and lamps that
 * cast, by day under the sun or by night (`?hour=22`, the sun down, the lamps alone). Only the API main has; the camera
 * still, the whole world in view.
 *
 * Load: `?walkers=` (3000), `?props=` (400), `?lamps=` (24), `?hour=` (12, the day cycle off).
 * The branch's pieces, off by default (a key main does not know is never written then): `?pitch=` (camera.pitch, an
 * oblique camera, e.g. 47), `?sunMap=1` (lighting.sunShadows 'map'), `?lampMap=1` (lighting.lampShadows 'map'), `?self=1`
 * (lighting.selfShadow), `?depth=1` (renderer.pixelDepth), `?maps=1` (the people's height and normal maps), `?ds=1` (the
 * people through DirectionalSprite), `?all=1` (all of them, pitch 47). `?backend=webgpu`.
 * `?staticProps=1`: the props declare isStatic (static scenery, E-127; the lamps' map caches their shadows, E-418).
 * `?still=1`: the walkers stand where their loops start, not animated, for byte-for-byte captures (compareCaptures.mjs).
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const ALL = P?.get('all') === '1';
const on = (key) => ALL || P?.get(key) === '1';

export const WALKERS = Math.max(0, Math.floor(num('walkers', 3000)));
export const PROPS = Math.max(0, Math.floor(num('props', 400)));
export const LAMPS = Math.max(0, Math.floor(num('lamps', 24)));
export const HOUR = num('hour', 12);
export const PITCH = ALL ? num('pitch', 47) : num('pitch', 0);
export const SUN_MAP = on('sunMap');
export const LAMP_MAP = on('lampMap');
export const SELF = on('self');
export const DEPTH = on('depth');
export const MAPS = on('maps');
export const DS = on('ds');
export const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const STATIC_PROPS = P?.get('staticProps') === '1';
export const STILL = P?.get('still') === '1';

export const stressSceneConfig = {
  requested: {
    walkers: WALKERS, props: PROPS, lamps: LAMPS, hour: HOUR, pitch: PITCH, sunMap: SUN_MAP ? 1 : 0, lampMap: LAMP_MAP ? 1 : 0,
    self: SELF ? 1 : 0, depth: DEPTH ? 1 : 0, maps: MAPS ? 1 : 0, ds: DS ? 1 : 0, backend: BACKEND,
    staticProps: STATIC_PROPS ? 1 : 0, still: STILL ? 1 : 0,
  },
};

const WORLD_W = 3200;
const WORLD_H = 2000;
const SEED = 0x13d;
const PROP_TEXTURES = [
  ['house1', 0.5, 0.92], ['house2', 0.5, 0.92], ['tree1', 0.8, 0.96], ['tree2', 0.8, 0.96],
  ['barrel1', 0.6, 0.95], ['barrel2', 0.6, 0.95], ['barrel3', 0.6, 0.95], ['rock1', 0.6, 0.9], ['rock2', 0.6, 0.9],
];

/** A civilian sheet, with its height and normal maps under ?maps=1. */
function civil(n) {
  return {
    json: '/demos/img/civil1.json',
    png: `/demos/img/civil${n}.png`,
    excludeAnimations: UNUSED_ANIMATIONS,
    ...(MAPS ? { heightMap: `/demos/img/civil${n}_h.png`, normalMap: `/demos/img/civil${n}_n.png` } : {}),
  };
}

/** The LPC sheet's animations the people never play: all but the walk and the idle (the atlas keeps the rest out). */
const UNUSED_ANIMATIONS = ['spellcast', 'thrust', 'slash', 'shoot', 'jump', 'sit', 'emote', 'run', 'combat', '1h_slash', '1h_halfslash']
  .flatMap((a) => ['up', 'left', 'down', 'right'].map((d) => `${a}_${d}`))
  .concat(['hurt', 'climb']);

export class Light3dCompareScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: BACKEND,
      ySort: true,
      maxVisibleRenderables: Math.max(4000, WALKERS + PROPS + 512),
      ...(DEPTH ? { pixelDepth: true } : {}),
    },
    preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' },
    ...(PITCH > 0 ? { camera: { pitch: PITCH } } : {}),
    // A floor, so the shadows fall on something (and the light pass lights every pixel, as a game's would).
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.06,
      shadowsEnabled: true,
      maxLights: Math.max(64, LAMPS + 8),
      maxShadowCastingLights: Math.max(1, LAMPS),
      maxShadowsPerLight: 512,
      maxShadowsPerEntity: 3,
      ...(SUN_MAP ? { sunShadows: 'map' } : {}),
      ...(LAMP_MAP ? { lampShadows: 'map' } : {}),
      ...(SELF ? { selfShadow: true } : {}),
      sun: {
        enabled: true,
        angle: 135,
        elevation: 40,
        intensity: 1,
        shadowAlpha: 0.5,
        startHour: HOUR,
        dayCycle: { enabled: false },
      },
    },
  };

  static assets = {
    spritesheets: { civil1: civil(1), civil2: civil(2), civil3: civil(3), civil4: civil(4) },
    textures: {
      ground: '/demos/img/rocky.jpg',
      house1: '/demos/img/house1.png',
      house2: '/demos/img/house2.png',
      tree1: '/demos/img/tree1.png',
      tree2: '/demos/img/tree2.png',
      barrel1: '/demos/img/barrel1.png',
      barrel2: '/demos/img/barrel2.png',
      barrel3: '/demos/img/barrel3.png',
      rock1: '/demos/img/rock1.png',
      rock2: '/demos/img/rock2.png',
    },
  };

  static entities = [
    [CompareWalker, Math.max(1, WALKERS)],
    [CompareProp, Math.max(1, PROPS)],
    [CompareLamp, Math.max(1, LAMPS)],
  ];

  create() {
    const rng = mulberry32(SEED);
    CompareWalker.worldW = WORLD_W;
    CompareWalker.worldH = WORLD_H;
    for (let i = 0; i < WALKERS; i++) CompareWalker.spawn({ sheet: i, scale: 0.8 + rng() * 0.2 });
    for (let i = 0; i < PROPS; i++) {
      const [texture, scale, ay] = PROP_TEXTURES[Math.floor(rng() * PROP_TEXTURES.length)];
      CompareProp.spawn({ texture, scale: scale * (0.85 + rng() * 0.3), ay, x: 60 + rng() * (WORLD_W - 120), y: 80 + rng() * (WORLD_H - 120) });
    }
    // The lamps on a grid, a little jitter.
    const cols = Math.max(1, Math.ceil(Math.sqrt(LAMPS * (WORLD_W / WORLD_H))));
    const rows = Math.max(1, Math.ceil(LAMPS / cols));
    for (let i = 0; i < LAMPS; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      CompareLamp.spawn({
        x: ((c + 0.5) / cols) * WORLD_W + (rng() - 0.5) * 80,
        y: ((r + 0.5) / rows) * WORLD_H + (rng() - 0.5) * 80,
        radius: 440 + rng() * 160,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(Camera.minZoom);
    // The hour, held (the day cycle is off): 22 is night, the lamps alone.
    if (Sun.isInitialized) Sun.setTimeOfDay(HOUR);
  }
}
