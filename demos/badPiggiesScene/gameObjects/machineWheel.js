import WEED from '/src/index.js';
import { LAYER_WHEEL, MASK_WHEEL, WHEEL_RADIUS } from '../utils/badPiggiesGrid.js';

const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

const BALL_TEX = 14;

export class MachineWheel extends GameObject {
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer];



  onSpawned(spawnConfig = {}) {

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    const ghost = !!spawnConfig.ghost;
    const radius = spawnConfig.radius ?? WHEEL_RADIUS;

    this.x = spawnConfig.x ?? this.x;
    this.y = spawnConfig.y ?? this.y;
    this.rotation = 0;

    this.collider.radius = radius;
    this.collider.isTrigger = ghost ? 1 : 0;
    this.collider.friction = 1;
    this.collider.restitution = 0.05;
    this.collider.visualRange = radius + 200;
    this.collider.collisionLayer = LAYER_WHEEL;
    this.collider.collisionMask = ghost ? 0 : MASK_WHEEL;

    this.rigidBody.static = 1;
    this.rigidBody.linearDamping = 0.02;
    this.rigidBody.angularDamping = 0.02;
    this.rigidBody.angularVelocity = 0;
    this.rigidBody.sleeping = 0;

    this.setSprite(spawnConfig.sprite || 'ball');
    const scale = (radius * 2) / BALL_TEX;
    this.setScale(scale, scale);
    this.setTint(spawnConfig.tint ?? 0x333333);
    this.setAlpha(ghost ? 0.4 : 1);
  }

  tick() {}
}
