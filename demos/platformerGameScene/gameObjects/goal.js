import WEED from '/src/index.js';
import { BluePlatformerPlayer } from './bluePlatformerPlayer.js';

const { GameObject, Collider, SpriteRenderer, RigidBody, CollisionListener, enums } = WEED;
const { ShapeType } = enums;

/** The platformer's bloom layer (PlatformerGameScene's config.layers). */
const BLOOM_LAYER = 'bloom';

/**
 * The end of a level: when the player walks into it, the scene loads the level its `next`
 * names (PlatformerGameScene, 'goalReached'). A solid block, so its contacts reach the
 * logic workers the way the platforms' do.
 */
export class Goal extends GameObject {
  static components = [Collider, SpriteRenderer, RigidBody, CollisionListener];

  // `next` is read by the scene, from the level's scene file: an entity's plain fields
  // live on one logic worker, and the contact may be handled on another. onSpawned does
  // not need it; declaring it gives the editor its field.
  static spawnParams = {
    next: { value: '', label: 'Next level', tip: 'The scene file to load, relative to this one' },
    width: { value: 80, min: 16, max: 400, step: 1 },
    height: { value: 160, min: 16, max: 400, step: 1 },
    tint: { value: 0xffcc33, type: 'color' },
  };

  onSpawned(params) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.radius = 0;
    this.rigidBody.static = 1;

    this.x = params.x;
    this.y = params.y;
    this.width = params.width;
    this.height = params.height;
    this.collider.width = params.width;
    this.collider.height = params.height;

    this.setSprite('_white');
    this.setScale(params.width / 8, params.height / 8);
    this.setAnchor(0.5, 0.5);
    this.setTint(params.tint);
    this.setLayer(BLOOM_LAYER);
  }

  onCollisionEnter(other) {
    if (GameObject.is(other, BluePlatformerPlayer)) this.emit('goalReached');
  }
}
