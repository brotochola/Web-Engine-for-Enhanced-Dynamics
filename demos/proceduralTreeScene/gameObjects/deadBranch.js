import WEED from '/src/index.js';
import { LAYER_DEAD, LAYER_GROUND } from '../components/treeComponent.js';

const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

const WHITE_PX = 8;

export class DeadBranch extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(cfg = {}) {
    const length = cfg.length > 1 ? cfg.length : 8;
    const width = cfg.width > 1 ? cfg.width : 3;
    this.rotation = cfg.rotation || 0;
    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setTint(0x6b4423);
    this.setScale(width / WHITE_PX, length / WHITE_PX);

    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.4;
    this.rigidBody.angularDamping = 0.8;
    this.collider.friction = 0.8;
    this.collider.restitution = 0;
    this.collider.width = width;
    this.collider.height = length;
    this.collider.offsetY = -length * 0.5;
    this.collider.collisionLayer = LAYER_DEAD;
    this.collider.collisionMask = (1 << LAYER_GROUND) | (1 << LAYER_DEAD);
    this.collider.collisionGroupIndex = 0;
    this.vx = cfg.vx || 0;
    this.vy = cfg.vy || 0;
    this.angularVelocity = cfg.ang || 0;
  }

  tick() {
    if (this.y > 3000) this.despawn();
  }
}
