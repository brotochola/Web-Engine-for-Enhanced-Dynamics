import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, enums, ShadowCaster, RigidBody } = WEED;
const { ShapeType } = enums;

/** The platformer's bloom layer (PlatformerGameScene's config.layers); a scene file's "layer" overrides it. */
const BLOOM_LAYER = 'bloom';

export class Platform extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

  // What a scene file (levels/*.scene.json) and the editor set per platform: onSpawned
  // gets every one, the default filled in when the file leaves it out.
  static spawnParams = {
    width: { value: 220, min: 8, max: 4000, step: 1 },
    height: { value: 36, min: 8, max: 1000, step: 1 },
    tint: { value: 0x495870, type: 'color' },
    alpha: { value: 1, min: 0, max: 1, step: 0.05 },
  };

  onSpawned(params) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.radius = 0;
    this.collider.visualRange = 512;
    this.rigidBody.static = 1;

    const width = params.width;
    const height = params.height;

    this.x = params.x;
    this.y = params.y;

    this.width = width;
    this.height = height;

    this.collider.width = width;
    this.collider.height = height;

    this.setSprite('_white');
    this.setScale(width / 8, height / 8);
    this.setAnchor(0.5, 0.5);
    this.setTint(params.tint);
    this.setAlpha(params.alpha);
    this.setLayer(BLOOM_LAYER);
  }
}
