class Ball extends RenderableGameObject {
  static entityType = 1; // 1 = Ball
  static instances = []; // Instance tracking for this class

  // Define ball-specific properties schema
  static ARRAY_SCHEMA = {
    bounceFactor: Float32Array, // Bounce coefficient (0-1, 0=no bounce, 1=perfect bounce)
  };

  // Sprite configuration - using static sprite
  static spriteConfig = {
    type: "static",
    textureName: "ball",
  };

  /**
   * Ball constructor - initializes ball properties
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    // Initialize ball-specific properties
    this.bounceFactor = 0.2; // Low bounce for stable piles

    // Initialize GameObject physics properties
    this.maxVel = 20; // Max velocity
    this.maxAcc = 1; // Max acceleration
    this.minSpeed = 0; // Balls can come to rest
    this.friction = 0.02; // Low friction - let balls settle naturally
    this.radius = 7; // Ball size

    // Visual range for separation (should be larger than radius)
    this.visualRange = 60; // How far ball can detect other balls

    this.x = Math.random() * config.worldWidth;
    this.y = Math.random() * config.worldHeight;

    this.awake();
  }

  /**
   * LIFECYCLE: Called when ball is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    // Reset visual properties
    this.setAlpha(1.0);
    this.setTint(0xffffff);

    // Set random scale for variety
    const scale = 0.8 + Math.random() * 0.4; // Random scale between 0.8 and 1.2
    this.setScale(scale, scale);

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
    this.setTint(colors[Math.floor(Math.random() * colors.length)]);

    // console.log(
    //   `Ball ${this.index} spawned at (${this.x.toFixed(1)}, ${this.y.toFixed(
    //     1
    //   )})`
    // );
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
   */
  tick(dtRatio, inputData) {
    const i = this.index;

    // Keep balls within world bounds with bouncing
    this.bounceOffBounds(i, dtRatio);

    // Update rotation based on velocity (balls roll)
    this.updateRotation(i, dtRatio);
  }

  /**
   * Bounce off world boundaries
   */
  bounceOffBounds(i, dtRatio) {
    const margin = GameObject.radius[i];
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;
    const bounceFactor = Ball.bounceFactor[i];

    // Bounce off left/right walls
    if (GameObject.x[i] <= margin) {
      GameObject.x[i] = margin;
      GameObject.vx[i] = Math.abs(GameObject.vx[i]) * bounceFactor;
    } else if (GameObject.x[i] >= worldWidth - margin) {
      GameObject.x[i] = worldWidth - margin;
      GameObject.vx[i] = -Math.abs(GameObject.vx[i]) * bounceFactor;
    }

    // Bounce off top/bottom walls
    if (GameObject.y[i] <= margin) {
      GameObject.y[i] = margin;
      GameObject.vy[i] = Math.abs(GameObject.vy[i]) * bounceFactor;
    } else if (GameObject.y[i] >= worldHeight - margin) {
      GameObject.y[i] = worldHeight - margin;
      GameObject.vy[i] = -Math.abs(GameObject.vy[i]) * bounceFactor;

      // Add friction when bouncing on ground
      GameObject.vx[i] *= 0.95;
    }
  }

  /**
   * Update rotation based on velocity (rolling effect)
   */
  updateRotation(i, dtRatio) {
    // Rotate based on horizontal velocity
    const angularVelocity = GameObject.vx[i] * 0.02;
    GameObject.rotation[i] += angularVelocity * dtRatio;
  }

  /**
   * Unity-style collision callback: Called when balls collide
   */
  onCollisionEnter(otherIndex) {
    // Could add collision effects here
  }

  /**
   * Unity-style collision callback: Called while balls are colliding
   */
  onCollisionStay(otherIndex) {
    // Could add ongoing collision effects here
  }

  /**
   * Unity-style collision callback: Called when collision ends
   */
  onCollisionExit(otherIndex) {
    // Could add effects when balls separate
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Ball;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Ball = Ball;
}
