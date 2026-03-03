// Entity Template - engine-level starter (no demo dependencies)
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

class MyEntity extends GameObject {
  // Required for script auto-loading in worker contexts
  static scriptUrl = import.meta.url;

  // Required: fixed component set for this entity type
  static components = [RigidBody, Collider, SpriteRenderer];

  // Optional: reduce logic frequency when staggered updates are enabled
  // static tickInterval = 2;

  setup() {
    // Runs once per pooled instance
    this.rigidBody.maxVel = 5;
    this.rigidBody.maxAcc = 0.7;
    this.rigidBody.friction = 0.02;
    this.collider.radius = 12;
    this.collider.visualRange = 140;

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.95;
  }

  onSpawned(spawnConfig = {}) {
    // Runs every spawn
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;

    // Optional animated setup:
    // this.setSpritesheet('my_sheet');
    // this.setAnimation('idle_down');
  }

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    const i = this.index;

    // Example input
    if (WEED.Keyboard.isDown('arrowup')) {
      RigidBody.ay[i] -= 0.5 * dtRatio;
    }

    // Example neighbor iteration
    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      // ...
    }
  }

  onCollisionEnter(otherIndex) {
    // Optional callback
  }

  onDespawned() {
    // Optional cleanup
  }
}

export { MyEntity };
