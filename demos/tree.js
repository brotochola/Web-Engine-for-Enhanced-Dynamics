import WEED from "/src/index.js";

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  ShadowCaster,
} = WEED;

export class Tree extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    // Override Boid's physics properties for prey behavior
    // this.rigidBody.maxVel = 0;
    // this.rigidBody.maxAcc = 0;
    // this.rigidBody.static = 1; // Static body - nothing can move it
    this.setSprite("tree" + (Math.random() > 0.5 ? 1 : 2));
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.collider.shapeType = 0;
    this.collider.radius = 20 * this.scale;

    this.collider.visualRange = 0;

    this.shadowCaster.shadowRadius = this.collider.radius * 2;
    this.shadowCaster.height = 120 * this.scale;
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
