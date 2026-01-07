import WEED from "/src/index.js";

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
} = WEED;

export class House extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter];

  setup() {
    // Override Boid's physics properties for prey behavior
    // this.rigidBody.maxVel = 0;
    // this.rigidBody.maxAcc = 0;
    // this.rigidBody.static = 1; // Static body - nothing can move it
    this.setSprite("house");

    this.collider.shapeType = 1;
    this.collider.width = 200;
    this.collider.height = 120;
    this.collider.offsetY = -50;
    this.lightEmitter.lightColor = 0xffff00;

    this.lightEmitter.height = 110;
    this.lightEmitter.lightIntensity = 4000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;

    this.collider.visualRange = 500;
  }

  onSpawned(spawnConfig = {}) {
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
    this.setSprite("house");
  }

  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  tick(dtRatio) {}
}
