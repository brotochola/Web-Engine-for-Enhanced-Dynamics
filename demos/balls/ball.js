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

    // Initialize Transform position
    this.transform.x = Math.random() * (config.worldWidth || 7600);
    this.transform.y = Math.random() * 1000 + 50; // Spawn spread out vertically
    this.transform.rotation = 0;

    // Initialize RigidBody physics properties
    this.rigidBody.px = this.transform.x; // Initialize previous position for Verlet
    this.rigidBody.py = this.transform.y;
    this.rigidBody.vx = 0;
    this.rigidBody.vy = 0;
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

    this.setSpriteProp("anchor.y", 0.5);
    this.setSpriteProp("anchor.x", 0.5);

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
   */
  tick(dtRatio, inputData) {
    if (inputData[3]) {
      const dist2 =
        (this.transform.x - inputData[0]) ** 2 +
        (this.transform.y - inputData[1]) ** 2;
      if (dist2 > 20000) return;

      this.rigidBody.ax = (this.transform.x - inputData[0]) * 0.2;
      this.rigidBody.ay = (this.transform.y - inputData[1]) * 0.2;
    }

    //  //on click of the mouse, make the balls that are close, to explode (add ax and ay
    //  if(gameEngine.mouse.isDown){
    //   const ball = this.rigidBody;
    //   ball.ax = 1;
    //   ball.ay = 1;
    //  }
  }
}

// ES6 module export
export { Ball };
