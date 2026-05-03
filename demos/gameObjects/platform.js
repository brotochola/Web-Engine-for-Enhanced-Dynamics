import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, enums, ShadowCaster } = WEED;
const { ShapeType } = enums;

export class Platform extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    this.collider.shapeType = ShapeType.Box;
    this.collider.radius = 0;
    this.collider.visualRange = 512;
  }

  onSpawned(spawnConfig = {}) {
    const width = spawnConfig.width ?? 220;
    const height = spawnConfig.height ?? 36;

    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;

    this.width = width;
    this.height = height;

    this.collider.width = width;
    this.collider.height = height;

    this.setSprite('_white');
    this.setScale(width / 8, height / 8);
    this.setAnchor(0.5, 0.5);
    this.setTint(spawnConfig.tint ?? 0x495870);
    this.setAlpha(spawnConfig.alpha ?? 1);
  }

  tick() { }
}
