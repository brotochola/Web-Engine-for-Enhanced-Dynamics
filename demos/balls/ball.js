import { GameObject } from "/src/core/gameObject.js";
import { RigidBody } from "/src/components/RigidBody.js";
import { Collider } from "/src/components/Collider.js";
import { SpriteRenderer } from "/src/components/SpriteRenderer.js";

class Ball extends GameObject {
  static entityType = 1; // 1 = Ball
  static instances = []; // Instance tracking for this class

  // Define components this entity uses
  static components = [RigidBody, Collider, SpriteRenderer];

  // Sprite configuration - using static sprite
  static spriteConfig = {
    type: "static",
    textureName: "ball",
  };

  // /**
  //  * Ball constructor - initializes ball properties
  //  * @param {number} index - Position in shared arrays
  //  * @param {Object} componentIndices - Component indices { transform, rigidBody, collider, spriteRenderer }
  //  * @param {Object} config - Configuration object from GameEngine
  //  */
  // constructor(index, componentIndices, config = {}, logicWorker = null) {
  //   super(index, componentIndices, config, logicWorker);
  // }

  /**
   * LIFECYCLE: Called when ball is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    // Get config from instance (passed during construction)
    const config = this.config || {};

    // Initialize RigidBody physics properties
    this.rigidBody.maxVel = 100; // Max velocity
    this.rigidBody.maxAcc = 2; // Max acceleration
    this.rigidBody.minSpeed = 0; // Balls can come to rest
    this.rigidBody.friction = 0.01; // Low friction - let balls settle naturally

    // Initialize position using ergonomic API (automatically syncs px/py for Verlet)
    this.x = Math.random() * config.worldWidth;
    this.y = Math.random() * config.worldHeight;
    this.rotation = 0;

    // Initialize RigidBody velocities and accelerations
    this.vx = 0;
    this.vy = 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    const actualBallSize = 14; //png width
    const ballRadius = Math.random() * 20 + 10;
    this.collider.radius = ballRadius;

    // Set visual range for spatial queries
    this.collider.visualRange = (config.spatial?.cellSize || 80) * 1.33;

    const scale = (ballRadius * 2) / actualBallSize;

    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

    // Center the sprite anchor (0-1 range)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    // Reset visual properties
    this.setAlpha(1.0);
    this.setTint(0xffffff);

    // Random color tint for visual variety
    const colors = [
      0xff6b6b, // Red
      0x4ecdc4, // Cyan
      0xffe66d, // Yellow
      0xa29bfe, // Purple
      0x95e1d3, // Mint
      0xfeca57, // Orange
      0x48dbfb, // Blue
      0xff9ff3, // Pink
    ];
    this.myColor = colors[Math.floor(Math.random() * colors.length)];
    this.setTint(this.myColor);
  }

  onCollisionEnter(otherIndex) {
    // this.setTint(0xff0000);
  }

  onCollisionExit(otherIndex) {
    // this.setTint(this.myColor);
  }

  /**
   * LIFECYCLE: Called when ball is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  sleep() {
    // console.log(`Ball ${this.index} despawned`);
  }

  /**
   * Main update - simple behavior for balls
   * Note: Gravity and collision resolution are handled by physics worker
   *
   * ERGONOMIC API DEMO: Using this.x, this.y for clean, readable code
   * For performance-critical loops with 1000+ entities, use direct array access instead
   */
  tick(dtRatio, inputData) {
    // Mouse interaction: push balls away from cursor on click
    if (inputData[3]) {
      // Calculate distance using ergonomic API (clean and readable!)
      const dx = this.x - inputData[0];
      const dy = this.y - inputData[1];
      const dist2 = dx * dx + dy * dy;

      if (dist2 > 20000) return; // Only affect nearby balls

      // Apply repulsion force
      this.rigidBody.ax = dx * 0.2;
      this.rigidBody.ay = dy * 0.2;
    }
  }
}

// ES6 module export
export { Ball };
