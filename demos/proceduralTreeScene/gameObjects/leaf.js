import WEED from '/src/index.js';
import { LAYER_GROUND, LAYER_LEAF } from '../components/treeComponent.js';

const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

const STILL_MS = 4500;
const RADIUS = 5;

export class Leaf extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(cfg = {}) {
    this._still = 0;
    this.rotation = cfg.rotation || 0;
    this.setSprite('leaf');
    this.setAnchor(0.5, 1);
    this.setTint(cfg.tint ?? 0xffffff);
    const scale = cfg.scale > 0 ? cfg.scale : 0.06;
    this.setScale(scale, scale);

    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.35;
    this.rigidBody.angularDamping = 0.6;
    this.collider.radius = RADIUS;
    this.collider.offsetY = -RADIUS;
    this.collider.friction = 1.5;
    this.collider.restitution = 0;
    this.collider.collisionLayer = LAYER_LEAF;
    this.collider.collisionMask = (1 << LAYER_GROUND) | (1 << LAYER_LEAF);
    this.collider.collisionGroupIndex = 0;
    this.rigidBody.mass = 0.2;
    if (cfg.vx) this.vx = cfg.vx;
  }

  tick(dtRatio, deltaTime) {
    const speed2 = this.vx * this.vx + this.vy * this.vy;
    const slow = speed2 < 40 * 40 && Math.abs(this.angularVelocity) < 0.45;
    this._still = slow ? this._still + deltaTime : 0;
    if (this._still > STILL_MS || this.y > 2400) this.despawn();
  }
}
