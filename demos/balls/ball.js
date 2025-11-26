import { GameObject } from '/src/core/gameObject.js';
import { RigidBody } from '/src/components/RigidBody.js';
import { Collider } from '/src/components/Collider.js';
import { SpriteRenderer } from '/src/components/SpriteRenderer.js';

class Ball extends GameObject {
  static entityType = 1; // 1 = Ball
  static instances = []; // Instance tracking for this class

  // Define components this entity uses
  static components = [RigidBody, Collider, SpriteRenderer];

  // Sprite configuration - using static sprite
  static spriteConfig = {
    type: 'static',
    textureName: 'ball',
  };

  /**
   * Ball constructor - initializes ball properties
   * @param {number} index - Position in shared arrays
   * @param {Object} componentIndices - Component indices { transform, rigidBody, collider, spriteRenderer }
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, componentIndices, config = {}, logicWorker = null) {
    super(index, componentIndices, config, logicWorker);
  }

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

    // Set initial position in RigidBody (physics)
    this.rigidBody.x = Math.random() * (config.worldWidth || 7600);
    this.rigidBody.y = Math.random() * 100 + 50; // Spawn near top
    this.rigidBody.vx = 0;
    this.rigidBody.vy = 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    // Sync Transform with RigidBody position (renderer uses Transform.worldX/Y)
    this.transform.localX = this.rigidBody.x;
    this.transform.localY = this.rigidBody.y;
    this.transform.worldX = this.rigidBody.x;
    this.transform.worldY = this.rigidBody.y;

    const actualBallSize = 14; //png width
    const ballRadius = Math.random() * 20 + 10;
    this.collider.radius = ballRadius;

    // Set visual range for spatial queries
    this.collider.visualRange = (config.spatial?.cellSize || 80) * 2;

    const scale = (ballRadius * 2) / actualBallSize;

    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

    this.setSpriteProp('anchor.y', 0.5);
    this.setSpriteProp('anchor.x', 0.5);

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
    this.setTint(colors[Math.floor(Math.random() * colors.length)]);
  }

  onCollisionEnter(otherIndex) {
    this.setTint(0xff0000);
  }

  onCollisionExit(otherIndex) {
    this.setTint(0xffffff);
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
    const rigidBody = this.rigidBody;
    const angularVelocity = rigidBody.vx * 0.02;
    rigidBody.rotation += angularVelocity * dtRatio;
  }
}

// ES6 module export
export { Ball };
