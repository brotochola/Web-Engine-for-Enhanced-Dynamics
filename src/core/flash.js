// Flash.js - Short-lived light flashes (muzzle flashes, sparks, impacts, etc.)
// Flashes are GameObjects with LightEmitter + FlashComponent
// They fade out over their lifespan and auto-despawn when expired
// Written the ECS way (E-536): Flash.spawnIndex spawns one with no instance, and its hooks and its tick are statics by
// index (tickAll), so the flashes of a gunfight make no object; Flash.spawn is the object way's form, the instance.
// E-538: a flash a game fires again and again is a preset (Flash.define once, Flash.spawnPreset per shot), which
// allocates nothing: one core for both forms, a config compiled into a row of numbers that onSpawned writes from.
//
// NOT in the spatial grid: Flash has no Collider, so it is never inserted into grid cells and never receives
// neighbor data. Its shadows, a tile of the lamps' shadow map, take the casters the shadow stamp picks, which grids them
// itself; they need its elevation (its source's height: at 0 it casts none), and castShadows: false (LightEmitter.castShadows
// 0) keeps it out of the stamp.

import { GameObject } from './gameObject.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { FlashComponent } from '../components/flashComponent.js';
import { Transform } from '../components/transform.js';
import { Camera } from './camera.js';
import { debugWorkerLog } from '../util/debugLog.js';

/** A flash's config compiled: one row of doubles, every key with its default applied. */
const ROW_NAMES = [
  'X', 'Y', 'Z', 'LIFESPAN', 'COLOR', 'RADIUS', 'BRIGHTNESS', 'GLOW', 'GLOW_RADIUS', 'CAST_SHADOWS', 'DIRECTION',
  'CONE_ANGLE', 'CONE_SOFTNESS', 'ELEVATION',
];
const F = Object.freeze(Object.fromEntries(ROW_NAMES.map((name, i) => [name, i])));
const ROW_SLOTS = ROW_NAMES.length;

/** The keys a flash's config can have; Flash.define refuses any other. */
export const FLASH_KEYS = Object.freeze([
  'x', 'y', 'z', 'lifespan', 'color', 'radius', 'brightness', 'glow', 'glowRadius', 'castShadows', 'coneAngle',
  'coneSoftness', 'direction', 'elevation',
]);
const FLASH_KEY_SET = new Set(FLASH_KEYS);

/** A Float64Array on a SharedArrayBuffer where there is one: TurboFan gives its elements an immediate address (E-473). */
function scratch64(length) {
  return new Float64Array(new (typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : ArrayBuffer)(length * 8));
}

/** The spawn's values: a literal config compiled, or a preset's row copied, then the spawn's arguments over it. */
const SPAWN_ROW = scratch64(ROW_SLOTS);

/** spawnPreset's arguments and the with* overrides, for the next spawn on this thread (NaN: not given). */
const SPAWN_ARGS = scratch64(6);
const ARG_X = 0;
const ARG_Y = 1;
const ARG_Z = 2;
const ARG_DIRECTION = 3;
const ARG_RADIUS = 4;
const ARG_GLOW = 5;
SPAWN_ARGS.fill(NaN);

/**
 * The spawn config a worker's flash spawn passes GameObject.spawnIndex: "the values are in SPAWN_ROW", with no keys
 * for the engine's own spawn keys to apply. A Flash spawn stays on the thread that asks for it (no
 * forceProcessOnLogicWorker), so this never travels; the page posts a real config.
 */
const FROM_ROW = {};

let presetRows = new Float64Array(ROW_SLOTS * 8);
let presetCount = 0;
/** spawnIndex compiled its config into SPAWN_ROW for the _spawnRow it calls (false: a preset's spawn). */
let literalSpawn = false;

/** A config into the row at T[o], with Flash's defaults. */
function compileFlash(T, o, cfg) {
  T[o + F.X] = cfg.x ?? 0;
  T[o + F.Y] = cfg.y ?? 0;
  T[o + F.Z] = cfg.z ?? 0;
  T[o + F.LIFESPAN] = cfg.lifespan ?? 100;
  T[o + F.COLOR] = cfg.color ?? 0xffffff;
  T[o + F.RADIUS] = cfg.radius ?? 1000;
  T[o + F.BRIGHTNESS] = cfg.brightness ?? 1;
  T[o + F.GLOW] = cfg.glow ?? 0.2;
  T[o + F.GLOW_RADIUS] = cfg.glowRadius ?? 0;
  T[o + F.CAST_SHADOWS] = cfg.castShadows !== 0 && cfg.castShadows !== false ? 1 : 0;
  T[o + F.DIRECTION] = cfg.direction ?? 0;
  T[o + F.CONE_ANGLE] = cfg.coneAngle ?? Math.PI * 2;
  T[o + F.CONE_SOFTNESS] = cfg.coneSoftness ?? 0;
  T[o + F.ELEVATION] = cfg.elevation ?? 0;
}

