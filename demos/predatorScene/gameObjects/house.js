import WEED from '/src/index.js';
import { ART_FLOOR_SCALE_Y, ART_HEIGHT_SCALE_Y, BARN, HOUSE_SCALE, LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  LightEmitter,
  RigidBody,
  randomColor,
  Flash,
  ParticleEmitter,
  enums,
  ShadowCaster,
} = WEED;
const { ShapeType } = enums;

export class House extends GameObject {
  static serializable = true;
  // ?light3d=1: a ShadowCaster too, its shadow a box (the barn's).
  static components = LIGHT3D
    ? [Collider, SpriteRenderer, LightEmitter, RigidBody, ShadowCaster]
    : [Collider, SpriteRenderer, LightEmitter, RigidBody];

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    const count = Math.floor(damage * 8) + 3;
    ParticleEmitter.emit({
      count,
      texture: 'square',
      x: hitX,
      y: hitY,
      z: -20,
      angleXY: { min: 0, max: 360 },
      speed: { min: 1.5, max: 4 },
      vz: { min: 2, max: 6 },
      lifespan: { min: 400, max: 800 },
      gravity: 0.35,
      scale: { min: 0.15, max: 0.4 },
      alpha: { min: 0.7, max: 1 },
      tint: { min: 0xffff00, max: 0xffffff },
      rotation: { min: 0, max: 360 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

    Flash.spawn({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      radius: 707,
      glow: 0.1,
    });
  }

  onSpawned(spawnConfig = {}) {
    if (LIGHT3D) {
      this.spawnBarn();
      return;
    }
    this.rigidBody.static = 1;
    const type = rng() > 0.5 ? 1 : 2;
    this.setSprite('house' + type);

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 180;
    this.collider.height = 110;
    this.collider.offsetY = -50;
    this.collider.offsetX = 0;
    this.lightEmitter.color = 0xffffaa;

    this.lightEmitter.offsetY = -100; // the window's light, 100 px up the house
    this.lightEmitter.radius = 632;
    this.lightEmitter.active = 1;

    this.setScale(1, 1);
    this.lightEmitter.shadowRange = 300;


  }

  /**
   * ?light3d=1: the light bench's barn (a render with its height and normal maps) looking at the camera, its collider its
   * footprint, its shadow a box for the sun and the lamps, and a lamp over its door.
   */
  spawnBarn() {
    this.rigidBody.static = 1;
    const s = HOUSE_SCALE;
    const [x0, x1, y0, y1, height] = BARN.box;
    this.setSpritesheet('granero');
    this.setAnimation('granero_0'); // the render that looks south, at the camera
    this.spriteRenderer.anchorX = BARN.anchorX;
    this.spriteRenderer.anchorY = BARN.anchorY;
    this.setScale(s, s);

    // Its footprint, as the floor is drawn (the anchor is its middle).
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = (x1 - x0) * s;
    this.collider.height = (y1 - y0) * s * ART_FLOOR_SCALE_Y;
    this.collider.offsetY = 0;
    this.collider.offsetX = 0;

    // A box: its width and depth on the floor, its height in screen px (DX-CASTER: shadowCaster.setBox).
    this.shadowCaster.setBox((x1 - x0) * s, (y1 - y0) * s, height * s * ART_HEIGHT_SCALE_Y);

    // The lamp over its door, in front of the south wall; in an oblique scene elevation is the bulb's real height.
    this.lightEmitter.color = 0xffffaa;
    this.lightEmitter.offsetY = y1 * s * ART_FLOOR_SCALE_Y + 8;
    this.lightEmitter.elevation = 45;
    this.lightEmitter.radius = 632;
    this.lightEmitter.active = 1;
    this.lightEmitter.shadowRange = 300;
  }

  onDespawned() {
    // Could save stats, play death effects, etc.
  }
}
