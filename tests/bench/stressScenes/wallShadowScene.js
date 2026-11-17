import WEED from '/src/index.js';
import { face } from './faces/faceLightLayout.js';

const { Scene, GameObject, SpriteRenderer, ShadowCaster, LightEmitter, Camera, Sun, Decoration } = WEED;

/**
 * Whether people's shadows reach walls, as Buenos Aires draws them: a house's front facing the camera and a wall turned 45
 * degrees from its east end (faces, DX-FACES: white decorations with a normal and a height), a street lamp at the curb in
 * front of them, and LPC people (civil1 with its height map and a ShadowCaster, as walkers.js's Persona) on the sidewalk
 * between. By night only the lamp lights them, so each person's shadow from it should climb the wall behind; by day
 * (`?hour=15`), the sun's. The walls are a house's, as the barrio's (townObjects.js Casa): its volume (a convex hull,
 * taller than the lamp) behind them, and the walls owned by it (DecorationComponent.owner, N-273). N-276: the volume, drawn
 * into the lamp's map by its vertices, won the texels of the people in front and the walls stood lit.
 *
 * The barrio's camera (floor drawn 0.5 as tall as wide, a px of height 0.866 px up the screen) and lighting (shadow maps for
 * the sun and the lamps, self-shadow). Nothing moves: for side-by-side pictures and compareCaptures.mjs.
 *
 * `?hour=` (default 22); `?lampShadows=` and `?sunShadows=` (lighting's, default 'map'); `?lampX=`, `?lampY=` (the lamp's
 * floor place, default 410, 460: 60 floor px in front of the wall); `?elevation=` (the bulb's height, default 50);
 * `?range=` (its radius and shadow range, default the barrio's); `?gap=` (the people's floor px in front of the wall,
 * default 25); `?zoom=` (default 3); `?house=0` (the walls alone, no volume, no owner); `?people=0` (the walls lit
 * alone); `?faces=0` (the walls without normals: lit as the floor); `?backend=webgpu`.
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const HOUR = num('hour', 22);
const ZOOM = num('zoom', 3);
const PEOPLE = P?.get('people') !== '0';
const FACES = P?.get('faces') !== '0';
const HOUSE = P?.get('house') !== '0';
const LAMP_SHADOWS = P?.get('lampShadows') || 'map';
const SUN_SHADOWS = P?.get('sunShadows') || 'map';
const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const GROUND = 0.5;
const HEIGHT = 0.866025403784;
const W = 800;
const H = 500;
/** The walls: a front 300 px wide on floor row 400 (screen 200), 80 px tall, and one turned 45 degrees from its east end. */
const WALL_LEFT = 250;
const WALL_RIGHT = 550;
const WALL_FLOOR_Y = 400;
const WALL_TALL = 80;
const TURNED = 120;
/** The people: five `?gap=` floor px in front of the front wall. */
const PEOPLE_FLOOR_Y = WALL_FLOOR_Y + num('gap', 25);
const PEOPLE_X = [310, 360, 410, 460, 520];
const LAMP_X = num('lampX', 410);
const LAMP_FLOOR_Y = num('lampY', 460);
const ELEVATION = num('elevation', 50);
/** `?range=`: the lamp's radius and shadowRange both (default the barrio's: 629 and 260). */
const RANGE = num('range', 0);
const TEXTURE_PX = 8; // _white

export const stressSceneConfig = {
  requested: {
    hour: HOUR, zoom: ZOOM, people: PEOPLE ? 1 : 0, faces: FACES ? 1 : 0, house: HOUSE ? 1 : 0, lampShadows: LAMP_SHADOWS,
    sunShadows: SUN_SHADOWS, lampX: LAMP_X, lampY: LAMP_FLOOR_Y, elevation: ELEVATION, range: RANGE, backend: BACKEND,
  },
};

/** An LPC person facing the camera, as walkers.js draws one: feet on row 62 of 64, 6 % narrower than tall, casting. */
class Person extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

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

/** The house behind the walls: its volume, the convex hull of the box they front (setHull: screen px, floorScaleY 1). */
class House extends GameObject {
  static components = [ShadowCaster];

