import WEED from '/src/index.js';
import { ParticleEmitter } from '/src/index.js';
import { FARM_TREES, LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  ShadowCaster,
  enums, rng,
  CameraInOutListener,
} = WEED;
const { ShapeType } = enums;

export class Tree extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    // const count = Math.floor(damage * 8) + 3;
    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(rng() * radius) + radius * 0.5,
      x: hitX + (rng() * radius - radius * 0.5),
      y: hitY + (rng() * radius - radius * 0.5),
      z: - rng() * 40,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 8 },
      rotation: { min: 0, max: 360 },
      vz: -rng() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 1 },
      texture: '_whiteCircle',
      tint: { min: 0x4A3728, max: 0xC4A484 },
      alpha: 1,
      stayOnTheFloor: true,

    });
  }

  onSpawned(spawnConfig = {}) {
    if (LIGHT3D) {
      this.spawnFarmTree();
      return;
    }
    this.rigidBody.static = 1;
    const whichTree = rng() > 0.5 ? 1 : 2;
    this.setSprite('tree' + whichTree);
    const scale = rng() * 0.5 + 1;
    this.setScale(rng() > 0.5 ? scale : -scale, scale);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * scale;
    this.spriteRenderer.anchorY = 0.95;
    this.spriteRenderer.anchorX = 0.45;
    this.collider.visualRange = this.collider.radius * 10;
  }

  /**
   * ?light3d=1: the light bench's trees, with their height and normal maps. One view each, so every light casts its
   * silhouette (the ShadowCaster's default for one view), standing on the base the engine measures.
   */
  spawnFarmTree() {
    this.rigidBody.static = 1;
    const whichTree = rng() > 0.5 ? 1 : 2;
    this.setSpritesheet('arboles');
    this.setAnimation(whichTree === 1 ? 'arbol_verde' : 'arbol_jacaranda');
    const scale = rng() * 0.5 + 1;
    this.setScale(rng() > 0.5 ? scale : -scale, scale);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * scale;
    this.spriteRenderer.anchorY = FARM_TREES.anchorY;
    this.spriteRenderer.anchorX = FARM_TREES.anchorX;
    this.collider.visualRange = this.collider.radius * 10;
  }

}
