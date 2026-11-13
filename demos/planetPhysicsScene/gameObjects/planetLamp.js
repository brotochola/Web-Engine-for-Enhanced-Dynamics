// Dropped light. Same pull as every other dynamic body.

import { radialPull } from '../planetGravity.js';
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

const _pull = { x: 0, y: 0 };

export class PlanetLamp extends GameObject {
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, LightEmitter];
  static forceProcessOnLogicWorker = 0;

  onSpawned(spawnConfig = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12;
    this.collider.friction = 0.4;
    this.rigidBody.linearDamping = 0.2;
    this.setSprite('square');
    this.setScale(2.2, 2.2);
    this.setAnchor(0.5, 0.5);
    this.setTint(0xffe0a0);
    this.lightEmitter.color = 0xffcc88;
    this.lightEmitter.radius = 1183;
    this.lightEmitter.glowOffsetY = -8;
    this.lightEmitter.active = 1;
    this.lightEmitter.glow = 0.28;
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.setVelocity(0, 0);
  }

  tick() {
    const i = this.index;
    radialPull(this.x, this.y, _pull);
    RigidBody.ax[i] = _pull.x;
    RigidBody.ay[i] = _pull.y;
  }
}
