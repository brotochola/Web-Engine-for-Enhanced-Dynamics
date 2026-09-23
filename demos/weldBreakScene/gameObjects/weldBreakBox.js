// WeldBreakBox — dynamic box with JointBreakListener; sparks on weld snap

import WEED from '/src/index.js';

const {
  GameObject,
  RigidBody,
  Collider,
  SpriteRenderer,
  CollisionListener,
  JointBreakListener,
  Grab,
  ParticleEmitter,
  Transform,
  enums,
} = WEED;
const { ShapeType } = enums;

export class WeldBreakBox extends GameObject {

  static components = [
    RigidBody,
    Collider,
    SpriteRenderer,
    CollisionListener,
    JointBreakListener,
    Grab,
  ];

  onCollisionHit(otherIndex, px, py, nx, ny, approachSpeed) {
    // console.log('onCollisionHit', otherIndex, px, py, nx, ny, approachSpeed);
  }

  onCollisionEnter(otherIndex) {
    // console.log('onCollisionEnter', otherIndex);
  }

  onCollisionStay(otherIndex) {
    // console.log('onCollisionStay', otherIndex);
  }

  onCollisionExit(otherIndex) {
    // console.log('onCollisionExit', otherIndex);
  }

  onSpawned(spawnConfig = {}) {
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    const size = spawnConfig.size ?? 80;
    const width = spawnConfig.width ?? size;
    const height = spawnConfig.height ?? size;
    const texSize = 100;

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.isTrigger = 0;
    this.collider.friction = 0.8;
    this.collider.visualRange = Math.hypot(width, height) * 0.5 + 200;

    this.collider.enableHitEvents = 1;

    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.01;
    this.rigidBody.angularDamping = 0.05;
    this.rigidBody.angularVelocity = 0;
    this.rigidBody.sleeping = 0;

    // Heavy dropper: area mass scales with size; extra mass for impact
    if (spawnConfig.mass != null) {
      this.rigidBody.mass = spawnConfig.mass;
    }

    this.rotation = spawnConfig.rotation ?? 0;

    this.setSprite(spawnConfig.sprite || 'box');
    this.setScale(width / texSize, height / texSize);
    this.setTint(spawnConfig.tint ?? 0xffffff);
  }

  /**
   * One spark burst per break (entityA only) at joint midpoint.
   */
  onJointBreak(_jointIndex, entityA, entityB) {
    // console.log('onJointBreak', _jointIndex, entityA, entityB);
    // if (this.index !== entityA) return;

    const x = (Transform.x[entityA] + Transform.x[entityB]) * 0.5;
    const y = (Transform.y[entityA] + Transform.y[entityB]) * 0.5;

    ParticleEmitter.emit({
      count: 15 + Math.floor(rng() * 8),
      x,
      y: y + 50,
      z: -50,
      angleXY: { min: 0, max: 360 },
      speed: { min: 1, max: 5 },
      vz: 0,
      gravity: 0.3,
      lifespan: { min: 200, max: 400 },
      scale: { min: 1, max: 3 },
      texture: '_whiteCircle',
      // tint: { min: 0xffaa33, max: 0xffffaa },
      alpha: { from: { min: 0.5, max: 0.95 }, to: 0 },
      despawnOnGroundContact: false,

      layer: 'sparks',
    });
  }
}
