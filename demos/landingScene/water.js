// water.js – chapter 1: a lake under a cliff, fed by a spring that gushes out of the cliff's face and falls into it.
// LiquidFun particles, drawn by one density layer with a WGSL look (shaders/water.wgsl). The world has no gravity
// (the title's bricks hold their places without it): the particles fall toward a point far below the world
// (LiquidFun.setRadialGravity), so they all fall straight down, and bodies that should fall add gravity in their
// own ticks (fall()). A click above the water drops a crate; holding inside it stirs the lake with an invisible paddle.
// The falling stream is GPU particles: LiquidFun particles in free fall spread too thin to show, so streaks and mist
// draw the waterfall while the real particles land in the lake and ripple it.

import { FX_SMOKE } from './fx.js';
import { groundY } from './terrain.js';

const {
  GameObject,
  RigidBody,
  Collider,
  SpriteRenderer,
  Mouse,
  ParticleEmitter,
  PARTICLE_EASE,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} = WEED;

export const WATER_LAYER = 'water';
/** Gravity (px/s²) for what falls: water, crates, props. */
export const GRAVITY = 2400;
/** LiquidFun's particle radius (px); the splat is about three of them. */
export const WATER_RADIUS = 5;

/** Bodies that fall call this every tick: the world itself has no gravity. */
export function fall(entity) {
  entity.addAcceleration(0, GRAVITY);
}

/** The water layer, for a scene's static config.layers. */
export function waterLayer() {
  return {
    zIndex: 3.3,
    blendMode: BLEND_MODES.NORMAL,
    resolution: 1,
    scaleMode: LAYER_SCALE_MODE.LINEAR,
    maxItems: 0,
    ySorting: false,
    shader: {
      fragment: 'landingWater',
      containerBlend: BLEND_MODES.ADD,
      densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
      splat: { radius: WATER_RADIUS * 3.4, falloff: LAYER_SPLAT_FALLOFF.QUADRATIC, useParticleTint: true, intensity: 0.2 },
      uniforms: {
        uThreshold: { value: 0.3, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Threshold' },
        uDay: { value: 0.5, type: 'f32' },
      },
    },
  };
}

/** The look's shader, for a scene's static assets.shaders. */
export const waterAssets = {
  shaders: { landingWater: new URL('./shaders/water.wgsl', import.meta.url).href },
};

/** An invisible paddle: while the pointer is held inside the lake it chases the pointer and stirs the water. */
export class Paddle extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({ x0 = 0, x1 = 0, y0 = 0, y1 = 0, parkX = 0, parkY = 0 } = {}) {
    this.collider.radius = 22;
    this.rigidBody.linearDamping = 4;
    this.x0 = x0;
    this.x1 = x1;
    this.y0 = y0;
    this.y1 = y1;
    this.parkX = parkX;
    this.parkY = parkY;
    this.parked = true;
  }

  tick() {
    const inside =
      Mouse.isButton0Down && Mouse.x > this.x0 && Mouse.x < this.x1 && Mouse.y > this.y0 && Mouse.y < this.y1;
    if (inside) {
      if (this.parked) {
        this.setPosition(Mouse.x, Mouse.y);
        this.parked = false;
      }
      // Toward the pointer, no faster than a hand stirs: fast paddles slop the lake over its rim.
      let vx = (Mouse.x - this.x) * 6;
      let vy = (Mouse.y - this.y) * 6;
      const v = Math.sqrt(vx * vx + vy * vy);
      if (v > 700) {
        vx *= 700 / v;
        vy *= 700 / v;
      }
      this.setVelocity(vx, vy);
    } else if (!this.parked) {
      this.setPosition(this.parkX, this.parkY);
      this.setVelocity(0, 0);
      this.parked = true;
    }
  }
}

/** A floating thing: a crate or a log, lighter than water. */
export class Floater extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned({ kind = 'crate', size = 50 } = {}) {
    const log = kind === 'log';
    const w = log ? size * 2.4 : size;
    const h = log ? size * 0.36 : size;
    this.setSprite(log ? '_white' : 'campCrate');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(w, h);
    this.setTint(log ? 0x6b4a2c : 0xffffff);
    this.collider.width = w * 0.96;
    this.collider.height = h * 0.96;
    this.collider.friction = 0.5;
    this.collider.restitution = 0.1;
    this.rigidBody.linearDamping = 0.2;
    this.rigidBody.angularDamping = 0.4;
    this.rigidBody.mass = w * h * 0.45; // after the geometry: lighter than water, so it floats
  }

  tick() {
    fall(this);
  }
}

