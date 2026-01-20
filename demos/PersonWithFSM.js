// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from "/src/index.js";
import { CivilianBehaviorFSM } from "./CivilianBehaviorFSM.js";
import { NavGrid } from "../src/core/NavGrid.js";
import { Mouse } from "../src/core/Mouse.js";

const {
  GameObject,
  RigidBody,
  Collider,
  SpriteRenderer,
  ShadowCaster,
  Transform,
  rng,
  getDirectionFromAngle,
} = WEED;

export class PersonWithFSM extends GameObject {
  // Auto-detected by GameEngine
  static scriptUrl = import.meta.url;

  // Components: basic physics + rendering + our FSM
  static components = [
    RigidBody,
    Collider,
    SpriteRenderer,
    ShadowCaster,
    CivilianBehaviorFSM,
  ];

  /**
   * LIFECYCLE: Configure entity TYPE properties - runs ONCE per instance
   */
  setup() {
    // Physics properties
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.15;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.05;

    // Collision/perception
    this.collider.radius = 10;
    this.collider.visualRange = 150; // How far they can see predators

    // Sprite setup
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;
    this.spriteRenderer.animationSpeed = 0.15;

    // Shadow
    this.shadowCaster.shadowRadius = 10;
    this.shadowCaster.height = 50;

    // For tracking facing direction
    this.lastDirection = "down";
  }

  /**
   * LIFECYCLE: Called when spawned - runs EVERY spawn
   */
  onSpawned(spawnConfig = {}) {
    // Random spritesheet for variety
    const spritesheets = ["civil5", "civil6", "civil7"];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation("idle_down");

    // Random scale
    const scale = 0.8 + rng() * 0.4;
    this.setScale(scale, scale);
    this.collider.radius = 10 * scale;
    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = this.collider.radius * 5;
  }

  /**
   * LIFECYCLE: Main update loop
   */
  tick(dt) {
    // Update the FSM - handles state transitions and calls onUpdate
    this.civilianBehaviorFSM.tick(dt, this);

    let vec = { x: 0, y: 0 };

    NavGrid.requestVector(this.x, this.y, 10000, 7000, vec);

    this.addAcceleration(vec.x, vec.y);

    // Keep within world bounds
    this.keepWithinBounds(dt);
    this.updateAnimation();
  }
  calculateAStarToMouse() {
    const path = [];
    NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, path);
    console.log("path", path);
    return path;

  }

  updateAnimation() {
    // Cache array references for reading

    const velocityAngle = this.rigidBody.velocityAngle;

    const speed = this.rigidBody.speed;

    // Determine animation state based on speed and direction
    // NEW API: Use animation names directly from the spritesheet!

    // Only update lastDirection when speed is high enough for stable velocity angle
    // At very low speeds, atan2 becomes unstable and causes direction flickering

    const direction = getDirectionFromAngle(velocityAngle);
    this.lastDirection = direction;

    if (speed > 0.1) {
      // Choose walk or run based on speed threshold
      const isRunning = speed > 2;
      const animPrefix = isRunning ? "run" : "walk";

      // Set animation and speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.07);
    } else {
      // Use idle animation in last facing direction
      this.setAnimation(`idle_${direction}`);
    }
  }

  /**
   * Keep entity within world boundaries
   */
  keepWithinBounds(dt) {
    const margin = 50;
    const turnFactor = 0.1;
    const i = this.index;

    const x = Transform.x[i];
    const y = Transform.y[i];
    const worldWidth = this.config.worldWidth || 1000;
    const worldHeight = this.config.worldHeight || 1000;

    if (x < margin) {
      RigidBody.ax[i] += turnFactor * dt;
    }
    if (x > worldWidth - margin) {
      RigidBody.ax[i] -= turnFactor * dt;
    }
    if (y < margin) {
      RigidBody.ay[i] += turnFactor * dt;
    }
    if (y > worldHeight - margin) {
      RigidBody.ay[i] -= turnFactor * dt;
    }
  }
}
