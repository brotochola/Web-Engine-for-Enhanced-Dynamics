/**
 * What the still scenes of DX-LIGHT3D's checks share (plan §8.2): the bench page's knobs, a config with one worker each
 * and the checks' camera (pitch 45, the art's: checkShapes.js), a white floor under everything (a cover layer: floor to
 * the light pass, never a standing sprite), the checks' art as spritesheets, a lamp, and the sun turned to come from a
 * given direction at a given hour. Written against DX-LIGHT3D's API (plan §5): `camera.pitch`, a caster lists only
 * ShadowCaster, `spriteRenderer.emissive`.
 */
import WEED from '/src/index.js';
import { ART_URL, SHEETS } from './layouts.js';

const { GameObject, Collider, LightEmitter, LAYER_KIND, enums } = WEED;
const { ShapeType } = enums;

export function param(key) {
  return WEED.params?.get(key) ?? null;
}

export function num(key, fallback) {
  const raw = param(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const BACKEND = param('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const WORLD_W = 1280;
export const WORLD_H = 720;

/** A sheet of the checks' art (tests/bench/checks/art, makeCheckArt.mjs), with its height and normal maps if it has them. */
export function sheet(name) {
  const s = { json: `${ART_URL}${name}.json`, png: `${ART_URL}${name}.png` };
  if (SHEETS[name]?.maps) {
    s.heightMap = `${ART_URL}${name}_h.png`;
    s.normalMap = `${ART_URL}${name}_n.png`;
  }
  return s;
}

/**
 * A still scene's config: the world is the canvas (1280 x 720, the camera centred, zoom 1, so a world px is a screen px),
 * the checks' camera, the light pass and the shadows at the canvas's own size, and `lighting`, `renderer`, `layers` over it.
 */
export function checkConfig({ lighting = {}, renderer = {}, layers = {} } = {}) {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true, interpolation: false, noLimitFPS: false, ...renderer },
    preRender: { noLimitFPS: false },
    camera: { pitch: 45 },
    layers: { ground: { kind: LAYER_KIND.COVER, texture: '_white', zIndex: 0 }, ...layers },
    lighting: { enabled: true, resolution: 1, shadowResolution: 1, maxLights: 16, ...lighting },
  };
}

/**
 * Sun.shadowAngleOffset (radians) that puts the sun towards `towardsDeg` (the screen's angle, y down: 0 east, 90 south,
 * 225 the upper left) at `hour`, where setTimeOfDay puts its bearing at (hour / 24 - 0.25) · 360 degrees.
 */
export function sunOffsetFor(hour, towardsDeg) {
  const angle = (((hour / 24 - 0.25) * 360) % 360 + 360) % 360;
  return ((towardsDeg - angle) * Math.PI) / 180;
}

/** The sun's config for a check: on, still at `hour`, turned to `towards`, no night light, the given shadow alpha. */
export function sunConfig({ hour, towards, shadowAlpha = 1 }) {
  return {
    enabled: true,
    startHour: hour,
    shadowAngleOffset: sunOffsetFor(hour, towards),
    shadowAlpha,
    shadowStretchAlphaFactor: 0,
    dayCycle: { enabled: false },
    night: { intensity: 0 },
  };
}

/** A lamp: a LightEmitter at a height. */
export class CheckLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ radius = 400, elevation = 60, brightness = 1, color = 0xffffff, castShadows = false } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.lightEmitter.shadowRange = 2000;
    Object.assign(this.lightEmitter, { radius, elevation, brightness, color, castShadows });
  }
}

/** The sprite's anchor at its frame's foot (the art's frames put the shape's origin there). */
export function anchorAtFoot(go, frame) {
  go.spriteRenderer.anchorX = frame.footX / frame.w;
  go.spriteRenderer.anchorY = frame.footY / frame.h;
}
