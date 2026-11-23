import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, GameObject, SpriteRenderer, LightEmitter } = WEED;

/**
 * DX-GLOWBENCH: lights with a halo, many of them, at night. Each lamp is a sprite with a small light and a halo on its
 * bulb, drifting slowly (its halo moves with it, so every frame re-sorts it). `?glowMode=sorted` (the default): the halos
 * join the entities, each right after its lamp's sprite, unshaded (DX-GLOWRADIUS: a sort key a halo, and the unshaded
 * pass on); `?glowMode=add`: the halos in the lightGlows layer, additive, over everything: the arm to read it against.
 *
 * `?lamps=` (default 2000), `?glowRadius=` px (default 35, the glow one sees: E-498's compact glow; 0 sizes it from the light, about 0.14 of its radius),
 * `?radius=` the lights' reach (default 90), `?resolution=` (lighting.resolution, default 0.5), `?backend=webgpu`.
 * `?drift=` px a second the lamps drift (default 20; 0 for captures). `?halo=decoration`: each lamp's halo is a
 * decoration attached to it (the compact glow's texture at the halo's size, alpha and tint, lifted as glowOffsetY lifts it)
 * and the light draws none: halos as decorations against the light's halo rows.
 * Owner workers: pre-render (the halo rows and their keys) and Pixi (the unshaded pass with 'sprite').
 */
function query(key) {
  return WEED.params?.get(key) ?? null;
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const LAMPS = Math.max(1, Math.floor(queryNumber('lamps', 2000)));
const GLOW_MODE = query('glowMode') === 'add' ? 'add' : 'sorted';
const GLOW_RADIUS = Math.max(0, queryNumber('glowRadius', 35));
const RADIUS = queryNumber('radius', 90);
const RESOLUTION = queryNumber('resolution', 0.5);
const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const HALO_DECORATION = query('halo') === 'decoration';
/** The halo: its alpha, lift (px) and radius (px; the compact glow's texture is 200 px across). */
const HALO_ALPHA = 0.6;
const HALO_LIFT = -24;
const WORLD_W = 2560;
const WORLD_H = 1440;
const SEED = 0x6105;
/** px a second the lamps drift (`?drift=0`: still, for captures). */
const DRIFT = queryNumber('drift', 20);

export const stressSceneConfig = {
  requested: {
    lamps: LAMPS, glowMode: GLOW_MODE, glowRadius: GLOW_RADIUS, radius: RADIUS, resolution: RESOLUTION, backend: BACKEND,
    halo: HALO_DECORATION ? 'decoration' : 'light',
  },
};

class GlowLamp extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  /** px a second it drifts (doubles from the start: a Smi field written a fraction later changes the object's map). */
  driftX = NaN;
  driftY = NaN;

  onSpawned(config = {}) {
    this.setSprite('box');
    this.setScale(0.12, 0.3);
    // A lamp post's anchor sits above its foot, as the barrio's do (the case DX-GLOWRADIUS's sort fixed).
    this.spriteRenderer.anchorY = 0.85;
    const light = this.lightEmitter;
    const color = config.color ?? 0xffd59a;
    light.color = color;
    light.radius = RADIUS;
    light.elevation = 20;
    light.castShadows = 0;
    if (HALO_DECORATION) {
      // In front of the lamp's own sprite (zIndex 1), as a sorted halo row sorts right after it.
      const size = GLOW_RADIUS / 100;
      this.addDecoration('_lightGlow', 0, HALO_LIFT, size, size, 1, { alpha: HALO_ALPHA, tint: color, anchorX: 0.5, anchorY: 0.5 });
    } else {
      light.glow = HALO_ALPHA;
      light.glowRadius = GLOW_RADIUS;
      light.glowOffsetY = HALO_LIFT;
    }
    this.driftX = config.driftX ?? 0;
    this.driftY = config.driftY ?? 0;
  }

  tick(dtRatio) {
    let x = this.x + this.driftX * dtRatio / 60;
    let y = this.y + this.driftY * dtRatio / 60;
    if (x < 0 || x > WORLD_W) this.driftX = -this.driftX;
    if (y < 0 || y > WORLD_H) this.driftY = -this.driftY;
    x = Math.min(WORLD_W, Math.max(0, x));
    y = Math.min(WORLD_H, Math.max(0, y));
    this.x = x;
    this.y = y;
  }
}

export class GlowStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { enabled: false },
    decoration: { maxDecorations: HALO_DECORATION ? LAMPS : 0 },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true },
    lighting: {
      enabled: true,
      lightGlow: GLOW_MODE,
      baseAmbient: 0.05,
      maxLights: Math.max(64, LAMPS + 16),
      shadowsEnabled: false,
      resolution: RESOLUTION,
      sun: { enabled: true, intensity: 0, startHour: 22 },
    },
  };

  static assets = { textures: { box: '/demos/img/box_100_100.png' } };

  static entities = [[GlowLamp, LAMPS]];

  create() {
    const rng = mulberry32(SEED);
    for (let i = 0; i < LAMPS; i++) {
      const angle = rng() * Math.PI * 2;
      GlowLamp.spawn({
        x: rng() * WORLD_W,
        y: rng() * WORLD_H,
        driftX: Math.cos(angle) * DRIFT,
        driftY: Math.sin(angle) * DRIFT,
        color: rng() < 0.5 ? 0xffd59a : 0xbfe0ff,
      });
    }
    Camera.setZoom(0.5);
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
  }
}
