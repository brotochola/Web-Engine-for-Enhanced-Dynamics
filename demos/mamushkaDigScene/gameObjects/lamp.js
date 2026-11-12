// Lamp — portable LightEmitter. Walk over to pick; F to place.

import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, LightEmitter, enums, RigidBody } = WEED;
const { ShapeType } = enums;

const LAMP_RADIUS = 14;
const LAMP_RANGE = 750;

export class Lamp extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter, RigidBody];



  onSpawned(spawnConfig = {}) {

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = LAMP_RADIUS;
    // this.collider.isTrigger = 1;
    this.collider.visualRange = LAMP_RANGE;
    this.setSprite('_whiteCircle');
    this.setScale(2.8, 2.8);
    this.setAnchor(0.5, 0.5);
    this.setTint(0xffe0a0);
    this.lightEmitter.color = 0xffcc88;
    this.lightEmitter.radius = 1342;
    this.lightEmitter.glowOffsetY = -8;
    this.lightEmitter.active = 1;
    this.lightEmitter.glow = 0.36;

    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.setSprite('_whiteCircle');
    this.setScale(2.8, 2.8);
    this.lightEmitter.active = 1;
    this.lightEmitter.radius = spawnConfig.lightRadius != null ? spawnConfig.lightRadius : 1342;
    this.collider.visualRange =
      spawnConfig.visualRange != null ? spawnConfig.visualRange : LAMP_RANGE;
  }
}
