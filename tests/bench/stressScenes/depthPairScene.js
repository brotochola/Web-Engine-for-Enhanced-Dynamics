import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, LightEmitter, Camera, Sun, Decoration } = WEED;

/**
 * N-262's picture: pixel depth (DX-DEPTH) between two things a few floor px apart, as Buenos Aires puts them. Each column
 * is a street lamp (the barrio's u_farol_hierro, from lpc_revised_recortado with its height map) with an LPC person
 * (civil1, its height map) standing `gap` px north of it (twice that on the floor, which the camera draws half as tall), the gap growing from 0 to 9 left to right; the lower row
 * puts the person as far in front instead. By night the lamp is lit and unshaded (`?lit=0`: its unlit, shaded frame): an
 * unshaded pixel writes no depth, so the lamp tests its foot's floor place against the person's pixels, which take theirs
 * from an approximate height map. The owner's catch: the head of a person just behind the lamp showing through it.
 *
 * The barrio's camera (floor drawn 0.5 as tall as wide, a px of height 0.866 px up the screen), its nearest-sampled atlas,
 * and one light. Nothing moves: for side-by-side pictures and compareCaptures.mjs.
 *
 * `?lit=0` the lamps unlit (shaded, their own heights); `?zoom=` (default 5); `?step=` px from one gap to the next
 * (default 1); `?backend=webgpu`.
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
export const LIT = P?.get('lit') !== '0';
export const ZOOM = num('zoom', 5);
/** `?step=`: px between one column's gap and the next (default 1: gaps 0 to 9). */
export const STEP = Math.max(0.25, num('step', 1));
const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const W = 600;
const H = 400;
const GAPS = 10;
const COLUMN = 18;
const LEFT = W / 2 - ((GAPS - 1) * COLUMN) / 2;
const ROW_BEHIND = H / 2 - 20;
const ROW_FRONT = H / 2 + 40;

export const stressSceneConfig = { requested: { lit: LIT ? 1 : 0, zoom: ZOOM, step: STEP, backend: BACKEND } };

/** The barrio's street lamp: its lit frame unshaded by night, as townObjects.js's Prop shows it. */
class StreetLamp extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('lpc_revised_recortado', LIT ? 'faroles_01_0_0' : 'faroles_02_0_0', 0);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.975;
    this.setScale(0.6, 0.6);
    this.spriteRenderer.unshaded = LIT;
  }
}

/** An LPC person facing the camera, as walkers.js draws one: feet on row 62 of 64, 6 % narrower than tall. */
class Person extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('civil1');
    this.setAnimation('idle_down');
    // Held on its first frame: nothing moves.
    this.spriteRenderer.animationSpeed = 0;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 62 / 64;
    this.setScale(0.6 * 0.94, 0.6);
  }
}

/** A light over the middle, so the people and the lamps' posts show. */
class Light extends GameObject {
  static components = [LightEmitter];

  onSpawned() {
    this.lightEmitter.color = 0xffe0b0;
    this.lightEmitter.radius = 400;
    this.lightEmitter.elevation = 60;
  }
}

export class DepthPairScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x262,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 64 },
    logic: { numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 4 },
    renderer: { backend: BACKEND, ySort: true, atlasScaleMode: 'nearest' },
    camera: { floorScaleY: 0.5, heightScaleY: 0.866025403784 },
    lighting: {
      enabled: true,
      baseAmbient: 0.25,
      maxLights: 8,
      resolution: 1,
      sun: { enabled: true, angle: 135, elevation: 40, intensity: 1, startHour: 22, dayCycle: { enabled: false } },
    },
  };

  static assets = {
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png', heightMap: '/demos/img/civil1_h.png' },
      lpc_revised_recortado: {
        json: '/demos/img/objetos/lpc_revised_recortado.json',
        png: '/demos/img/objetos/lpc_revised_recortado.png',
        heightMap: '/demos/img/objetos/lpc_revised_recortado_h.png',
      },
    },
  };

  static entities = [[StreetLamp, 2 * GAPS], [Person, 2 * GAPS], [Light, 1]];

  create() {
    Sun.setTimeOfDay(22);
    // The floor: a grey sheet hung from the world's north edge, so its foot (where pixel depth puts a sprite without a
    // height map) is behind everything.
    Decoration.spawn({ x: W / 2, y: 0, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0, tint: 0x6c6a62 });
    for (let k = 0; k < GAPS; k++) {
      const x = LEFT + k * COLUMN;
      // Behind: the person's feet k px north of the lamp's (2k on the floor: the camera draws it half as tall).
      StreetLamp.spawn({ x, y: ROW_BEHIND });
      Person.spawn({ x, y: ROW_BEHIND - k * STEP });
      // In front: k px south.
      StreetLamp.spawn({ x, y: ROW_FRONT });
      Person.spawn({ x, y: ROW_FRONT + k * STEP });
    }
    Light.spawn({ x: W / 2, y: H / 2 + 40 });
    Camera.setZoom(ZOOM);
    Camera.centerOn(W / 2, H / 2);
  }
}