/** Flash i's light and life from SPAWN_ROW. */
function writeFlash(i) {
  const T = SPAWN_ROW;
  Transform.setPosition(i, T[F.X], T[F.Y]);

  // Its light: z lifts the pool and the glow together (offsetY is local, a flash never turns).
  LightEmitter.offsetY[i] = -T[F.Z];
  LightEmitter.color[i] = T[F.COLOR];
  LightEmitter.radius[i] = T[F.RADIUS];
  LightEmitter.brightness[i] = T[F.BRIGHTNESS];
  LightEmitter.setGlow(i, T[F.GLOW]);
  LightEmitter.setGlowRadius(i, T[F.GLOW_RADIUS]);
  LightEmitter.active[i] = 1;
  LightEmitter.castShadows[i] = T[F.CAST_SHADOWS];
  LightEmitter.elevation[i] = T[F.ELEVATION];
  // DX-SPOT: its cone (2π, the default, is round); a flash never turns, so the direction is the world's.
  LightEmitter.setConeAngle(i, T[F.CONE_ANGLE]);
  LightEmitter.setConeSoftness(i, T[F.CONE_SOFTNESS]);
  LightEmitter.setDirection(i, T[F.DIRECTION]);

  // Its life, and the light it fades from.
  FlashComponent.lifespan[i] = T[F.LIFESPAN];
  FlashComponent.currentLife[i] = 0;
  FlashComponent.initialRadius[i] = LightEmitter.radius[i];
  FlashComponent.initialGlow[i] = LightEmitter.glow[i];
  FlashComponent.active[i] = 1;
}

