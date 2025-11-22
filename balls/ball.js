class Ball extends RenderableGameObject {
  static entityType = 1; // 1 = Ball
  static instances = []; // Instance tracking for this class

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

    // Initialize GameObject physics properties
    this.maxVel = 100; // Max velocity
    this.maxAcc = 2; // Max acceleration
    this.minSpeed = 0; // Balls can come to rest
    this.friction = 0.01; // Low friction - let balls settle naturally

    this.x = Math.random() * config.worldWidth;
    this.y = Math.random() * config.worldHeight;
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;

    const actualBallSize = 14; //png width
    this.radius = Math.random() * 20 + 10;

    this.visualRange = this.config.spatial.cellSize * 2; // How far ball can detect other balls

    const scale = (this.radius * 2) / actualBallSize;

    this.setScale(scale, scale);

    this.setSpriteProp("anchor.y", 0.5);
    this.setSpriteProp("anchor.x", 0.5);

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

    // // Set random scale for variety
    // const scale = 0.8 + Math.random() * 0.4; // Random scale between 0.8 and 1.2
    // this.setScale(scale, scale);

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

  onCollisionEnter(otherIndex) {
    // console.log(`Ball ${this.index} collided with ball ${otherIndex}`);
    this.setTint(0xff0000);
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

    // Update rotation based on velocity (balls roll)
    this.updateRotation(i, dtRatio);
  }

  /**
   * Update rotation based on velocity (rolling effect)
   */
  updateRotation(i, dtRatio) {
    // Rotate based on horizontal velocity
    const angularVelocity = GameObject.vx[i] * 0.02;
    GameObject.rotation[i] += angularVelocity * dtRatio;
  }

  onCollisionExit(otherIndex) {
    this.setTint(0xffffff);
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
