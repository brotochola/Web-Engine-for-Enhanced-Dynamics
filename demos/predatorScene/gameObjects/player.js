// Player.js - Player-controlled character
// Extends GameObject to create a WASD-controlled player entity

import WEED from '/src/index.js';

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
  NavGrid,
  getDirectionFromVector,
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
    this.rigidBody.linearDamping = 0.03; // Linear damping for smooth stopping

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

    // Shadow uses default heightMultiplier = 1 (matches sprite scale)

    // Store last direction for idle animations
    this.lastDirection = 'down';

    // Movement acceleration (px/s²) — was 0.3 frame units
    this.moveAcceleration = 1080;
  }
  // Reusable vectors (zero GC)
  _flowVec = { x: 0, y: 0 };
  _nextPos = { x: 0, y: 0 };
  _pathArray = [];

  /**
   * Test pathfinding - call from tick() to test NavGrid functionality
   * Demonstrates the zero-GC pattern: pass pre-created objects for results
   * Delete this method when done testing
   */
  testPathFinding() {
    // IMPORTANT: Must pass pre-created objects, NOT null!
    // NavGrid methods write INTO these objects (zero GC pattern)

    // Flowfield: for masses of agents going to same target
    const flowResult = { x: 0, y: 0 };
    NavGrid.requestVector(this.x, this.y, Mouse.x, Mouse.y, flowResult);
    // flowResult now contains direction vector (normalized or 0,0 if not ready)

    // A* next position: for single agent path following
    const nextPos = { x: 0, y: 0 };
    NavGrid.getNextAStarPosition(this.x, this.y, Mouse.x, Mouse.y, nextPos);
    // nextPos now contains next cell center to move to

    // A* full path: for planning, debugging, or UI display
    const pathArray = [];
    NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, pathArray);
    // pathArray now contains [{x,y}, ...] of all waypoints
  }

  shoot(x, y) {
    if (rng() > 0.5) return;
    // Raycast from player position to target
    const hitEntityIndex = Ray.cast(
      this.x,
      this.y - 25,
      x,
      y,
      1500 // max distance
    );

    Flash.spawn({
      x: this.x + (this.vx > 0 ? 35 : -35),
      y: this.y - 35,
      z: 0, // height
      lifespan: 17,
      color: 0xffbb11, // orange
      intensity: 25000,
    });
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
    this.setSpritesheet('poli');
    this.setAnimation('idle_down');
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

    // TEST: Hold SPACE to use pathfinding instead of WASD
    if (Keyboard.isDown(' ')) {
      this.testPathFinding();
    } else {
      // Handle WASD input for movement
      this.handleMovement();
    }

    // Update camera to follow player
    this.updateCameraFollow(i);

    // Update animation based on movement
    this.updateAnimation(i);

    // Handle shooting with left mouse button
    Mouse.isButton0Down && this.shoot(Mouse.x, Mouse.y);
  }

  handleMovement() {
    const moveForce = this.moveAcceleration;

    if (Keyboard.isDown('w')) this.addAcceleration(0, -moveForce);
    if (Keyboard.isDown('s')) this.addAcceleration(0, moveForce);
    if (Keyboard.isDown('a')) this.addAcceleration(-moveForce, 0);
    if (Keyboard.isDown('d')) this.addAcceleration(moveForce, 0);
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

    // Determine animation state based on speed
    if (speed > 0.5) {
      const direction = getDirectionFromVector(this.rigidBody.vx, this.rigidBody.vy);
      this.lastDirection = direction;

      // Choose walk or run based on speed threshold
      const isRunning = speed > 180; // px/s — was 3 frame units
      const animPrefix = isRunning ? 'run' : 'walk';

      // Set animation with speed-based animation speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed / 860); // was speed * 0.07 on frame vel
    } else {
      // Idle - use last facing direction
      this.setAnimation(`idle_${this.lastDirection}`);
    }
  }
}
