import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, GameObject, Collider, DirectionalSprite, ShadowCaster, LightEmitter, Camera, Sun, Decoration, enums } = WEED;
const { ShapeType } = enums;

function queryNumber(key, fallback) {
  const raw = WEED.params?.get(key) ?? null;
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** `?maps=both` (default), `height` (normals from the heights), `normal` (no heights), `0` (no maps: lit as the floor). */
export const MAPS = ['0', 'height', 'normal', 'both'].includes(WEED.params?.get('maps')) ? WEED.params.get('maps') : 'both';
/** `?n=`: shapes (default 600), the load. */
export const N = Math.max(1, Math.floor(queryNumber('n', 600)));
/** `?lights=`: lamps wandering among them (default 12). */
export const LIGHTS = Math.max(0, Math.floor(queryNumber('lights', 12)));
/** `?res=`: lighting.resolution (default 0.5). */
export const RES = queryNumber('res', 0.5);
/** `?hour=`: the sun's hour (default 22, night: the lamps show the normals). */
export const HOUR = queryNumber('hour', 22);
const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
/** `?sunShadows=map`: the sun's shadows from its shadow map (DX-SHADOW3D); default 'sprite'. */
export const SUN_SHADOWS = WEED.params?.get('sunShadows') === 'map' ? 'map' : 'sprite';
/** `?selfShadow=1`: lighting.selfShadow (DX-SELFSHADOW). */
export const SELF_SHADOW = WEED.params?.get('selfShadow') === '1';
const W = 1600;
const H = 1000;
const SHAPES = ['sphere', 'pillar', 'crate'];

export const stressSceneConfig = {
  requested: { maps: MAPS, n: N, lights: LIGHTS, res: RES, hour: HOUR, backend: BACKEND, sunShadows: SUN_SHADOWS, selfShadow: SELF_SHADOW ? 1 : 0 },
};

/** A shape of tests/bench/stressScenes/maps (ray-traced at pitch 45 from 8 directions: makeShapes.mjs), turned as it faces. */
class Shape extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ shape = 0, facing = Math.PI / 2 } = {}) {
    this.setSpritesheet('shapes');
    // Drawn from 8 directions (the sheet's json says so): it shows the one it faces, its sun shadow the one the sun sees.
    this.directionalSprite.facing = facing;
    this.setAnimation(SHAPES[shape % SHAPES.length]);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.75;
  }
}

/** A lamp 40 px above the floor that walks a slow circle. */
class Lamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ cx = 0, cy = 0, r = 100, phase = 0, color = 0xffe0b0 } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.lightEmitter.color = color;
    this.lightEmitter.radius = 520;
    this.lightEmitter.elevation = 40;
    this.cx = cx;
    this.cy = cy;
    this.r = r;
    this.phase = phase;
  }

  tick(dtRatio, dt) {
    this.phase += (dt || 16.7) * 0.0004;
    this.setPosition(this.cx + Math.cos(this.phase) * this.r, this.cy + Math.sin(this.phase) * this.r * 0.7);
  }
}

const sheet = { json: '/tests/bench/stressScenes/maps/shapes.json', png: '/tests/bench/stressScenes/maps/shapes.png' };
if (MAPS === 'height' || MAPS === 'both') sheet.heightMap = '/tests/bench/stressScenes/maps/shapes_h.png';
if (MAPS === 'normal' || MAPS === 'both') sheet.normalMap = '/tests/bench/stressScenes/maps/shapes_n.png';

/**
 * DX-MAPS / DX-GBUF's owner scene: N ray-traced shapes (a sphere, a pillar, a crate) at night under wandering lamps, with
 * their height and normal maps (`?maps=`). A sprite with maps is lit as the surface they say: the side of a sphere away
 * from a lamp stays dark. The primaries are the presented frames and Pixi (the faces' pass draws every sprite again).
 */
export class SpriteMapsStressScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x3a95,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 4 },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, maxVisibleRenderables: N + 64 },
    preRender: { noLimitFPS: false },
    camera: { pitch: 45 },
    lighting: {
      enabled: true,
      baseAmbient: 0.06,
      maxLights: Math.max(16, LIGHTS + 4),
      resolution: RES,
      shadowsEnabled: true,
      sunShadows: SUN_SHADOWS,
      selfShadow: SELF_SHADOW,
      sun: { enabled: true, angle: 135, elevation: 40, intensity: 1, startHour: HOUR, dayCycle: { enabled: false } },
    },
  };

  static assets = { spritesheets: { shapes: sheet } };
  static entities = [[Shape, N], [Lamp, LIGHTS]];

  create() {
    Sun.setTimeOfDay(HOUR);
    Camera.setZoom(1);
    Camera.centerOn(W / 2, H / 2);
    // The floor: a grey sheet under everything, for the shadows to fall on.
    Decoration.spawn({ x: W / 2, y: H / 2, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0.5, tint: 0x8c8a80, sortOffsetY: -H });
    const rng = mulberry32(0x5ba9e);
    const cols = Math.ceil(Math.sqrt((N * W) / H));
    const rows = Math.ceil(N / cols);
    for (let k = 0; k < N; k++) {
      const c = k % cols;
      const r = (k / cols) | 0;
      Shape.spawn({ x: ((c + 0.5) * W) / cols + (rng() - 0.5) * 20, y: ((r + 0.5) * H) / rows + (rng() - 0.5) * 20, shape: k, facing: rng() * Math.PI * 2 });
    }
    const colors = [0xffe0b0, 0xb0d0ff, 0xffb0c0, 0xc0ffb0];
    for (let k = 0; k < LIGHTS; k++) {
      Lamp.spawn({ cx: rng() * W, cy: rng() * H, r: 60 + rng() * 140, phase: rng() * 6.28, color: colors[k % colors.length] });
    }
  }
}
