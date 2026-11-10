import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, GameObject, MeshRenderer, VolumeShadowCaster, LightEmitter, Collider, Sun, LAYER_KIND, enums } = WEED;
const { ShapeType } = enums;

/**
 * DX-VOLUME's ruler: a town of volumes, the same picture written two ways. `?api=mesh` is what a game writes by hand: a mesh
 * with heights per house on a sunProjected layer, a car rebuilt on the CPU as it turns, at most every 2 degrees. `?api=volume`
 * is the component. Houses have a tank on the roof, cars a cabin on a body.
 *
 * `?n=` (default 20000) houses, `?cars=` (default 200) cars that go round, `?lights=` (default 0) lamps, `?hour=` (default 9),
 * `?dayMinutes=` (default 1, 0 stops the sun), `?still=1` stops the cars at spread headings, for byte comparisons,
 * `?floor=` (default 0.7) how tall the cars' floor is drawn, `?houseFloor=` (default 1) the houses', `?backend=webgpu`. Primary: the renderer's STEP_MS. Load: MESH_RT_DRAWS.
 */
const SEED = 0x701;
const WORLD_W = 6000;
const WORLD_H = 4000;

// WEED.params, not location: a worker's location is its script's, and the classes must agree on every thread.
function query(key) {
  return WEED.params?.get(key) ?? null;
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const N = Math.max(1, Math.floor(queryNumber('n', 20000)));
export const CARS = Math.max(0, Math.floor(queryNumber('cars', 200)));
export const LIGHTS = Math.max(0, Math.floor(queryNumber('lights', 0)));
export const HOUR = queryNumber('hour', 9);
export const DAY_MINUTES = queryNumber('dayMinutes', 1);
export const STILL = queryNumber('still', 0) === 1;
export const API = query('api') === 'volume' ? 'volume' : 'mesh';
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const CAR_FLOOR = queryNumber('floor', 0.7);
const HOUSE_FLOOR = queryNumber('houseFloor', 1);
export const stressSceneConfig = {
  requested: { n: N, cars: CARS, lights: LIGHTS, hour: HOUR, dayMinutes: DAY_MINUTES, still: STILL ? 1 : 0, api: API, backend: BACKEND },
};

const box = (hw, hd, cx = 0, cy = 0) => [cx - hw, cy - hd, cx + hw, cy - hd, cx + hw, cy + hd, cx - hw, cy + hd];
const ring = (n, rx, ry, cx, cy) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return out;
};

/** The shape as levels: [outline, bottom, height, top outline]. */
const houseLevels = (hw, hd, h) => [[box(hw, hd), 0, h, box(hw, hd)], [ring(6, hw * 0.3, hd * 0.3, -hw * 0.4, 0), h, h * 1.3, ring(6, hw * 0.3, hd * 0.3, -hw * 0.4, 0)]];
const CAR_LEVELS = [[box(39, 19), 0, 13, box(39, 19)], [box(23, 17, -7), 13, 27, box(12, 13, -10)]];

/** What setBox and addLevel write, by hand: rings, then each level's roof and sides. A game's addPrism. */
function meshOf(levels) {
  const xy = [];
  const heights = [];
  const indices = [];
  for (const [outline, bottom, height, top] of levels) {
    const n = outline.length / 2;
    const first = heights.length;
    for (let p = 0; p < n * 2; p++) heights.push(p < n ? bottom : height);
    xy.push(...outline, ...top);
    for (let i = 1; i < n - 1; i++) indices.push(first + n, first + n + i, first + n + i + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(first + i, first + j, first + n + j, first + i, first + n + j, first + n + i);
    }
  }
  return { xy, heights, indices };
}

const carMesh = meshOf(CAR_LEVELS);

class MeshHouse extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.setLayer('shadows');
    this.meshRenderer.tint = 0x000000;
    const { xy, heights, indices } = meshOf(houseLevels(config.hw, config.hd, config.h));
    for (let p = 1; p < xy.length; p += 2) xy[p] *= HOUSE_FLOOR;
    this.meshRenderer.setMesh(xy, indices);
    this.meshRenderer.setHeights(heights);
  }
}

class MeshCar extends GameObject {
  static components = [MeshRenderer];

  angle = 0;
  radius = 0;
  cx = 0;
  cy = 0;
  speed = 0;
  headingC = NaN;
  headingS = NaN;
  xy = new Float32Array(carMesh.xy.length);

  onSpawned(config = {}) {
    Object.assign(this, config);
    this.setLayer('shadows');
    this.meshRenderer.tint = 0x000000;
    this.meshRenderer.setMesh(carMesh.xy, carMesh.indices);
    this.meshRenderer.setHeights(carMesh.heights);
    this.place();
  }

