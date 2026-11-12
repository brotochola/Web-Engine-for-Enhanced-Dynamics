import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { faceLightLayout } from './faces/faceLightLayout.js';

const { Scene, Camera, Sun, Decoration, GameObject, LightEmitter, Collider, enums } = WEED;
const { ShapeType } = enums;

/**
 * lighting.faces (DX-FACES) on plain white faces, still, so that every pixel is the light itself: faceLightCheck.mjs
 * samples the canvas against the formula. The layout, with what each face and lamp is, is in faces/faceLightLayout.js.
 *
 * `?faces=0` turns the map off (the same sprites, lit as the floor), `?hour=` (default 22), `?resolution=` (default 1),
 * `?wrap=`, `?gain=`, `?sunDirect=`, `?groundScaleY=` (default 0.5), `?heightScaleY=` (default 0.866),
 * `?backend=webgpu`, `?columns=` and `?rows=` (default 1): the layout that many times over, the load for a measurement.
 * The sprite paths, one key each: `?ySort=0`, `?indexed=0`, `?interpolation=1`, `?nearest=1` (the plain rows), `?pack=pixi`
 * (keyed frames on WebGL). The load for a measurement: `?town=` that many small faces on the screen, `?lamps=` that many more
 * lamps (at most 56).
 */
function query(key) {
  return WEED.params?.get(key) ?? null;
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const HOUR = queryNumber('hour', 22);
const FACES = query('faces') !== '0';
const RESOLUTION = queryNumber('resolution', 1);
const GROUND = queryNumber('groundScaleY', 0.5);
const HEIGHT = queryNumber('heightScaleY', 0.866);
const TOWN = Math.max(0, Math.floor(queryNumber('town', 0)));
const LAMPS = Math.min(56, Math.max(0, Math.floor(queryNumber('lamps', 0))));
const COLUMNS = Math.max(1, Math.floor(queryNumber('columns', 1)));
const ROWS = Math.max(1, Math.floor(queryNumber('rows', 1)));
const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const CELL_W = 1280;
const CELL_H = 720;
const TEXTURE_PX = 8; // _white
const LAYOUT = faceLightLayout(GROUND, HEIGHT);

export const stressSceneConfig = {
  requested: { hour: HOUR, faces: FACES ? 1 : 0, resolution: RESOLUTION, columns: COLUMNS, rows: ROWS, town: TOWN, lamps: LAMPS, backend: BACKEND },
};

class FaceLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.collider.visualRange = 900;
    this.lightEmitter.color = 0xffffff;
    this.lightEmitter.radius = config.radius ?? 630;
    this.lightEmitter.elevation = config.elevation ?? 0;
  }
}

export class FaceLightScene extends Scene {
  static config = {
    worldWidth: CELL_W * COLUMNS,
    worldHeight: CELL_H * ROWS,
    seed: 11,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 256 * COLUMNS * ROWS + TOWN },
    renderer: {
      backend: BACKEND,
      ySort: query('ySort') !== '0',
      indexedSprites: query('indexed') !== '0',
      interpolation: query('interpolation') === '1',
      atlasScaleMode: query('nearest') === '1' ? 'nearest' : 'linear',
      noLimitFPS: false,
      maxVisibleRenderables: 8000 + TOWN,
    },
    preRender: { noLimitFPS: false, ...(query('pack') === 'pixi' ? { packGpuSprites: 'pixi', sortSprites: 'pixi' } : {}) },
    lighting: {
      enabled: true,
      baseAmbient: 0.1,
      maxLights: 64,
      groundScaleY: GROUND,
      resolution: RESOLUTION,
      faces: {
        enabled: FACES,
        heightScaleY: HEIGHT,
        wrap: queryNumber('wrap', 0),
        gain: queryNumber('gain', 1),
        sunDirect: queryNumber('sunDirect', 0.6),
      },
      sun: { enabled: true, angle: 135, elevation: 40, intensity: 1, startHour: HOUR, dayCycle: { enabled: false } },
    },
  };
  static assets = { textures: {} };
  static entities = [[FaceLamp, 8 * COLUMNS * ROWS + LAMPS]];

  create() {
    Sun.setTimeOfDay(HOUR);
    const rng = mulberry32(0xfaced);
    const s = Math.SQRT1_2;
    const looks = [[0, 1, 0], [s, s, 0], [-s, s, 0], [0, 0, 1]];
    for (let i = 0; i < TOWN; i++) {
      const look = looks[i & 3];
      Decoration.spawn({
        x: rng() * CELL_W,
        y: rng() * CELL_H,
        texture: '_white',
        scaleX: 2,
        scaleY: 2,
        anchorX: 0.5,
        anchorY: 0.5,
        faceNormalX: look[0],
        faceNormalY: look[1],
        faceNormalZ: look[2],
        faceHeight: 20,
      });
    }
    for (let i = 0; i < LAMPS; i++) {
      FaceLamp.spawn({ x: rng() * CELL_W, y: rng() * CELL_H, radius: 550, elevation: 40 });
    }
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLUMNS; cx++) {
        const dx = cx * CELL_W;
        const dy = cy * CELL_H;
        Decoration.spawn({
          x: dx + CELL_W / 2,
          y: dy + CELL_H / 2,
          texture: '_white',
          scaleX: (CELL_W + 8) / TEXTURE_PX,
          scaleY: (CELL_H + 8) / TEXTURE_PX,
          anchorX: 0.5,
          anchorY: 0.5,
          sortOffsetY: -CELL_H,
        });
        for (const f of LAYOUT.faces) {
          Decoration.spawn({
            x: dx + f.x,
            y: dy + f.y,
            texture: '_white',
            scaleX: f.scaleX / TEXTURE_PX,
            scaleY: f.scaleY / TEXTURE_PX,
            skewX: f.skewX,
            skewY: f.skewY,
            anchorX: 0.5,
            anchorY: 0.5,
            sortOffsetY: f.sortOffsetY,
            faceNormalX: f.normal[0],
            faceNormalY: f.normal[1],
            faceNormalZ: f.normal[2],
            faceHeight: f.height,
          });
        }
        for (const l of LAYOUT.lamps) {
          FaceLamp.spawn({ x: dx + l.x, y: dy + l.y * GROUND, radius: l.radius, elevation: l.elevation });
        }
      }
    }
    Camera.centerOn(FaceLightScene.config.worldWidth * 0.5, FaceLightScene.config.worldHeight * 0.5);
  }
}