/** The page (main thread), not a worker: GameObject's spawn posts the config to a logic worker from there. */
function onPage() {
  return typeof window !== 'undefined' && typeof self.logicWorker === 'undefined';
}

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
  /** spawnPreset's arguments (SPAWN_ARGS), read through the class: the module binding's load and hole check would
   * take spawnPreset past V8's 75-byte inline size (particlePresetFronts.test.js). */
  static _spawnArgs = SPAWN_ARGS;

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
   * Spawn a flash at the specified position, by index (no instance): the one-off form, its config read on every
   * call. A flash a game fires again and again is a preset (define, spawnPreset).
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
   * @param {number} [config.elevation=0] - Its source's height above the floor in px, as LightEmitter.elevation: its
   *   shadows' length with the casters' heights (at 0 it casts none), and a wider, flatter pool
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
      SPAWN_ARGS.fill(NaN);
      console.warn('Flash.spawnIndex() called before initialization');
      return -1;
    }

    // Skip flashes that are off-screen (no point rendering them)
    if (!this.isOnScreen(config.x, config.y)) {
      SPAWN_ARGS.fill(NaN);
      return -1;
    }

    compileFlash(SPAWN_ROW, 0, config);
    literalSpawn = true;
    return this._spawnRow(-1);
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
   * A flash preset: the config compiled once (spawnIndex's keys, FLASH_KEYS, with spawnIndex's defaults), for
   * spawnPreset. Define presets once, at module level: a preset lives as long as its module, and each thread that
   * imports the module has its own. A key a flash does not know throws a TypeError.
   * @param {Object} config
   * @returns {number} the preset's id
   */
  static define(config) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('Flash.define(config): config must be an object');
    }
    for (const key of Object.keys(config)) {
      if (!FLASH_KEY_SET.has(key)) {
        throw new TypeError(`Flash.define: "${key}" is not a flash key (${FLASH_KEYS.join(', ')})`);
      }
    }
    const id = presetCount;
    if ((id + 1) * ROW_SLOTS > presetRows.length) {
      const grown = new Float64Array(presetRows.length * 2);
      grown.set(presetRows);
      presetRows = grown;
    }
    compileFlash(presetRows, id * ROW_SLOTS, config);
    presetCount = id + 1;
    return id;
  }

  /**
   * A flash from a preset, by index, with what varies per spawn: each argument left undefined keeps the preset's
   * value. The same flash as spawnIndex with the preset's config and these keys; nothing allocated. A front small
   * enough for V8 to inline whatever its caller's budget: the doubles go through a Float64Array, to a core that
   * takes the preset's id.
   * @param {number} preset - Flash.define's id
   * @param {number} [x]
   * @param {number} [y]
   * @param {number} [z]
   * @param {number} [direction] - Radians, where a cone points
   * @returns {number} - The flash's entity index, or -1 if not initialized, off-screen or the pool is full
   */
  static spawnPreset(preset, x, y, z, direction) {
    const a = this._spawnArgs;
    a[0] = x;
    a[1] = y;
    a[2] = z;
    a[3] = direction;
    return this._spawnRow(preset);
  }

  /**
   * The next flash spawned on this thread (spawnPreset, spawnIndex, spawn) starts with this reach in px, whatever
   * its preset or config says. Returns Flash, to chain into the spawn.
   * @param {number} radius
   */
  static withRadius(radius) {
    SPAWN_ARGS[ARG_RADIUS] = radius;
    return this;
  }

  /**
   * The next flash spawned on this thread starts with this halo alpha, whatever its preset or config says.
   * @param {number} glow
   */
  static withGlow(glow) {
    SPAWN_ARGS[ARG_GLOW] = glow;
    return this;
  }

  /**
   * The spawn: a preset's row copied into SPAWN_ROW (spawnIndex compiled its config there), the arguments and
   * overrides over it (read, then cleared), then GameObject's spawn, whose onSpawned writes the flash from the row.
   * @param {number} preset - spawnPreset's preset; ignored for spawnIndex's spawn (literalSpawn set)
   * @returns {number}
   */
  static _spawnRow(preset) {
    const a = SPAWN_ARGS;
    const T = SPAWN_ROW;
    // A preset's spawn checks its position on screen once its arguments are over it; spawnIndex checked its config's.
    const checkScreen = !literalSpawn;
    if (literalSpawn) {
      literalSpawn = false;
    } else {
      if (!(preset >= 0 && preset < presetCount) || (preset | 0) !== preset) {
        a.fill(NaN);
        throw new TypeError(`Flash.spawnPreset: ${preset} is not a preset (Flash.define's id)`);
      }
      if (!this.initialized) {
        a.fill(NaN);
        console.warn('Flash.spawnPreset() called before initialization');
        return -1;
      }
      const rows = presetRows;
      const o = preset * ROW_SLOTS;
      for (let k = 0; k < ROW_SLOTS; k++) T[k] = rows[o + k];
    }
    const x = a[ARG_X];
    const y = a[ARG_Y];
    const z = a[ARG_Z];
    const direction = a[ARG_DIRECTION];
    const radius = a[ARG_RADIUS];
    const glow = a[ARG_GLOW];
    a[ARG_X] = NaN;
    a[ARG_Y] = NaN;
    a[ARG_Z] = NaN;
    a[ARG_DIRECTION] = NaN;
    a[ARG_RADIUS] = NaN;
    a[ARG_GLOW] = NaN;
    if (x === x) T[F.X] = x;
    if (y === y) T[F.Y] = y;
    if (z === z) T[F.Z] = z;
    if (direction === direction) T[F.DIRECTION] = direction;
    if (radius === radius) T[F.RADIUS] = radius;
    if (glow === glow) T[F.GLOW] = glow;

    // Skip flashes that are off-screen (no point rendering them)
    if (checkScreen && !this.isOnScreen(T[F.X], T[F.Y])) return -1;

    if (onPage()) {
      // The page posts the spawn to a logic worker: a config of the row's values, which that worker compiles again.
      return super.spawnIndex({
        x: T[F.X],
        y: T[F.Y],
        z: T[F.Z],
        lifespan: T[F.LIFESPAN],
        color: T[F.COLOR],
        radius: T[F.RADIUS],
        brightness: T[F.BRIGHTNESS],
        glow: T[F.GLOW],
        glowRadius: T[F.GLOW_RADIUS],
        castShadows: T[F.CAST_SHADOWS],
        direction: T[F.DIRECTION],
        coneAngle: T[F.CONE_ANGLE],
        coneSoftness: T[F.CONE_SOFTNESS],
        elevation: T[F.ELEVATION],
      });
    }
    return super.spawnIndex(FROM_ROW);
  }

  /**
   * LIFECYCLE: a flash spawned from the pool, by index: from the spawn's row (Flash's own spawns), or from a config
   * (one posted from the page, or a direct call), which is compiled into the row first, with its defaults.
   * @param {number} i - its entity index
   * @param {Object} spawnConfig
   */
  static onSpawned(i, spawnConfig) {
    if (spawnConfig !== FROM_ROW) compileFlash(SPAWN_ROW, 0, spawnConfig);
    writeFlash(i);
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
