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

export class Rock extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    this.setSprite("rock" + Math.floor(Math.random() * 4 + 1));
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.collider.shapeType = 0;
    this.collider.radius = 22 * this.scale;
    this.collider.offsetY = -this.collider.radius;

    this.collider.visualRange = 0;

    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = this.collider.radius * 2;
  }

  onSpawned(spawnConfig = {}) {
    this.setup();
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
  }
}
