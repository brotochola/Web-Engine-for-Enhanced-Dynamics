import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,

  ShadowCaster,
  RigidBody,
  ShapeType,
} = WEED;

export class Barrel extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, RigidBody, ShadowCaster];

  setup() {
    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 2;
    this.rigidBody.friction = 0.8;
    this.setSprite('barrel' + Math.floor(Math.random() * 3 + 1));

    this.setScale(Math.random() > 0.5 ? 1 : 1);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;

    this.collider.visualRange = 50;

    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = 60;
  }

  onSpawned(spawnConfig = {}) {}

  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  tick(dtRatio) {
    // Solo loggear la primera TallLight para no spamear
    // console.log(
    //   `House[${this.index}] neighbors: ${this.neighborCount}, visualRange: ${this.collider.visualRange}, active: ${this.collider.active}`
    // );
  }
}
