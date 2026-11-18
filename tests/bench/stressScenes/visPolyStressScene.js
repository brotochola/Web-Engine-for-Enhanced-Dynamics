import WEED from '/src/index.js';
import { VisPolyAlbedo } from './visPoly/visPolyAlbedo.js';
import { VisPolyLight } from './visPoly/visPolyLight.js';
import { VisPolyOccluder, VisPolySpriteOccluder } from './visPoly/visPolyOccluder.js';

const { Scene, Camera } = WEED;

const SEED = 0x51f01;
/** `?lights=` (default 360): the scene's load knob, for a sitting that needs pre-render above the 3 ms floor. */
export const LIGHTS = (() => {
  try {
    const n = Number(new URLSearchParams(globalThis.location?.search || '').get('lights'));
    return n > 0 ? Math.floor(n) : 360;
  } catch {
    return 360;
  }
})();
const OCCLUDERS = 700;

/** `?occluderShape=circle`: round occluders, which Pixi draws as a self-lit fan (E-60). Default box. */
export const OCCLUDER_SHAPE = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('occluderShape') === 'circle' ? 'circle' : 'box';
  } catch {
    return 'box';
  }
})();

/**
 * `?selfLit=N`: `lighting.maxOccluderSelfLit`, the self-lit fills per frame (default 512, the engine's).
 * At 512 only the first few dozen lights get one; raise it to light every occluder (E-96b).
 */
export const SELF_LIT = (() => {
  try {
    const n = Number(new URLSearchParams(globalThis.location?.search || '').get('selfLit'));
    return n > 0 ? Math.min(n | 0, 1 << 20) : 512;
  } catch {
    return 512;
  }
})();

/**
 * `?mask=sprite` (E-260): the occluders carry a white picture of their size and their self-lit fills are masked by it
 * (setWall({ shape: 'sprite' }), as a house in the Headlights demo): the self-lit sprite-mask pass, one mesh per occluder
 * and light.
 */
export const SPRITE_MASK = WEED.params?.get('mask') === 'sprite' ? 1 : 0;

/** `?backend=webgpu` (default webgl): the renderer, so the sprite-masked pass can be compared on both (E-260). */
export const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';

/**
 * `?block=X`: the occluders' `shadowCaster.opacity`, their walls' block (default 1). Under 1 each occluder lets part of the
 * light through and adds a transmit wedge per light, which no other scene draws (E-96c).
 */
export const BLOCK = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('block');
    const n = raw === null ? NaN : Number(raw);
    return n >= 0 && n <= 1 ? n : 1;
  } catch {
    return 1;
  }
})();

/**
 * `?arm=` (OL-3, the race): what stops the lamps, in one build.
 * - `walls` (the default): lighting.walls, the light pass reading the walls' rows (OL-4's final B).
 * - `fans`: the same walls drawn by the old pass, a fan a light (debug.lightFans). `?fans=1` asks for it too.
 * - `maps`: no walls. Each occluder is a volume taller than the lamps (shadowCaster.setBox), the lamps stand
 *   LAMP_HEIGHT px high, and the lamps' shadows are lighting.lampShadows 'map' (OL-4's final A, as far as it exists).
 *   NOT READY (2026-11-18): the lamps draw, but the volumes cast no shadow in their map here, with or without a
 *   pitch; lampShadowStressScene's blocks, set the same way, do. To find before the race runs this arm.
 * - `plain`: the light pass alone, nothing stopping a lamp: the floor of what either final costs. With the G-buffer on
 *   (lighting.unshaded), as walls and maps both have it; `?gbuf=0` leaves it off.
 */
export const ARM = (() => {
  const arm = WEED.params?.get('arm');
  if (arm === 'fans' || arm === 'maps' || arm === 'plain') return arm;
  return WEED.params?.get('fans') === '1' ? 'fans' : 'walls';
})();
export const FANS = ARM === 'fans' ? 1 : 0;
const ARM_WALLS = ARM === 'walls' || ARM === 'fans';
/** `?gbuf=0`, with `?arm=plain`: the light pass without the G-buffer pass. */
export const GBUF = WEED.params?.get('gbuf') === '0' ? 0 : 1;

/**
 * With `?arm=maps`: `?castLights=` (lighting.maxShadowCastingLights: the lamps with a tile; default the lights, at most
 * 64, what the map holds at 256 texels a tile), `?tile=` (lighting.lampShadowTile; default the engine's 'auto') and
 * `?lampCache=0` (lighting.lampMapCache off).
 */
export const CAST_LIGHTS = Number(WEED.params?.get('castLights')) > 0 ? Math.floor(Number(WEED.params.get('castLights'))) : Math.min(LIGHTS, 64);
export const TILE = Number(WEED.params?.get('tile')) > 0 ? Math.floor(Number(WEED.params.get('tile'))) : 0;
export const LAMP_CACHE = WEED.params?.get('lampCache') === '0' ? 0 : 1;
/** The lamps' height and the volumes' with `?arm=maps`: a wall is taller than any lamp. */
export const LAMP_HEIGHT = 40;
export const WALL_HEIGHT = 400;

