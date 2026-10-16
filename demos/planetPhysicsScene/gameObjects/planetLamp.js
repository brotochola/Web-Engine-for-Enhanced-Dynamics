// Dropped light. Same pull as every other dynamic body.

import { CX, CY, G } from '../planetGravity.js';
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class PlanetLamp extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, LightEmitter];
  static forceProcessOnLogicWorker = 0;

  onSpawned(spawnConfig = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12;
    this.collider.friction = 0.4;
    this.collider.visualRange = 500;
    this.rigidBody.linearDamping = 0.2;
    this.setSprite('square');
    this.setScale(2.2, 2.2);
    this.setAnchor(0.5, 0.5);
    this.setTint(0xffe0a0);
    this.lightEmitter.lightColor = 0xffcc88;
    this.lightEmitter.lightIntensity = 14000;
    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 8;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0.5;
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.setVelocity(0, 0);
  }

  tick() {
    const i = this.index;
    const dx = CX - this.x;
    const dy = CY - this.y;
    const len = Math.hypot(dx, dy) || 1;
    RigidBody.ax[i] = (dx / len) * G;
    RigidBody.ay[i] = (dy / len) * G;
  }
}
