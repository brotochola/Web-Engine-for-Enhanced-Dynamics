import WEED from '/src/index.js';
import { TOY_HALF_SIZE } from '/src/util/toyWorldBounce.js';

const { GameObject, SpriteRenderer, RigidBody, Collider, enums } = WEED;
const { ShapeType } = enums;

const BUNNY_SCALE = 2;

export class BunnySolver extends GameObject {
  static components = [SpriteRenderer, RigidBody, Collider];
  static reportMarkActive = true;

  onSpawned(spawnConfig = {}) {
    const rng = globalThis.rng;
    this.setSprite('_whiteCircle');
    this.setAnchor(0.5, 0.5);
    this.setScale(BUNNY_SCALE);
    this.setTint((rng() * 0xffffff) | 0);
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = TOY_HALF_SIZE;
    this.collider.restitution = 1;
    this.collider.friction = 0;
    this.collider.collisionLayer = 1;
    this.collider.collisionMask = 1;
    this.collider.collisionGroupIndex = -1;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.angularDamping = 0;
    // Toy vx is px/frame at 60 Hz. Box2D vx is px/s.
    this.rigidBody.vx = (rng() * 10 - 5) * 60;
    this.rigidBody.vy = (rng() * 10 - 5) * 60;
  }
}
