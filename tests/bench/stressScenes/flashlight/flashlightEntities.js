import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter, LightOccluder, enums } = WEED;
const { ShapeType } = enums;

/**
 * A walker with a flashlight in its hand (DX-SPOT): it paces between two x, turning round with flipX, and aims its light
 * up and down at a target that moves. `spec.cone` (radians, 0: a round light of the same reach) and `spec.softness`.
 * The light follows the flip (followFlip), so the hand and the beam change sides when it turns.
 */
export class FlashlightWalker extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned(spec = {}) {
    this.setSprite('walker');
    this.setScale(0.6);
    const light = this.lightEmitter;
    light.radius = spec.radius ?? 380;
    light.color = 0xfff4d0;
    light.offsetX = 12;
    light.offsetY = -6;
    light.glow = 0.15;
    if (spec.cone > 0) {
      light.coneAngle = spec.cone;
      light.coneSoftness = spec.softness ?? 0.25;
      light.followFlip = 1;
    }
    this._x0 = spec.x0 ?? 0;
    this._x1 = spec.x1 ?? 100;
    this._speed = spec.speed ?? 60;
    this._dir = 1;
    this._aim = spec.p ?? 0;
    this._cone = spec.cone > 0;
    this.x = spec.x ?? this._x0;
    this.y = spec.y ?? 0;
  }

  tick(dt, deltaTime) {
    const step = (this._speed * deltaTime) / 1000;
    let x = this.x + step * this._dir;
    if (x > this._x1) { x = this._x1; this._dir = -1; }
    if (x < this._x0) { x = this._x0; this._dir = 1; }
    this.x = x;
    this.flipX = this._dir < 0;
    this._aim += deltaTime / 900;
    // Aim up and down, ahead of the walker: a relative direction (followFlip mirrors it when the walker turns).
    if (this._cone) this.lightEmitter.direction = Math.sin(this._aim) * 0.6;
  }
}

/** A crate that blocks raycasted light. */
export class FlashlightCrate extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({ x = 0, y = 0, w = 40, h = 40 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = w;
    this.collider.height = h;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = 1;
  }
}
