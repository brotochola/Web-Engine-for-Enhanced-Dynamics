import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

/**
 * A car driving a circle with its headlights ahead of it: one LightEmitter, turned with the car (its rotation is the
 * heading). `spec.cone`: the cone's aperture in radians (0: a point light, the same reach), `spec.softness`.
 */
export class SpotCar extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned(spec = {}) {
    this.setSprite('car');
    this.setScale(0.5);
    const light = this.lightEmitter;
    light.radius = spec.radius ?? 420;
    light.color = spec.color ?? 0xfff1c4;
    // The car is drawn facing up its texture: its front is local -y, so the light sits 28 px up and points that way
    // (direction -90 degrees from the entity's facing): a picture that faces up needs no other change.
    light.offsetY = -28;
    light.direction = -Math.PI / 2;
    light.shadowRange = spec.shadowRange ?? 0;
    if (spec.cone > 0) {
      light.coneAngle = spec.cone;
      light.coneSoftness = spec.softness ?? 0.3;
    }
    this._cx = spec.cx ?? 0;
    this._cy = spec.cy ?? 0;
    this._r = spec.r ?? 100;
    this._w = spec.w ?? 0.5;
    this._t = spec.p ?? 0;
    this._place();
  }

  _place() {
    const c = Math.cos(this._t);
    const s = Math.sin(this._t);
    this.x = this._cx + this._r * c;
    this.y = this._cy + this._r * s * 0.7;
    // Heading along the circle (its tangent), counter-clockwise for w > 0; the picture faces up, a quarter turn more.
    const heading = this._w >= 0 ? this._t + Math.PI / 2 : this._t - Math.PI / 2;
    this.rotation = heading + Math.PI / 2;
  }

  tick(dt, deltaTime) {
    this._t += (this._w * deltaTime) / 1000;
    this._place();
  }
}

/** A tree that casts a shadow from the headlights. */
export class SpotTree extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;
    this.setSprite('tree');
    this.setScale(0.35);
    this.spriteRenderer.anchorY = 0.95;
  }
}