  place() {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    this.x = this.cx + c * this.radius;
    this.y = this.cy + s * this.radius * 0.6;
    this.rotation = this.angle + Math.PI / 2;
    this.face(Math.cos(this.rotation), Math.sin(this.rotation));
  }

  /** The footprint on a flattened floor, written in the frame the shader turns by (c, s): the game's cajaAuto. */
  face(c, s) {
    if (c * this.headingC + s * this.headingS > 0.9994) return;
    this.headingC = c;
    this.headingS = s;
    const length = Math.sqrt(CAR_FLOOR * CAR_FLOOR * c * c + s * s);
    const fc = (CAR_FLOOR * c) / length;
    const fs = s / length;
    const from = carMesh.xy;
    const to = this.xy;
    for (let p = 0; p < from.length; p += 2) {
      const x = from[p] * fc - from[p + 1] * fs;
      const y = CAR_FLOOR * (from[p] * fs + from[p + 1] * fc);
      to[p] = x * c + y * s;
      to[p + 1] = -x * s + y * c;
    }
    this.meshRenderer.setVertices(to);
  }

  tick(dtRatio) {
    if (STILL) return;
    this.angle += this.speed * dtRatio;
    this.place();
  }
}

class VolumeHouse extends GameObject {
  static components = [VolumeShadowCaster];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.volumeShadowCaster.floorScaleY = HOUSE_FLOOR;
    for (const [outline, bottom, height, top] of houseLevels(config.hw, config.hd, config.h)) {
      this.volumeShadowCaster.addLevel(outline, bottom, height, top);
    }
  }
}

class VolumeCar extends GameObject {
  static components = [VolumeShadowCaster];

  angle = 0;
  radius = 0;
  cx = 0;
  cy = 0;
  speed = 0;

  onSpawned(config = {}) {
    Object.assign(this, config);
    this.volumeShadowCaster.floorScaleY = CAR_FLOOR;
    for (const [outline, bottom, height, top] of CAR_LEVELS) this.volumeShadowCaster.addLevel(outline, bottom, height, top);
    this.place();
  }

  place() {
    this.x = this.cx + Math.cos(this.angle) * this.radius;
    this.y = this.cy + Math.sin(this.angle) * this.radius * 0.6;
    this.rotation = this.angle + Math.PI / 2;
  }

  tick(dtRatio) {
    if (STILL) return;
    this.angle += this.speed * dtRatio;
    this.place();
  }
}

class StressLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.collider.visualRange = 300;
    this.lightEmitter.lightColor = 0xffe2b0;
    this.lightEmitter.lightIntensity = 9000;
    this.lightEmitter.active = 1;
  }
}

const houseClass = () => (API === 'volume' ? VolumeHouse : MeshHouse);
const carClass = () => (API === 'volume' ? VolumeCar : MeshCar);

export class VolumeStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: BACKEND,
      noLimitFPS: false,
      ...(API === 'mesh' ? { maxMeshVerts: N * 20 + CARS * 16 + 64, maxMeshIndices: N * 72 + CARS * 96 + 64 } : {}),
    },
    layers: {
      ground: { kind: LAYER_KIND.COVER, texture: '_white', zIndex: 0 },
      ...(API === 'mesh' ? { shadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, sunProjected: true } } : {}),
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.3,
      maxLights: Math.max(10, LIGHTS),
      ...(API === 'volume' ? { maxVolumeVerts: 20 } : {}),
      sun: { enabled: true, startHour: HOUR, shadowAlpha: 0.6, dayCycle: { enabled: DAY_MINUTES > 0, speed: 1, dayDurationMinutes: DAY_MINUTES || 1 } },
    },
  };

  static entities = [[houseClass(), N], [carClass(), CARS], ...(LIGHTS > 0 ? [[StressLamp, LIGHTS]] : [])];

  create() {
    const rng = mulberry32(SEED);
    const House = houseClass();
    const Car = carClass();
    for (let i = 0; i < N; i++) {
      House.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H, hw: 14 + rng() * 40, hd: 10 + rng() * 26, h: 20 + rng() * 80 });
    }
    for (let i = 0; i < CARS; i++) {
      Car.spawn({ cx: rng() * WORLD_W, cy: rng() * WORLD_H, radius: 80 + rng() * 300, angle: (i / Math.max(1, CARS)) * Math.PI * 2, speed: 0.004 + rng() * 0.01 });
    }
    for (let i = 0; i < LIGHTS; i++) StressLamp.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H });
    Sun.setTimeOfDay(HOUR);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(STILL ? 1 : 0.5);
  }
}
