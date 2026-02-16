// Flash.js - Short-lived light flashes (muzzle flashes, sparks, impacts, etc.)
// Flashes are GameObjects with LightEmitter + FlashComponent
// They fade out over their lifespan and auto-despawn when expired
// Updated via tick() like any other GameObject

import { GameObject } from './gameObject.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { Camera } from './Camera.js';

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
      `⚡ Flash: Initialized with ${maxFlashes} flashes (indices ${this.startIndex
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
   * Uses standard spawn() pattern like all other GameObjects
   *
   * @param {Object} config - Flash configuration
   * @param {number} config.x - X position in world coordinates
   * @param {number} config.y - Y position in world coordinates
   * @param {number} [config.z=50] - Height of the light source
   * @param {number} [config.lifespan=100] - Duration in milliseconds
   * @param {number} [config.color=0xFFFFFF] - Light color (0xRRGGBB)
   * @param {number} [config.intensity=10000] - Initial light intensity
   * @param {number} [config.hasGlowSprite=1] - Whether to render glow sprite (0 = no, 1 = yes)
   * @returns {Flash|null} - The created flash instance, or null if pool exhausted/routed
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
   */
  static create(config) {
    if (!this.initialized) {
      console.warn('Flash.create() called before initialization');
      return null;
    }

    // Skip flashes that are off-screen (no point rendering them)
    if (!this.isOnScreen(config.x, config.y)) {
      return null;
    }

    // Use standard spawn() - handles free list, active entity tracking, and query updates
    return this.spawn({
      x: config.x,
      y: config.y,
      z: config.z ?? 0,
      glowHeightOffset: config.z ?? 0,
      lifespan: config.lifespan ?? 100,
      color: config.color ?? 0xffffff,
      intensity: config.intensity ?? 10000,
      hasGlowSprite: config.hasGlowSprite ?? 1,
    });
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
    this.lightEmitter.height = spawnConfig.z ?? 0;
    this.lightEmitter.glowHeightOffset = spawnConfig.glowHeightOffset ?? 0;
    this.lightEmitter.lightColor = spawnConfig.color ?? 0xffffff;
    this.lightEmitter.lightIntensity = spawnConfig.intensity ?? 10000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = spawnConfig.hasGlowSprite ?? 1;

    // Set flash component properties
    this.flashComponent.lifespan = spawnConfig.lifespan ?? 100;
    this.flashComponent.currentLife = 0;
    const intensity = spawnConfig.intensity ?? 10000;
    this.flashComponent.initialIntensity = intensity;
    this.flashComponent.active = 1;

    // Set collider for spatial grid (needed for shadow casting via neighbor system)
    this.collider.active = 1;
    this.collider.radius = 0; // 0 radius - just need to be in the grid
    // OPTIMIZED: Calculate sqrt once when intensity is set, not every frame
    this.collider.visualRange = Math.sqrt(intensity);
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

  /**
   * LIFECYCLE: Update flash each frame
   * Fades intensity over lifespan, despawns when expired
   */
  tick(dtRatio, deltaTime) {
    const i = this.index;
    const fc = FlashComponent;

    // Guard against stale ticks after despawn/list updates.
    if (Transform.active[i] === 0 || fc.active[i] === 0) return;

    const lifespan = fc.lifespan[i];
    // Safety: if lifetime data is invalid, fail fast instead of leaking active flashes.
    if (!Number.isFinite(lifespan) || lifespan <= 0) {
      this.despawn();
      return;
    }

    const nextLife = fc.currentLife[i] + deltaTime;
    if (!Number.isFinite(nextLife)) {
      this.despawn();
      return;
    }
    fc.currentLife[i] = nextLife;

    if (nextLife >= lifespan) {
      this.despawn();
      return;
    }

    // Update light intensity (linear fade)
    const remaining = 1 - (nextLife / lifespan);
    const newIntensity = fc.initialIntensity[i] * remaining;
    LightEmitter.lightIntensity[i] = Number.isFinite(newIntensity) && newIntensity > 0 ? newIntensity : 0;
  }
}