/** Page only: fills the lake, runs the spring, drops crates. */
export class Waterworks {
  constructor(left, width, height, unit) {
    this.left = left; // the chapter's left edge, in world px
    this.width = width;
    this.height = height;
    this.unit = unit;
    const W = width;
    // The lake (terrain.js): from the cliff's foot to the rim on the right; the level a little under the rim.
    this.lakeX0 = left + W * 0.33;
    this.lakeX1 = left + W * 0.86;
    this.level = height * 0.83;
    // Just past the cliff's edge, a little under its top: the water gushes out of the rock and falls.
    this.springX = left + W * 0.305;
    this.springY = groundY(left + W * 0.3, width, height) + 26;
    this.springMs = 0;
    this.drops = [];
    // The waterfall's look: streaks falling under gravity (px per frame²) from the spring, mist where they land.
    const g = GRAVITY / 3600;
    const drop = this.level - this.springY;
    const fallFrames = Math.sqrt((2 * drop) / g);
    const vx = 2.4; // px per frame
    this.streaksOwed = 0;
    this.mistOwed = 0;
    this.streaks = {
      layer: FX_SMOKE, count: 0, x: { min: this.springX - 3, max: this.springX + 3 }, y: this.springY,
      vx: { min: vx * 0.85, max: vx * 1.15 }, vy: { min: 0.5, max: 1.5 }, gravity: g,
      lifespan: { min: fallFrames * 16.7 * 0.92, max: fallFrames * 16.7 }, texture: 'fxGlow',
      scaleX: { from: 0.1, to: 0.16 }, scaleY: { from: 0.18, to: 0.5 },
      alpha: { from: 0.55, to: 0.35 }, tint: { from: 0xe8f8ff, to: 0xa8dcf4 },
    };
    const landX = this.springX + vx * fallFrames;
    this.mist = {
      layer: FX_SMOKE, count: 0, x: { min: landX - 16, max: landX + 16 }, y: { min: this.level + 14, max: this.level + 24 },
      angleXY: { min: 200, max: 340 }, speed: { min: 0.4, max: 1.6 }, drag: 1.5, gravity: -0.004,
      lifespan: { min: 700, max: 1300 }, rotation: { min: 0, max: 360 }, texture: 'fxPuff',
      scale: { from: 0.15, to: 0.55, ease: PARTICLE_EASE.QUAD_OUT },
      alpha: { from: 0.4, to: 0, ease: PARTICLE_EASE.QUAD_IN }, tint: 0xf2fbff,
    };
  }

  /** Gravity for the particles, the lake, a log and two crates floating on it, the paddle. */
  spawn(worldWidth) {
    // A point far below the world: every particle falls straight down at GRAVITY.
    LiquidFun.setRadialGravity(worldWidth / 2, 1e7, GRAVITY);
    const strip = 24;
    for (let x = this.lakeX0; x < this.lakeX1; x += strip) {
      const cx = x + strip / 2;
      const bottom = groundY(cx, this.width, this.height) - WATER_RADIUS * 2;
      if (bottom <= this.level) continue;
      LiquidFun.emit({
        shape: 'box',
        posX: cx,
        posY: (this.level + bottom) / 2,
        halfWidth: strip / 2,
        halfHeight: (bottom - this.level) / 2,
        flags: LIQUIDFUN_FLAGS.WATER,
        tint: 0x2a8ec8,
        layers: [WATER_LAYER],
      });
    }
    const s = Math.max(30, 46 * this.unit);
    const mid = (this.lakeX0 + this.lakeX1) / 2;
    Floater.spawn({ x: mid - s * 2, y: this.level - s, kind: 'log', size: s });
    Floater.spawn({ x: mid + s * 1.5, y: this.level - s, kind: 'crate', size: s });
    Floater.spawn({ x: mid + s * 3.6, y: this.level - s * 1.5, kind: 'crate', size: s * 0.8 });
    Paddle.spawn({
      x: this.left + 30,
      y: -500,
      x0: this.lakeX0 - 20,
      x1: this.lakeX1 + 20,
      y0: this.level - 60,
      y1: this.height,
      parkX: this.left + 30,
      parkY: -500,
    });
  }

  /** The spring runs while the lake is near the camera. */
  update(deltaMs, near) {
    if (!near) return;
    this.streaksOwed = this.emitGpu(this.streaks, this.streaksOwed + deltaMs * 0.16);
    this.mistOwed = this.emitGpu(this.mist, this.mistOwed + deltaMs * 0.03);
    this.springMs += deltaMs;
    // Real water too, a gush at a time: it lands in the lake and ripples it.
    while (this.springMs >= 90) {
      this.springMs -= 90;
      LiquidFun.emit({
        shape: 'box',
        posX: this.springX,
        posY: this.springY,
        halfWidth: 6,
        halfHeight: 9,
        vx: 144,
        vy: 30,
        flags: LIQUIDFUN_FLAGS.WATER,
        lifespan: { min: 4500, max: 5500 }, // ms
        fadeToAlpha0: true,
        tint: 0x3aa6e0,
        layers: [WATER_LAYER],
      });
    }
  }

  emitGpu(cfg, owed) {
    const n = Math.floor(owed);
    if (n > 0) {
      cfg.count = n;
      ParticleEmitter.emitGpu(cfg);
    }
    return owed - n;
  }

  /** A click: above the water drops a crate; inside it, the paddle stirs (Paddle.tick). */
  click(x, y) {
    if (y > this.level - 30 && x > this.lakeX0 && x < this.lakeX1) return;
    const s = Math.max(28, (36 + Math.random() * 24) * this.unit);
    const crate = Floater.spawn({ x, y, kind: Math.random() < 0.25 ? 'log' : 'crate', size: s, rotation: Math.random() });
    if (!crate) return;
    this.drops.push(crate);
    if (this.drops.length > 10) Floater.despawn(this.drops.shift());
  }
}
