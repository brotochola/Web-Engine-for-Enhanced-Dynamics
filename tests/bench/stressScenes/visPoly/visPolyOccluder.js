import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LightOccluder, SpriteRenderer, LIGHT_OCCLUDER_MASK_SPRITE, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyOccluder extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({ x = 0, y = 0, width = 48, height = 48, circle = 0, block = 1 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    if (circle) {
      this.collider.shapeType = ShapeType.Circle;
      this.collider.radius = width * 0.5;
    } else {
      this.collider.shapeType = ShapeType.Box;
      this.collider.width = width;
      this.collider.height = height;
    }
    this.collider.visualRange = 80;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = block;
  }
}

/**
 * `?mask=sprite` (E-260): an occluder with a white picture of its box's size, its self-lit fills masked by that picture
 * (`maskMode` sprite, as a house in the Headlights demo): the self-lit sprite-mask pass draws one mesh per occluder and
 * light. A class of its own, so the default scene's occluders carry no SpriteRenderer.
 */
export class VisPolySpriteOccluder extends GameObject {
  static components = [RigidBody, Collider, LightOccluder, SpriteRenderer];

  onSpawned({ x = 0, y = 0, width = 48, height = 48, block = 1 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.visualRange = 80;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = block;
    this.setSprite('_white');
    const ow = this.spriteRenderer.originalWidth || 8;
    const oh = this.spriteRenderer.originalHeight || 8;
    this.setScale(width / ow, height / oh);
    this.setAnchor(0.5, 0.5);
    this.lightOccluder.maskMode = LIGHT_OCCLUDER_MASK_SPRITE;
  }
}
