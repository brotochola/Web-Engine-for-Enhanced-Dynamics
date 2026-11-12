// Flash.js - Short-lived light flashes (muzzle flashes, sparks, impacts, etc.)
// Flashes are GameObjects with LightEmitter + FlashComponent
// They fade out over their lifespan and auto-despawn when expired
// Updated via tick() like any other GameObject
//
// NOT in the spatial grid: Flash has no Collider, so it is never inserted into
// grid cells and never receives neighbor data.  The pre_render_worker finds
// shadow casters near a flash via a direct grid query instead.

import { GameObject } from './gameObject.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { FlashComponent } from '../components/flashComponent.js';
import { Transform } from '../components/transform.js';
import { Camera } from './camera.js';
import { debugWorkerLog } from '../util/debugLog.js';

export class Flash extends GameObject {
  // Flash is an internal engine class - no user script needed
  static scriptUrl = null;

  // Components: Transform (default) + LightEmitter + FlashComponent
  // No Collider — Flash is excluded from the spatial grid entirely.
  // No RigidBody or SpriteRenderer needed
  static components = [LightEmitter, FlashComponent];

  // Pool tracking (set by Scene when lighting.maxFlashes > 0)
  static maxFlashes = 0;
  static initialized = false;

  // Reused spawn payload (per-worker module instance; spawn is sync/non-reentrant)
  static _spawnScratch = {
    x: 0,
    y: 0,
    z: 0,
    lifespan: 100,
    color: 0xffffff,
    radius: 1000,
    brightness: 1,
    glow: 0.2,
    castShadows: 1,
  };

  /**
   * Initialize Flash system with pool size
   * Called by Scene during scene init
   * @param {number} maxFlashes - Number of flashes in pool
   */
  static initialize(maxFlashes) {
    this.maxFlashes = maxFlashes;
    this.initialized = true;
    debugWorkerLog(
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
   * Spawn a flash at the specified position.
   * Calls GameObject.spawn (not this.spawn) so Flash.spawn does not recurse.
   *
   * @param {Object} config - Flash configuration
   * @param {number} config.x - X position in world coordinates
   * @param {number} config.y - Y position in world coordinates
   * @param {number} [config.z=0] - How far up the screen the flash is drawn, pool and glow (its offsetY is -z)
   * @param {number} [config.lifespan=100] - Duration in milliseconds
   * @param {number} [config.color=0xFFFFFF] - Light color (0xRRGGBB)
   * @param {number} [config.radius=1000] - Initial reach in px
   * @param {number} [config.brightness=1] - Times the colour and the glow
   * @param {number} [config.glow=0.2] - Initial halo alpha (0 = no halo)
   * @param {boolean|number} [config.castShadows=true] - Point shadows (false/0 = lighting only)
   * @returns {Flash|null} - The spawned flash instance, or null if pool exhausted/off-screen
   *
   * @example
   * Flash.spawn({
   *   x: gun.x + 20,
   *   y: gun.y,
   *   z: 30,
   *   lifespan: 80,
   *   color: 0xFFAA00,
   *   radius: 2000,
   *   castShadows: false,
   * });
   */
  static spawn(config) {
    if (!this.initialized) {
      console.warn('Flash.spawn() called before initialization');
      return null;
    }

    // Skip flashes that are off-screen (no point rendering them)
    if (!this.isOnScreen(config.x, config.y)) {
      return null;
    }

    const s = this._spawnScratch;
    s.x = config.x;
    s.y = config.y;
    s.z = config.z ?? 0;
    s.lifespan = config.lifespan ?? 100;
    s.color = config.color ?? 0xffffff;
    s.radius = config.radius ?? 1000;
    s.brightness = config.brightness ?? 1;
    s.glow = config.glow ?? 0.2;
    s.castShadows =
      config.castShadows !== 0 && config.castShadows !== false ? 1 : 0;

    return super.spawn(s);
  }

  /**
   * LIFECYCLE: Called when flash is spawned from pool
   * @param {Object} spawnConfig - Spawn configuration from Flash.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Set position
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;

    // Set light emitter properties: z lifts the pool and the glow together (offsetY is local, a flash never turns).
    this.lightEmitter.offsetY = -(spawnConfig.z ?? 0);
    this.lightEmitter.color = spawnConfig.color ?? 0xffffff;
    this.lightEmitter.radius = spawnConfig.radius ?? 1000;
    this.lightEmitter.brightness = spawnConfig.brightness ?? 1;
    this.lightEmitter.glow = spawnConfig.glow ?? 0.2;
    this.lightEmitter.active = 1;

    // Set flash component properties
    this.flashComponent.lifespan = spawnConfig.lifespan ?? 100;
    this.flashComponent.currentLife = 0;
    this.flashComponent.initialRadius = this.lightEmitter.radius;
    this.flashComponent.initialGlow = this.lightEmitter.glow;
    this.flashComponent.castShadows =
      spawnConfig.castShadows !== 0 && spawnConfig.castShadows !== false ? 1 : 0;
    this.flashComponent.active = 1;
  }

  /**
   * LIFECYCLE: Called when flash is despawned
   */
  onDespawned() {
    this.lightEmitter.active = 0;
    this.flashComponent.active = 0;
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

    // Fade: the reach as the square root of what is left, the glow linearly (the falloff's I = (radius / 10)² falls
    // linearly).
    const remaining = 1 - (nextLife / lifespan);
    const left = Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
    LightEmitter.radius[i] = fc.initialRadius[i] * Math.sqrt(left);
    LightEmitter.glow[i] = fc.initialGlow[i] * left;
  }
}
