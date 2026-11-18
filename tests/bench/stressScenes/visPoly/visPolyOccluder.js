import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, ShadowCaster, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyOccluder extends GameObject {
  static components = [RigidBody, Collider, ShadowCaster];

  onSpawned({ x = 0, y = 0, width = 48, height = 48, circle = 0, block = 1, cast = 'wall', volumeHeight = 400 } = {}) {
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
    this.shadowCaster.opacity = block;
    if (cast === 'wall') {
      // A wall at the collider's outline, taking out `block` of the light (the caster's opacity).
      this.shadowCaster.setWall();
    } else if (cast === 'volume') {
      // OL-3's maps arm: the same footprint as a volume of the lamps' shadow map, taller than any lamp (a round
      // occluder as its bounding box).
      this.shadowCaster.setBox(width, circle ? width : height, volumeHeight);
    }
  }
}

/**
 * `?mask=sprite` (E-260): an occluder with a white picture of its box's size, its self-lit fills masked by that picture
 * (a wall's shape 'sprite', as a house in the Headlights demo): the self-lit sprite-mask pass draws one mesh per occluder
 * and light. A class of its own, so the default scene's occluders carry no SpriteRenderer.
 */
export class VisPolySpriteOccluder extends GameObject {
  static components = [RigidBody, Collider, ShadowCaster, SpriteRenderer];

  onSpawned({ x = 0, y = 0, width = 48, height = 48, block = 1, cast = 'wall', volumeHeight = 400 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.visualRange = 80;
    this.setSprite('_white');
    const ow = this.spriteRenderer.originalWidth || 8;
    const oh = this.spriteRenderer.originalHeight || 8;
    this.setScale(width / ow, height / oh);
    this.setAnchor(0.5, 0.5);
    // A wall with a picture of its own: the light pass lights the picture where a lamp reaches the wall's edge (the old
    // fan pass masks its fill by the picture's alpha: shape 'sprite').
    this.shadowCaster.opacity = block;
    if (cast === 'wall') this.shadowCaster.setWall({ shape: 'sprite' });
    else if (cast === 'volume') this.shadowCaster.setBox(width, height, volumeHeight);
  }
}
