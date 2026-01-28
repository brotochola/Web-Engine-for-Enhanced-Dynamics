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
  ShapeType,
} = WEED;

export class Tree extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    this.setSprite("tree" + (Math.random() > 0.5 ? 1 : 2));
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * this.scale;

    this.collider.visualRange = 0;

    this.shadowCaster.shadowRadius = this.collider.radius * 2;
    this.shadowCaster.height = 120 * this.scale;
  }

  onSpawned(spawnConfig = {}) {
    this.setup();
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
  }
}
