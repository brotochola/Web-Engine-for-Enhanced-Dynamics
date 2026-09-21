import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Grab, enums } = WEED;
const { ShapeType } = enums;

const HEAT = 1;
const JET = 16;
const THRUST = 1400;

export class RocketBox extends GameObject {
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, Grab];

  onSpawned(spawnConfig = {}) {
    const config = spawnConfig || {};
    this.setSprite(config.sprite || 'box');

    const width = config.width || 90;
    const height = config.height || 48;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.shapeType = ShapeType.Box;
    this.collider.friction = config.friction ?? 0.4;
    this.collider.visualRange = Math.hypot(width, height) / 2 + 200;
    this.rigidBody.linearDamping = 0.05;
    this.rigidBody.static = 0;
    this.rotation = config.rotation ?? 0;

    const origW = this.spriteRenderer.originalWidth || 100;
    const origH = this.spriteRenderer.originalHeight || 100;
    this.setScale(width / origW, height / origH);
    this.setAnchor(0.5, 0.5);
    this.setTint(config.tint ?? 0xc45c2a);
    this.setAlpha(1);

    this.setLayer('fire');
    this.setFeedBits(HEAT | JET);
    this._thrust = config.thrust ?? THRUST;
  }

  tick() {
    this.addAcceleration(-this.forwardX * this._thrust, -this.forwardY * this._thrust);
  }
}
