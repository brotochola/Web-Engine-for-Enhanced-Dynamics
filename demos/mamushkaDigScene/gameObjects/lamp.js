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
    this.lightEmitter.lightColor = 0xffcc88;
    this.lightEmitter.lightIntensity = 18000;
    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 8;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;

    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.setSprite('_whiteCircle');
    this.setScale(2.8, 2.8);
    this.lightEmitter.active = 1;
    this.lightEmitter.lightIntensity =
      spawnConfig.lightIntensity != null ? spawnConfig.lightIntensity : 18000;
    this.collider.visualRange =
      spawnConfig.visualRange != null ? spawnConfig.visualRange : LAMP_RANGE;
  }
}
