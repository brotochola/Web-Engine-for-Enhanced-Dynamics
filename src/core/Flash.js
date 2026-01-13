// Flash.js - Short-lived light flashes (muzzle flashes, sparks, impacts, etc.)
// Flashes are GameObjects with LightEmitter + FlashComponent
// They fade out over their lifespan and auto-despawn when expired
// Update logic runs in particle_worker (not logic workers)

import { GameObject } from "./gameObject.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { FlashComponent } from "../components/FlashComponent.js";
import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { Camera } from "./Camera.js";

export class Flash extends GameObject {
  // Flash is an internal engine class - no user script needed
  static scriptUrl = null;

  // Components: Transform (default) + LightEmitter + FlashComponent + Collider
  // Collider with 0 radius is needed for spatial grid (shadow casting)
  // No RigidBody or SpriteRenderer needed
  static components = [LightEmitter, FlashComponent, Collider];

  // Pool tracking (set by gameEngine during auto-registration)
  static maxFlashes = 0;
  static initialized = false;

  /**
   * Initialize Flash system with pool size
   * Called by gameEngine during initialization
   * @param {number} maxFlashes - Number of flashes in pool
   */
  static initialize(maxFlashes) {
    this.maxFlashes = maxFlashes;
    this.initialized = true;
    console.log(
      `⚡ Flash: Initialized with ${maxFlashes} flashes (indices ${
        this.startIndex
      }-${this.startIndex + maxFlashes - 1})`
    );
  }

  /**
   * Check if a world position is visible on screen
   * Uses Camera static class for viewport state
   * @param {number} worldX - World X position
   * @param {number} worldY - World Y position
   * @returns {boolean} - True if visible
   */
  static isOnScreen(worldX, worldY) {
    // Use Camera's isOnScreen with margin for light radius
    return Camera.isOnScreen(worldX, worldY, 100);
  }

  /**
   * Create a flash at the specified position
   * Static API similar to ParticleEmitter.emit()
   *
   * NOTE: Unlike regular GameObjects, Flash uses direct slot scanning instead
   * of the free list system. This is because flashes are expired by particle_worker
   * which can't access the free list. We scan for inactive slots like particles do.
   *
   * @param {Object} config - Flash configuration
   * @param {number} config.x - X position in world coordinates
   * @param {number} config.y - Y position in world coordinates
   * @param {number} [config.z=50] - Height of the light source
   * @param {number} [config.lifespan=100] - Duration in milliseconds
   * @param {number} [config.color=0xFFFFFF] - Light color (0xRRGGBB)
   * @param {number} [config.intensity=10000] - Initial light intensity
   * @returns {Flash|null} - The created flash instance, or null if pool exhausted
   *
   * @example
   * // Muzzle flash
   * Flash.create({
   *   x: gun.x + 20,
   *   y: gun.y,
   *   z: 30,
   *   lifespan: 80,
   *   color: 0xFFAA00,
   *   intensity: 40000
   * });
   *
   * @example
   * // Bullet impact spark
   * Flash.create({
   *   x: impactX,
   *   y: impactY,
   *   z: 10,
   *   lifespan: 50,
   *   color: 0xFFFFFF,
   *   intensity: 20000
   * });
   */
  static create(config) {
    if (!this.initialized) {
      console.warn("Flash.create() called before initialization");
      return null;
    }

    // Skip flashes that are off-screen (no point rendering them)
    if (!this.isOnScreen(config.x, config.y)) {
      return null;
    }

    // Scan for inactive flash slot (like ParticleEmitter does)
    // We can't use the free list because particle_worker expires flashes
    // and can't return indices to the free list
    const startIndex = this.startIndex;
    const endIndex = startIndex + this.maxFlashes;

    for (let i = startIndex; i < endIndex; i++) {
      // Check if this slot is inactive (Transform.active === 0)
      if (Transform.active[i] === 0) {
        // Found an inactive slot - activate it
        const instance = this.instances[i - startIndex];

        if (!instance) {
          console.error(`Flash: No instance at index ${i}`);
          continue;
        }

        // Activate the entity
        Transform.active[i] = 1;

        // Call onSpawned with config
        instance.onSpawned({
          x: config.x,
          y: config.y,
          z: config.z ?? 50,
          lifespan: config.lifespan ?? 100,
          color: config.color ?? 0xffffff,
          intensity: config.intensity ?? 10000,
        });

        return instance;
      }
    }

    // Pool exhausted
    console.warn(
      `Flash.create(): No inactive flash available! All ${this.maxFlashes} flashes are active.`
    );
    return null;
  }

  /**
   * LIFECYCLE: Configure flash properties
   */
  setup() {
    // Flashes don't need any special setup
    // All configuration happens in onSpawned
  }

  /**
   * LIFECYCLE: Called when flash is spawned from pool
   * @param {Object} spawnConfig - Spawn configuration from Flash.create()
   */
  onSpawned(spawnConfig = {}) {
    // Set position
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;

    // Set light emitter properties
    this.lightEmitter.height = spawnConfig.z ?? 50;
    this.lightEmitter.lightColor = spawnConfig.color ?? 0xffffff;
    this.lightEmitter.lightIntensity = spawnConfig.intensity ?? 10000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0; // Flashes don't render a glow sprite

    // Set flash component properties
    this.flashComponent.lifespan = spawnConfig.lifespan ?? 100;
    this.flashComponent.currentLife = 0;
    this.flashComponent.initialIntensity = spawnConfig.intensity ?? 10000;
    this.flashComponent.active = 1;

    // Set collider for spatial grid (needed for shadow casting via neighbor system)
    this.collider.active = 1;
    this.collider.radius = 0; // 0 radius - just need to be in the grid
    this.collider.visualRange = Math.sqrt(this.flashComponent.initialIntensity);
    this.collider.isTrigger = 1;
  }

  /**
   * LIFECYCLE: Called when flash is despawned
   */
  onDespawned() {
    // Turn off light and collider
    this.lightEmitter.active = 0;
    this.flashComponent.active = 0;
    this.collider.active = 0;
  }

  // Note: tick() is NOT used - flash updates happen in particle_worker.updateFlashes()
}
