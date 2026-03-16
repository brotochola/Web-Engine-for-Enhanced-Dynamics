import WEED from '/src/index.js';

// Destructure what we need from WEED
const { GameObject, Keyboard, Mouse, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

class Box extends GameObject {
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
    // Configure RigidBody physics properties (same for all boxes)
    this.rigidBody.maxVel = 150; // Max velocity
    this.rigidBody.minSpeed = 0; // Boxes can come to rest
    this.rigidBody.friction = 0.001; // Low friction - let boxes settle naturally

    this.onSpawned();
  }

  /**
   * LIFECYCLE: Called when box is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Get config from instance
    const config = this.config || {};
    const cellSize = config.spatial?.cellSize || 80;

    // Set the texture for this sprite
    this.setSprite('box');

    // Initialize position using ergonomic API (automatically syncs px/py for Verlet)

    this.rotation = 0;

    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    // Box dimensions - randomize size for variety
    const baseSize = 100; // The texture is 100x100
    const scaleMin = 0.5;
    const scaleMax = 4.5;
    const scaleX = Math.random() * (scaleMax - scaleMin) + scaleMin;
    const scaleY = Math.random() * (scaleMax - scaleMin) + scaleMin;

    const boxWidth = baseSize * scaleX;
    const boxHeight = baseSize * scaleY;

    // Set collider shape type to Box
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = boxWidth;
    this.collider.height = boxHeight;
    this.collider.radius = 0; // Not used for boxes, but clear it

    // Set visual range for spatial queries (half-diagonal + margin)
    const halfDiagonal = Math.hypot(boxWidth, boxHeight) / 2;
    this.collider.visualRange = halfDiagonal + cellSize;

    // Scale sprite to match collision size
    this.spriteRenderer.scaleX = scaleX;
    this.spriteRenderer.scaleY = scaleY;

    // Center the sprite anchor (0-1 range)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    // Reset visual properties
    this.setAlpha(1.0);

    // Random color tint for visual variety
    const colors = [
      0x8b4513, // Saddle Brown
      0xa0522d, // Sienna
      0xcd853f, // Peru
      0xd2691e, // Chocolate
      0xdeb887, // Burlywood
      0xf4a460, // Sandy Brown
      0xbc8f8f, // Rosy Brown
      0xd2b48c, // Tan
    ];
    this.myColor = colors[Math.floor(Math.random() * colors.length)];
    this.setTint(this.myColor);

    RigidBody.mass[this.index] *= 0.25;
    RigidBody.invMass[this.index] *= 4;
  }

  onCollisionEnter(otherIndex) {
    // Optional: visual feedback on collision
  }

  onCollisionExit(otherIndex) {
    // Optional: restore visual state
  }

  /**
   * LIFECYCLE: Called when box is despawned (returned to pool)
   */
  onDespawned() {
    // Cleanup if needed
  }

  /**
   * Main update - simple behavior for boxes
   * Note: Gravity and collision resolution are handled by physics worker
   */
  tick(dtRatio) {
    // Mouse interaction: push boxes away from cursor on click
    if (Mouse.isDown) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 > 30000) return; // Only affect nearby boxes

      // Apply repulsion force
      this.rigidBody.ax = dx; //* 0.15;
      this.rigidBody.ay = dy; //* 0.15;
    }
  }
}

// ES6 module export
export { Box };
