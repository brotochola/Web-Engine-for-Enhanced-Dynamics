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
    this.setSprite("house" + (Math.random() > 0.5 ? 1 : 2));

    this.collider.shapeType = 1;
    this.collider.width = 186;
    this.collider.height = 110;
    this.collider.offsetY = -50;
    this.lightEmitter.lightColor = 0xffffaa;

    this.lightEmitter.height = 400;
    this.lightEmitter.lightIntensity = 4000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;
    // this.setScale(0.57, 0.57);

    this.collider.visualRange = 300;
  }

  onSpawned(spawnConfig = {}) {
    this.setup();
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
  }

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
