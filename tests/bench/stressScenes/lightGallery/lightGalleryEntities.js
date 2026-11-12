import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightOccluder, enums } = WEED;
const { ShapeType } = enums;

/**
 * Writes one gallery lamp's light. Every field of the light API has a lamp that sets it (lightGalleryScene's LAMPS).
 * `spec.layer`: the glow's layer by name.
 */
function applyLight(le, spec) {
  le.color = spec.color ?? 0xffffff;
  le.radius = spec.radius;
  le.glow = spec.glow ?? 0;
  if (spec.glowOffsetY !== undefined) le.glowOffsetY = spec.glowOffsetY;
  if (spec.elevation !== undefined) le.elevation = spec.elevation;
  if (spec.offsetX !== undefined) le.offsetX = spec.offsetX;
  if (spec.offsetY !== undefined) le.offsetY = spec.offsetY;
  if (spec.layer) le.glowLayer = spec.layer;
}

/** A lamp with a Collider: `spec.range` is its shadowRange (left out: its radius). */
export class GalleryLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(spec = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    applyLight(this.lightEmitter, spec);
    if (spec.range !== undefined) this.lightEmitter.shadowRange = spec.range;
    this._turn = spec.rotation ?? 0;
  }

  /** A body's rotation is the physics worker's after it is created, so the turn goes in here (as dxCaptureScene's). */
  tick() {
    if (this._turn !== 0) this.rotation = this._turn;
  }
}

/** A lamp with no Collider: it reaches its shadows with its whole reach. */
export class GalleryBareLamp extends GameObject {
  static components = [LightEmitter];

  onSpawned(spec = {}) {
    applyLight(this.lightEmitter, spec);
    this._turn = spec.rotation ?? 0;
  }

  tick() {
    if (this._turn !== 0) this.rotation = this._turn;
  }
}

/** A still sprite that casts a shadow from the lamps. */
export class GalleryProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12;
    this.collider.visualRange = 32;
    this.setSprite('barrel1');
    this.setScale(1.5);
  }
}

/** A box that blocks raycasted light. */
export class GalleryBlock extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({ x = 0, y = 0, width = 36, height = 24 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.visualRange = 64;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = 1;
  }
}