  onSpawned() {
    const tall = WALL_TALL * HEIGHT;
    const back = -TURNED * GROUND;
    const half = (WALL_RIGHT - WALL_LEFT) / 2;
    const corners = [[-half, 0], [half, 0], [half + TURNED, back], [-half, back]];
    const points = [];
    for (const [x, y] of corners) points.push(x, y, 0, x, y, tall);
    this.shadowCaster.setHull(points, { floorScaleY: 1 });
  }
}

/** The barrio's street lamp light (townObjects.js's Prop): its radius and shadow range. */
class Lamp extends GameObject {
  static components = [LightEmitter];

  onSpawned() {
    this.lightEmitter.color = 0xffe0b0;
    this.lightEmitter.radius = RANGE > 0 ? RANGE : 10 * Math.sqrt(1800 * 2.2);
    this.lightEmitter.elevation = ELEVATION;
    this.lightEmitter.shadowRange = RANGE > 0 ? RANGE : 260;
  }
}

export class WallShadowScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x5ad,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 64 },
    logic: { numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 8 },
    renderer: { backend: BACKEND, ySort: true, atlasScaleMode: 'nearest' },
    camera: { floorScaleY: GROUND, heightScaleY: HEIGHT },
    lighting: {
      enabled: true,
      baseAmbient: 0.04,
      maxLights: 8,
      resolution: 1,
      shadowsEnabled: true,
      sunShadows: SUN_SHADOWS,
      lampShadows: LAMP_SHADOWS,
      selfShadow: true,
      maxShadowCastingLights: 16,
      maxShadowsPerLight: 64,
      maxShadowsPerEntity: 2,
      maxVolumes: 4,
      sun: {
        enabled: true, angle: 135, elevation: 40, intensity: 1, color: 0xfff4e0, shadowAlpha: 0.5, startHour: HOUR,
        shadowAngleOffset: 0, maxElevation: 60, skyLight: 0.5, dayCycle: { enabled: false },
        night: { intensity: 0, color: 0x5473f2, from: 0.4, to: 0.1 },
      },
    },
  };

  static assets = {
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png', heightMap: '/demos/img/civil1_h.png' },
    },
  };

  static entities = [[Person, PEOPLE_X.length], [Lamp, 1], [House, 1]];

  create() {
    Sun.setTimeOfDay(HOUR);
    // The floor: a grey sheet hung from the world's north edge, so its foot is behind everything.
    Decoration.spawn({ x: W / 2, y: 0, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0, tint: 0x6c6a62 });
    const house = HOUSE ? House.spawn({ x: (WALL_LEFT + WALL_RIGHT) / 2, y: WALL_FLOOR_Y * GROUND }) : null;
    const walls = [
      face('front', [WALL_LEFT, WALL_FLOOR_Y, WALL_TALL], [WALL_RIGHT - WALL_LEFT, 0, 0], [0, 0, -WALL_TALL], GROUND, HEIGHT),
      face('turned', [WALL_RIGHT, WALL_FLOOR_Y, WALL_TALL], [TURNED, -TURNED, 0], [0, 0, -WALL_TALL], GROUND, HEIGHT),
    ];
    for (const f of walls) {
      Decoration.spawn({
        x: f.x,
        y: f.y,
        texture: '_white',
        tint: 0xd8cfc0,
        scaleX: f.scaleX / TEXTURE_PX,
        scaleY: f.scaleY / TEXTURE_PX,
        skewX: f.skewX,
        skewY: f.skewY,
        anchorX: 0.5,
        anchorY: 0.5,
        // Sorted by the wall's foot on the screen, as the barrio's walls.
        sortOffsetY: WALL_FLOOR_Y * GROUND - f.y,
        ...(house !== null ? { owner: house } : {}),
        ...(FACES ? { faceNormalX: f.normal[0], faceNormalY: f.normal[1], faceNormalZ: f.normal[2], faceHeight: f.height } : {}),
      });
    }
    if (PEOPLE) for (const x of PEOPLE_X) Person.spawn({ x, y: PEOPLE_FLOOR_Y * GROUND });
    Lamp.spawn({ x: LAMP_X, y: LAMP_FLOOR_Y * GROUND });
    Camera.setZoom(ZOOM);
    Camera.centerOn(W / 2, 200);
  }
}
