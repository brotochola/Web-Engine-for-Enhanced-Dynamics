import WEED from '/src/index.js';

// Destructure what we need from WEED
const { GameObject, Keyboard, Mouse, RigidBody, Collider, SpriteRenderer, rng, Query } = WEED;

class Ball extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static serializable = true;
  // entityType auto-assigned during registration (no manual ID needed!)
  static instances = []; // Instance tracking for this class
  static mousePower = 90600000;
  // Define components this entity uses
  static components = [RigidBody, Collider, SpriteRenderer];

  /**
   * LIFECYCLE: Called when ball is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {

    // this.collider.radius = spawnConfig.radius; // Mass auto-computed from area (π * r²)
    // Configure RigidBody physics properties (same for all balls)
    this.rigidBody.linearDamping = 0.2; // Low damping - let balls settle naturally
    // Set the texture for this static sprite

    const config = this.config || {};

    this.rotation = 0;

    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    // Center the sprite anchor (0-1 range)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    // Reset visual properties
    this.setAlpha(1.0);

    // Set the texture for this static sprite

    this.setSprite('ball');

    const actualBallSize = 14; //png width
    const ballRadius = spawnConfig.radius || rng() * 20 + 10;
    this.collider.radius = ballRadius; // Mass auto-computed from area (π * r²)
    // Tick never reads neighbors; spatial skips visualRange <= 0.
    this.collider.visualRange = spawnConfig.visualRange ?? 0;
    // this.setFixedRotation(1);

    const scale = (ballRadius * 2) / actualBallSize;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

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
    this.myColor = colors[Math.floor(rng() * colors.length)];
    this.setTint(this.myColor);
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

    if (this.y > this.config.worldHeight * 2) {
      this.despawn();
      return;
    }

    // Mouse interaction: push balls away from cursor on click
    if (Mouse.isButton1Down) {
      // Calculate distance using ergonomic API (clean and readable!)
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 > 300000) return; // Only affect nearby balls

      // Apply repulsion (px/s²)
      this.addAcceleration(Ball.mousePower * (dx / dist2), Ball.mousePower * (dy / dist2));
    }

    if (this.index === this.constructor.startIndex) {
      Query.queryActiveEntities([RigidBody]);
    }

    if (Keyboard.m) {
      this.rigidBody.ax = -10800;
    }

  }
}

// ES6 module export
export { Ball };