/**
 * `?move=` (px, default 0): each light circles its place at that radius. A still lamp's sweep and its tile in the
 * lamps' map can be kept from frame to frame; a moving one's cannot.
 */
export const MOVE = Number(WEED.params?.get('move')) > 0 ? Number(WEED.params.get('move')) : 0;

/** `?zoom=` (default 0.35, the whole field) and `?lightRes=` (lighting.resolution, default the engine's): a closer look at the shadows' edges. */
export const ZOOM = Number(WEED.params?.get('zoom')) > 0 ? Number(WEED.params.get('zoom')) : 0.35;
export const LIGHT_RES = Number(WEED.params?.get('lightRes')) > 0 ? Math.min(1, Number(WEED.params.get('lightRes'))) : 0;

export const stressSceneConfig = {
  requested: {
    occluderShape: OCCLUDER_SHAPE, selfLit: SELF_LIT, block: BLOCK, lights: LIGHTS, mask: SPRITE_MASK ? 'sprite' : 'collider', backend: BACKEND,
    arm: ARM, gbuf: GBUF, castLights: CAST_LIGHTS, tile: TILE, lampCache: LAMP_CACHE, move: MOVE, zoom: ZOOM, lightRes: LIGHT_RES,
  },
};

/** Bench scene: lights among walls (lighting.walls, in a view straight down). Predator default leaves this path off. */
export class VisPolyStressScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 256,
      maxEntitiesPerCell: 255,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, noLimitFPS: false, maxVisibleRenderables: 4000 },
    preRender: {
      noLimitFPS: false,
      packGpuSprites: 'pixi',
      sortSprites: 'pixi',
    },
    // Straight down: the floor of 1 the scene had without a camera, and no height on the screen. The maps' arm sets no
    // pitch (the same floor, heights on the screen): its volumes' heights are screen px, and a camera that shows no
    // height gives them none. The white floor sprite lies on the floor either way (VisPolyAlbedo's surface).
    camera: ARM === 'maps' ? {} : { pitch: 90 },
    debug: { lightFans: FANS === 1 },
    lighting: {
      enabled: true,
      // OL-4: the occluders are walls (shadowCaster.setWall): each light sweeps the ones in its reach.
      walls: ARM_WALLS,
      ...(ARM === 'maps'
        ? {
            lampShadows: 'map',
            maxVolumes: OCCLUDERS + 16,
            maxShadowCastingLights: CAST_LIGHTS,
            lampMapCache: LAMP_CACHE === 1,
            ...(TILE > 0 ? { lampShadowTile: TILE } : {}),
          }
        : {}),
      ...(ARM === 'plain' && GBUF === 1 ? { unshaded: true } : {}),
      ...(LIGHT_RES > 0 ? { resolution: LIGHT_RES } : {}),
      baseAmbient: 0.2,
      maxLights: LIGHTS,
      shadowsEnabled: true,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: SELF_LIT,
    },
  };

  static entities = [
    [VisPolyAlbedo, 1],
    [VisPolyLight, LIGHTS],
    // Both listed: a worker reads this list without the page's query, and the pool it does not use is empty.
    [VisPolyOccluder, SPRITE_MASK ? 0 : OCCLUDERS],
    [VisPolySpriteOccluder, SPRITE_MASK ? OCCLUDERS : 0],
  ];

  create() {
    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    // Multiply lighting × black clear = black. One white sprite is the albedo.
    VisPolyAlbedo.spawn({ x: w * 0.5, y: h * 0.5, width: w, height: h });
    for (let i = 0; i < LIGHTS; i++) {
      VisPolyLight.spawn({
        x: 400 + rng() * (w - 800),
        y: 400 + rng() * (h - 800),
        elevation: ARM === 'maps' ? LAMP_HEIGHT : 0,
        move: MOVE,
        phase: i * 0.37,
      });
    }
    for (let i = 0; i < OCCLUDERS; i++) {
      (SPRITE_MASK ? VisPolySpriteOccluder : VisPolyOccluder).spawn({
        x: 80 + rng() * (w - 160),
        y: 80 + rng() * (h - 160),
        width: 32 + rng() * 48,
        height: 32 + rng() * 48,
        circle: OCCLUDER_SHAPE === 'circle' ? 1 : 0,
        block: BLOCK,
        // What the occluder is: a wall, a volume of the lamps' map (taller than the lamps), or nothing.
        cast: ARM_WALLS ? 'wall' : ARM === 'maps' ? 'volume' : 'none',
        volumeHeight: WALL_HEIGHT,
      });
    }
    Camera.centerOn(w * 0.5, h * 0.5);
    Camera.setZoom(ZOOM);
  }
}
