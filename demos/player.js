// Player.js - Player-controlled character
// Extends GameObject to create a WASD-controlled player entity

import WEED from "/src/index.js";

// Destructure what we need from WEED
const {
  GameObject,
  RigidBody,
  Collider,
  SpriteRenderer,
  ShadowCaster,
  Transform,
  Keyboard,
  Mouse,
  Camera,
  Ray,
  getDirectionFromAngle,
  rng,
  Flash,
  LightEmitter,
} = WEED;

export class Player extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // Define components this entity uses
  static components = [
    RigidBody,
    Collider,
    SpriteRenderer,
    ShadowCaster,
    // LightEmitter,
  ];

  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * All components are guaranteed to be initialized at this point
   */
  setup() {
    // Initialize physics properties
    this.rigidBody.maxVel = 5; // Maximum velocity
    this.rigidBody.maxAcc = 0.5; // Maximum acceleration
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.03; // Friction for smooth stopping

    if (this.lightEmitter) {
      this.lightEmitter.lightColor = 0xffffff;
      this.lightEmitter.lightIntensity = 2000;
      this.lightEmitter.height = 0;
      this.lightEmitter.active = 1;
      this.lightEmitter.hasGlowSprite = 0;
    }

    // Initialize collider
    this.collider.radius = 15;
    this.collider.visualRange = 100;

    // Initialize sprite renderer
    this.spriteRenderer.scaleX = 1.5;
    this.spriteRenderer.scaleY = 1.5;
    this.spriteRenderer.animationSpeed = 0.15;

    // Set anchor for character sprite (bottom-center for ground alignment)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;

    // Initialize shadow
    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = this.collider.radius * 5;

    // Store last direction for idle animations
    this.lastDirection = "down";

    // Movement acceleration strength
    this.moveAcceleration = 0.3;
  }

  shoot(x, y) {
    if (Math.random() > 0.1) return;
    // Raycast from player position to target
    const hitEntityIndex = Ray.cast(
      this.x,
      this.y,
      x,
      y,
      1500 // max distance
    );

    Flash.create({
      x: this.x,
      y: this.y,
      z: 30, // height
      lifespan: 50,
      color: 0xffaa00, // orange
      intensity: 40000,
    });

    console.log("hit", hitEntityIndex);
  }

  /**
   * LIFECYCLE: Called when player is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Get config from instance
    const config = this.config || {};

    // Initialize Transform position
    this.x = spawnConfig.x ?? (config.worldWidth || 800) / 2;
    this.y = spawnConfig.y ?? (config.worldHeight || 600) / 2;
    this.transform.rotation = 0;

    // Reset physics state
    this.rigidBody.vx = spawnConfig.vx ?? 0;
    this.rigidBody.vy = spawnConfig.vy ?? 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    // Set spritesheet and initial animation
    this.setSpritesheet("civil1");
    this.setAnimation("idle_down");
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when player is despawned (returned to pool)
   */
  onDespawned() {
    // Could save player state, etc.
  }

  /**
   * Main update - handles WASD input and movement
   */
  tick(dtRatio) {
    const i = this.index;

    // Handle WASD input for movement
    this.handleMovement(i, dtRatio);

    // Update camera to follow player
    this.updateCameraFollow(i);

    // Update animation based on movement
    this.updateAnimation(i);

    // Handle shooting with left mouse button
    Mouse.isButton0Down && this.shoot(Mouse.x, Mouse.y);
  }

  /**
   * Handle WASD keyboard input for player movement
   * @param {number} i - Entity index
   * @param {number} dtRatio - Delta time ratio (for frame-rate independence)
   */
  handleMovement(i, dtRatio) {
    // Cache array references
    const rbAX = RigidBody.ax;
    const rbAY = RigidBody.ay;

    // Reset acceleration
    rbAX[i] = 0;
    rbAY[i] = 0;

    // WASD movement (applied as acceleration)
    const moveForce = this.moveAcceleration * dtRatio;

    if (Keyboard.isDown("w")) {
      rbAY[i] -= moveForce;
    }
    if (Keyboard.isDown("s")) {
      rbAY[i] += moveForce;
    }
    if (Keyboard.isDown("a")) {
      rbAX[i] -= moveForce;
    }
    if (Keyboard.isDown("d")) {
      rbAX[i] += moveForce;
    }
  }

  /**
   * Update camera to smoothly follow the player
   * @param {number} i - Entity index
   */
  updateCameraFollow(i) {
    // Smoothly follow player position
    Camera.follow(this.x, this.y);
  }

  /**
   * Update animation based on movement speed and direction
   * @param {number} i - Entity index
   */
  updateAnimation(i) {
    const speed = this.rigidBody.speed;
    const velocityAngle = this.rigidBody.velocityAngle;

    // Determine animation state based on speed
    if (speed > 0.5) {
      // Moving - determine direction
      const direction = getDirectionFromAngle(velocityAngle);
      this.lastDirection = direction;

      // Choose walk or run based on speed threshold
      const isRunning = speed > 3;
      const animPrefix = isRunning ? "run" : "walk";

      // Set animation with speed-based animation speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.07);
    } else {
      // Idle - use last facing direction
      this.setAnimation(`idle_${this.lastDirection}`);
    }
  }
}
