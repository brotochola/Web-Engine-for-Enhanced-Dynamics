// Entity Template - Copy this file to create new entities quickly! 🌿
// Replace "MyEntity" with your entity name

import WEED from "/src/index.js";

// Destructure the components you need
const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

class MyEntity extends GameObject {
  // ========================================
  // REQUIRED: Auto-detection for worker loading
  // ========================================
  static scriptUrl = import.meta.url;

  // ========================================
  // REQUIRED: Define which components this entity uses
  // ========================================
  static components = [
    RigidBody,
    Collider,
    SpriteRenderer,
    // Add custom components here
  ];

  // ========================================
  // OPTIONAL: Sprite configuration
  // ========================================
  // static spriteConfig = {
  //   type: "static",      // or "animated"
  //   textureName: "myTexture",
  // };

  // ========================================
  // LIFECYCLE: Configure entity TYPE properties
  // Runs ONCE per instance when created
  // All components are initialized at this point
  // ========================================
  setup() {
    // Configure physics
    this.rigidBody.maxVel = 10;
    this.rigidBody.maxAcc = 1;
    this.rigidBody.friction = 0.01;
    this.rigidBody.minSpeed = 0;

    // Configure collider
    this.collider.radius = 20;
    this.collider.visualRange = 100;

    // Configure sprite
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.spriteRenderer.scaleX = 1;
    this.spriteRenderer.scaleY = 1;
  }

  // ========================================
  // LIFECYCLE: Called when entity spawns from pool
  // Runs EVERY time entity is spawned
  // Use this to initialize instance-specific properties
  // ========================================
  onSpawned(spawnConfig = {}) {
    // Example: Set random position
    // this.transform.x = spawnConfig.x || Math.random() * 800;
    // this.transform.y = spawnConfig.y || Math.random() * 600;
  }

  // ========================================
  // LIFECYCLE: Called when entity despawns (returns to pool)
  // Use this for cleanup
  // ========================================
  onDespawned() {
    // Example: Save stats, trigger effects, etc.
  }

  // ========================================
  // LIFECYCLE: Update logic (runs every frame)
  // @param {number} dtRatio - Frame time ratio for frame-rate independence
  // ========================================
  tick(dtRatio) {
    const i = this.index;

    // Example: Apply keyboard input
    if (WEED.Keyboard.isPressed("ArrowUp")) {
      RigidBody.ay[i] -= 0.5 * dtRatio;
    }

    // Example: Direct component array access (high-performance)
    // const x = Transform.x[i];
    // const y = Transform.y[i];
    // const vx = RigidBody.vx[i];
    // const vy = RigidBody.vy[i];

    // Example: Helper methods (convenience, slight overhead)
    // const speed = this.rigidBody.speed;
    // this.setPosition(x + 1, y + 1);
  }

  // ========================================
  // OPTIONAL: Custom methods
  // ========================================
  // myCustomMethod() {
  //   // Your code here
  // }
}

// Export your entity
export { MyEntity };

