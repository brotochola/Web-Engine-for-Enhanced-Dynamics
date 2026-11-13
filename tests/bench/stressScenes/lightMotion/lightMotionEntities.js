import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightOccluder, Flash, enums } = WEED;
const { ShapeType } = enums;

/** Writes a moving lamp's light (the light API of the revision this file belongs to). */
function applyLight(le, spec) {
  le.color = spec.color ?? 0xffffff;
  le.radius = spec.radius;
  le.glow = spec.glow ?? 0;
  if (spec.glowOffsetY !== undefined) le.glowOffsetY = spec.glowOffsetY;
  if (spec.elevation !== undefined) le.elevation = spec.elevation;
}

/**
 * A lamp that circles a point: centre (cx, cy), radius r, angular speed w (rad/s), phase p. Its circles cross the
 * screen's edges, so its pool and its glow come into view and leave it.
 */
export class MotionLamp extends GameObject {
  static components = [LightEmitter];

  onSpawned(spec = {}) {
    applyLight(this.lightEmitter, spec);
    this._cx = spec.cx ?? 0;
    this._cy = spec.cy ?? 0;
    this._r = spec.r ?? 0;
    this._w = spec.w ?? 0;
    this._t = spec.p ?? 0;
    this.x = this._cx + this._r * Math.cos(this._t);
    this.y = this._cy + this._r * Math.sin(this._t);
  }

  tick(dt, deltaTime) {
    this._t += (this._w * deltaTime) / 1000;
    this.x = this._cx + this._r * Math.cos(this._t);
    this.y = this._cy + this._r * Math.sin(this._t);
  }
}

/** A still sprite that casts shadows from the lamps. */
export class MotionProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12;
    this.collider.visualRange = 32;
    this.setSprite('barrel1');
    this.setScale(1.5);
  }
}

/** A box that blocks raycasted light. */
export class MotionBlock extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 40;
    this.collider.height = 26;
    this.collider.visualRange = 64;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = 1;
  }
}

/**
 * Fires a flash every `every` ms at the next of a seeded list of spots: half of them asked to cast no shadow, half
 * raised (`z`), so a film shows how a flash fades and what castShadows does.
 */
export class MotionFlasher extends GameObject {
  static components = [];

  onSpawned(spec = {}) {
    this._spots = spec.spots || [];
    this._every = spec.every ?? 400;
    this._left = this._every;
    this._next = 0;
  }

  tick(dt, deltaTime) {
    this._left -= deltaTime;
    if (this._left > 0 || this._spots.length === 0) return;
    this._left += this._every;
    const s = this._spots[this._next];
    this._next = (this._next + 1) % this._spots.length;
    Flash.spawn({
      x: s[0],
      y: s[1],
      z: s[2],
      lifespan: 220,
      color: 0xffbb44,
      radius: 1095,
      glow: 0.24,
      castShadows: s[3] === 1,
    });
  }
}
