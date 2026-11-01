import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

/**
 * 60k-class prop. Instance tick writes one component field via the facade + rng().
 * Alpha is an auto SoA setter (no Box2D dirty, no mesh paint).
 */
export class MinimalTickProp extends GameObject {
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

/** Same write, visited only every 4th frame by the logic countdown. */
export class MinimalTickIntervalProp extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = 4;

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

/** E-180's churn: a short-lived prop of another type, no tick. */
export class MinimalChurnProp extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.spriteRenderer.renderVisible = 0;
  }
}

/**
 * E-180's churn driver: every frame it despawns its oldest `churn` props and spawns as many, so some type's list
 * changes every frame (the global query version moves) while the interval props' own list never does.
 */
export class MinimalChurnDriver extends GameObject {
  static components = [];

  constructor(...args) {
    super(...args);
    this.churn = 0;
    this.ring = [];
    this.head = 0;
  }

  onSpawned({ churn = 0 } = {}) {
    this.churn = churn | 0;
    this.ring = [];
    this.head = 0;
    for (let j = 0; j < this.churn; j++) this.ring.push(MinimalChurnProp.spawn({ x: 100 + j, y: 100 }));
  }

  tick() {
    const ring = this.ring;
    for (let j = 0; j < this.churn; j++) {
      const old = ring[this.head];
      if (old) old.despawn();
      ring[this.head] = MinimalChurnProp.spawn({ x: 100 + j, y: 120 });
      this.head = (this.head + 1) % ring.length;
    }
  }
}
