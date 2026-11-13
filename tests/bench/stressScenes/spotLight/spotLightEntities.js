import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

/** The car sprite (demos/img/zenithal_car.png, 77 × 171, seen from straight above, facing up) at this scale. */
const CAR_SCALE = 0.5;
/**
 * Half the car's length at that scale, and a little: the headlight sits just past the bumper, two lighting texels ahead
 * (lighting.resolution 0.25 draws the light in 4 px texels, so a light on the bumper would bleed onto the hood).
 */
const BUMPER = (171 * CAR_SCALE) / 2 + 9;

/**
 * A car driving a circle with its headlights ahead of it, seen from straight above: one LightEmitter at its front
 * bumper. The picture faces up its texture, so the entity turns a quarter more than its heading and the light points
 * up the car (offsetY -BUMPER, direction -90 degrees). `spec.cone`: the cone's aperture in radians (0: a point light,
 * the same reach), `spec.softness`.
 */
export class SpotCar extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned(spec = {}) {
    this.setSprite('car');
    // Seen from straight above, the car turns about its centre (the default anchor is the picture's bottom, the
    // feet of a figure seen from the front, which put the headlight on the windshield).
    this.setAnchor(0.5, 0.5);
    this.setScale(CAR_SCALE);
    const light = this.lightEmitter;
    light.radius = spec.radius ?? 420;
    light.color = spec.color ?? 0xfff1c4;
    light.offsetY = -BUMPER;
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
    this.x = this._cx + this._r * Math.cos(this._t);
    this.y = this._cy + this._r * Math.sin(this._t);
    // Heading along the circle (its tangent), counter-clockwise for w > 0; the picture faces up, a quarter turn more.
    const heading = this._w >= 0 ? this._t + Math.PI / 2 : this._t - Math.PI / 2;
    this.rotation = heading + Math.PI / 2;
  }

  tick(dt, deltaTime) {
    this._t += (this._w * deltaTime) / 1000;
    this._place();
  }
}

/** A rock or a parked car seen from above, casting a short shadow from the headlights. */
export class SpotProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(spec = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12;
    this.setSprite(spec.texture || 'rock1');
    this.setAnchor(0.5, 0.5);
    this.setScale(spec.scale ?? 1);
    this.rotation = spec.rotation ?? 0;
    // Low things seen from above: short shadows.
    this.shadowCaster.heightMultiplier = spec.height ?? 0.35;
  }
}
