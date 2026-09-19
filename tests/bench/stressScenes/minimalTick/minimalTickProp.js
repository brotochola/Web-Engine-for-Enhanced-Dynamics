import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

/**
 * 60k-class prop. Instance tick writes one component field via the facade + rng().
 * Alpha is an auto SoA setter (no Box2D dirty, no mesh paint).
 */
export class MinimalTickProp extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.spriteRenderer.renderVisible = 0;
  }

  tick() {
    this.spriteRenderer.alpha = globalThis.rng();
  }
}

/**
 * Same spawn / SoA write, no tick() override. Logic worker calls tickAll once.
 */
export class MinimalTickAllProp extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.spriteRenderer.renderVisible = 0;
  }

  static tickAll(list, count) {
    const alpha = SpriteRenderer.alpha;
    for (let i = 0; i < count; i++) {
      alpha[list[i]] = globalThis.rng();
    }
  }
}
