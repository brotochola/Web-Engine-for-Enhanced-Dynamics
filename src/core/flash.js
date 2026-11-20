// Flash.js - Short-lived light flashes (muzzle flashes, sparks, impacts, etc.)
// Flashes are GameObjects with LightEmitter + FlashComponent
// They fade out over their lifespan and auto-despawn when expired
// Written the ECS way (E-536): Flash.spawnIndex spawns one with no instance, and its hooks and its tick are statics by
// index (tickAll), so the flashes of a gunfight make no object; Flash.spawn is the object way's form, the instance.
//
// NOT in the spatial grid: Flash has no Collider, so it is never inserted into grid cells and never receives
// neighbor data. Its point shadows come from the shadow stamp, which grids the casters itself; castShadows: false
// (LightEmitter.castShadows 0) keeps it out of the stamp.

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
    // DX-GLOWRADIUS: the halo's own radius (a double from the start: NaN until a spawn writes it).
    glowRadius: NaN,
    castShadows: 1,
    // DX-SPOT: a cone. Doubles from the start (NaN until a spawn writes them), so the payload keeps one shape.
    direction: NaN,
    coneAngle: Math.PI * 2,
    coneSoftness: NaN,
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
   * Spawn a flash at the specified position, by index (no instance).
   * Calls GameObject.spawnIndex (super) so Flash.spawnIndex does not recurse.
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
   * @param {number} [config.glowRadius=0] - The halo's radius in px, as it shows (LightEmitter.glowRadius: a compact
   *   glow); 0 draws the wide gradient at 0.85 of the radius
   * @param {boolean|number} [config.castShadows=true] - Point shadows (false/0 = lighting only)
   * @param {number} [config.coneAngle=2π] - A cone's whole aperture in radians (2π: round), as LightEmitter's
   * @param {number} [config.coneSoftness=0] - 0..1, how much of the cone's edge fades
   * @param {number} [config.direction=0] - Radians, where the cone points (a flash never turns: in the world's frame)
   * @returns {number} - The flash's entity index, or -1 if not initialized, off-screen or the pool is full
   *
   * @example
   * Flash.spawnIndex({
   *   x: gun.x + 20,
   *   y: gun.y,
   *   z: 30,
   *   lifespan: 80,
   *   color: 0xFFAA00,
   *   radius: 2000,
   *   castShadows: false,
   * });
   *
   * @example
   * // A muzzle flash that lights ahead of the barrel only.
   * Flash.spawnIndex({ x: muzzleX, y: muzzleY, radius: 900, coneAngle: Math.PI / 2, coneSoftness: 0.6, direction: aim });
   */
  static spawnIndex(config) {
    if (!this.initialized) {
      console.warn('Flash.spawnIndex() called before initialization');
      return -1;
    }

    // Skip flashes that are off-screen (no point rendering them)
    if (!this.isOnScreen(config.x, config.y)) {
      return -1;
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
    s.glowRadius = config.glowRadius ?? 0;
    s.castShadows =
      config.castShadows !== 0 && config.castShadows !== false ? 1 : 0;
    s.direction = config.direction ?? 0;
    s.coneAngle = config.coneAngle ?? Math.PI * 2;
    s.coneSoftness = config.coneSoftness ?? 0;

    return super.spawnIndex(s);
  }

  /**
   * The object way's form of spawnIndex: the flash's instance, or null when none was spawned.
   * @param {Object} config - as spawnIndex's
   * @returns {Flash|null}
   */
  static spawn(config) {
    const i = this.spawnIndex(config);
    return i < 0 ? null : GameObject.get(i);
  }

  /**
   * LIFECYCLE: a flash spawned from the pool, by index (spawnIndex's config: Flash.spawnIndex fills every key).
   * @param {number} i - its entity index
   * @param {Object} spawnConfig
   */
  static onSpawned(i, spawnConfig) {
    Transform.setPosition(i, spawnConfig.x ?? 0, spawnConfig.y ?? 0);

    // Its light: z lifts the pool and the glow together (offsetY is local, a flash never turns).
    LightEmitter.offsetY[i] = -(spawnConfig.z ?? 0);
    LightEmitter.color[i] = spawnConfig.color ?? 0xffffff;
    LightEmitter.radius[i] = spawnConfig.radius ?? 1000;
    LightEmitter.brightness[i] = spawnConfig.brightness ?? 1;
    LightEmitter.setGlow(i, spawnConfig.glow ?? 0.2);
    LightEmitter.setGlowRadius(i, spawnConfig.glowRadius ?? 0);
    LightEmitter.active[i] = 1;
    LightEmitter.castShadows[i] = spawnConfig.castShadows !== 0 && spawnConfig.castShadows !== false ? 1 : 0;
    // DX-SPOT: its cone (2π, the default, is round); a flash never turns, so the direction is the world's.
    LightEmitter.setConeAngle(i, spawnConfig.coneAngle ?? Math.PI * 2);
    LightEmitter.setConeSoftness(i, spawnConfig.coneSoftness ?? 0);
    LightEmitter.setDirection(i, spawnConfig.direction ?? 0);

    // Its life, and the light it fades from.
    FlashComponent.lifespan[i] = spawnConfig.lifespan ?? 100;
    FlashComponent.currentLife[i] = 0;
    FlashComponent.initialRadius[i] = LightEmitter.radius[i];
    FlashComponent.initialGlow[i] = LightEmitter.glow[i];
    FlashComponent.active[i] = 1;
  }

  /** LIFECYCLE: a flash despawned, by index: its light and its life off. */
  static onDespawned(i) {
    LightEmitter.active[i] = 0;
    FlashComponent.active[i] = 0;
  }

  /**
   * Each frame, every flash of this worker: fades its light over its lifespan, despawns it when expired.
   * @param {ArrayLike<number>} list
   * @param {number} count
   * @param {number} dtRatio - the frame's (1 = 16.67 ms)
   */
  static tickAll(list, count, dtRatio) {
    const fc = FlashComponent;
    const deltaTime = dtRatio * 16.67;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      // Guard against stale ticks after despawn/list updates.
      if (Transform.active[i] === 0 || fc.active[i] === 0) continue;

      const lifespan = fc.lifespan[i];
      // Safety: if lifetime data is invalid, fail fast instead of leaking active flashes.
      if (!Number.isFinite(lifespan) || lifespan <= 0) {
        this.despawn(i);
        continue;
      }

      const nextLife = fc.currentLife[i] + deltaTime;
      if (!Number.isFinite(nextLife)) {
        this.despawn(i);
        continue;
      }
      fc.currentLife[i] = nextLife;

      if (nextLife >= lifespan) {
        this.despawn(i);
        continue;
      }

      // Fade: the reach as the square root of what is left, the glow linearly (the falloff's I = (radius / 10)²
      // falls linearly).
      const remaining = 1 - nextLife / lifespan;
      const left = Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
      LightEmitter.radius[i] = fc.initialRadius[i] * Math.sqrt(left);
      LightEmitter.glow[i] = fc.initialGlow[i] * left;
    }
  }
}
