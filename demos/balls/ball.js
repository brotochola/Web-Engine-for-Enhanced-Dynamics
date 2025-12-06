import WEED from "/src/index.js";

// Destructure what we need from WEED
const { GameObject, Keyboard, Mouse, RigidBody, Collider, SpriteRenderer } =
  WEED;

class Ball extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // entityType auto-assigned during registration (no manual ID needed!)
  static instances = []; // Instance tracking for this class

  // Define components this entity uses
  static components = [RigidBody, Collider, SpriteRenderer];

  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * All components are guaranteed to be initialized at this point
   */
  setup() {
    // Configure RigidBody physics properties (same for all balls)
    this.rigidBody.maxVel = 50; // Max velocity
    this.rigidBody.maxAcc = 2; // Max acceleration
    this.rigidBody.minSpeed = 0; // Balls can come to rest
    this.rigidBody.friction = 0.01; // Low friction - let balls settle naturally

    // Center the sprite anchor (0-1 range)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    // Set visual range for spatial queries
    const config = this.config || {};
    this.collider.visualRange = (config.spatial?.cellSize || 80) * 1.33;
  }

  onScreenEnter() {}

  onScreenExit() {}

  /**
   * LIFECYCLE: Called when ball is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Get config from instance
    const config = this.config || {};

    // Set the texture for this static sprite
    this.setSpritesheet("ball");

    // Initialize position using ergonomic API (automatically syncs px/py for Verlet)
    this.x = spawnConfig.x;
    this.y = spawnConfig.y;
    this.rotation = 0;

    // Initialize RigidBody velocities and accelerations
    this.vx = spawnConfig.vx ?? 0;
    this.vy = spawnConfig.vy ?? 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    // Randomize ball size for each spawn
    const actualBallSize = 14; //png width
    const ballRadius = Math.random() * 20 + 10;
    this.collider.radius = ballRadius;

    const scale = (ballRadius * 2) / actualBallSize;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

    // Reset visual properties
    this.setAlpha(1.0);

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
  onDespawned() {
    // console.log(`Ball ${this.index} despawned`);
  }

  /**
   * Main update - simple behavior for balls
   * Note: Gravity and collision resolution are handled by physics worker
   *
   * ERGONOMIC API DEMO: Using this.x, this.y, Mouse.x, Mouse.y for clean, readable code
   * For performance-critical loops with 1000+ entities, use direct array access instead
   */
  tick(dtRatio) {
    // Mouse interaction: push balls away from cursor on click
    if (Mouse.isDown) {
      // Calculate distance using ergonomic API (clean and readable!)
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 > 20000) return; // Only affect nearby balls

      // Apply repulsion force
      this.rigidBody.ax = dx * 0.2;
      this.rigidBody.ay = dy * 0.2;
    }

    if (Keyboard.m) {
      this.rigidBody.ax = -3;
    }
  }
}

// ES6 module export
export { Ball };
