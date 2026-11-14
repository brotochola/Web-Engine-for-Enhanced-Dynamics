// BulletPool.js - Static API for spawning bullets
// Bullets are NOT GameObjects - they use BulletComponent directly
// Straight-line movement, raycast collision (prev→next), no physics
//
// EXTENDS SharedAtomicPool for thread-safe free list management

import { BulletComponent } from '../components/bulletComponent.js';
import { Transform } from '../components/transform.js';
import { Collider } from '../components/collider.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { SharedAtomicPool } from './sharedAtomicPool.js';
import { Layer } from './layer.js';
import { Ray } from './ray.js';
import { Grid } from './grid.js';
import { readyBulletStamps, writeBulletColumns } from './bulletTickClient.js';

// E-286: one spawn's numbers from spawn() to its body (x, y, vx, vy, damage, ownerId, shooterEntityType, trailWidth,
// scale, alpha, tint, anchorX, anchorY, offsetY, then the sprite's facing: cos, sin, angle).
const SPAWN_IN = new Float64Array(17);
// The layer subscription for Layer.resolveSubscriptions, which reads `layers` and `layer`; cleared after each spawn.
const SPAWN_SUBSCRIPTION = { layers: undefined, layer: undefined };

export class BulletPool extends SharedAtomicPool {
  static poolName = 'BulletPool';
  // E-129: 32-bit slot ids past 65 535 bullets.
  static slotIdsFromMax = true;
  static _warnedPoolExhausted = false;
  static _warnedMissingTextures = new Set();
  static _tickResult = { activeCount: 0, impactWrite: 0 };
  /** W19: the bullet tick kernel (bulletTickClient.js), bound by the particle worker when its columns are in one memory. */
  static _wasm = null;

  static get maxBullets() {
    return this.maxCount;
  }

  static initialize(maxBullets) {
    super.initialize(maxBullets);
    this._warnedPoolExhausted = false;
    this._warnedMissingTextures.clear();
  }

  /**
   * Spawn a bullet. Called from logic_worker when entity shoots.
   *
   * @param {Object} config
   * @param {number} config.x - Start X
   * @param {number} config.y - Start Y
   * @param {number} config.vx - Velocity X
   * @param {number} config.vy - Velocity Y
   * @param {number} config.damage - Damage on hit
   * @param {number} config.ownerId - Shooter entity index (excluded from raycast)
   * @param {number} config.shooterEntityType - Entity type ID for team/friendly fire
   * @param {string} [config.texture] - Texture name (default "bullet")
   * @param {number} [config.scale=1] - Scale
   * @param {number} [config.alpha=1] - Alpha
   * @param {number} [config.tint=0xFFFFFF] - Tint
   * @param {number} [config.rotation=0] - Rotation in radians
   * @param {number} [config.anchorX=0] - Anchor X (0=left tip, 0.5=center)
   * @param {number} [config.anchorY=0.5] - Anchor Y (0.5=vertical center)
   * @param {number} [config.offsetY=0] - Visual Y offset (e.g., muzzle height); sort at y, render at y + offsetY
   * @param {string|number} [config.layer] - Subscribe to one layer (same as layers: [layer])
   * @param {Array<string|number>} [config.layers] - Subscription list; omit = ENTITIES
   * @returns {number} Bullet index or -1 if pool full
   */
  static spawn(config) {
    // E-286: the options' numbers go to the body through SPAWN_IN, the rest as arguments, so the body never sees the
    // object. Games pass a literal here, and a literal handed to a function TurboFan does not inline (the body is too
    // big) is allocated, with a heap number for each double field, on every call; this front is small enough to be
    // inlined into the caller, where escape analysis then removes the literal. The defaults are the body's, as before.
    const f = SPAWN_IN;
    f[0] = config.x;
    f[1] = config.y;
    f[2] = config.vx;
    f[3] = config.vy;
    f[4] = config.damage;
    f[5] = config.ownerId;
    f[6] = config.shooterEntityType ?? 0;
    f[7] = config.trailWidth ?? 0;
    f[8] = config.scale ?? 1;
    f[9] = config.alpha ?? 1;
    f[10] = config.tint ?? 0xffffff;
    f[11] = config.anchorX ?? 0;
    f[12] = config.anchorY ?? 0.5;
    f[13] = config.offsetY ?? 0;
    // The sprite's facing: 1 = given as cos and sin, 2 = as an angle, 0 = the velocity's.
    let facing = 0;
    const rotC = config.spriteRotC;
    const rotS = config.spriteRotS;
    if (rotC != null && rotS != null) {
      f[14] = rotC;
      f[15] = rotS;
      facing = 1;
    } else {
      const angle = config.spriteRotation ?? config.rotation;
      if (angle != null) {
        f[16] = angle;
        facing = 2;
      }
    }
    return this._spawnIn(config.texture, config.layers, config.layer, facing);
  }

  /**
   * spawn()'s body (E-286): the numbers in SPAWN_IN; the texture name, the layer subscription (`layers`, `layer`) and
   * the facing's kind as arguments.
   * @private
   */
  static _spawnIn(texture, layers, layer, facing) {
    const i = this.acquireIndex();
    if (i < 0) {
      if (!this._warnedPoolExhausted) {
        this._warnedPoolExhausted = true;
        console.warn(
          `BulletPool.spawn: pool exhausted (maxBullets=${this.maxCount}). Increase bullet.maxBullets.`
        );
      }
      return -1;
    }

    const x = BulletComponent.x;
    const y = BulletComponent.y;
    const startX = BulletComponent.startX;
    const startY = BulletComponent.startY;
    const prevX = BulletComponent.prevX;
    const prevY = BulletComponent.prevY;
    const vx = BulletComponent.vx;
    const vy = BulletComponent.vy;
    const speed = BulletComponent.speed;
    const damage = BulletComponent.damage;
    const ownerId = BulletComponent.ownerId;
    const shooterEntityType = BulletComponent.shooterEntityType;
    const textureId = BulletComponent.textureId;
    const scale = BulletComponent.scale;
    const alpha = BulletComponent.alpha;
    const tint = BulletComponent.tint;
    const spriteRotC = BulletComponent.spriteRotC;
    const spriteRotS = BulletComponent.spriteRotS;
    const bulletRotC = BulletComponent.bulletRotC;
    const bulletRotS = BulletComponent.bulletRotS;
    const anchorX = BulletComponent.anchorX;
    const anchorY = BulletComponent.anchorY;
    const offsetY = BulletComponent.offsetY;
    const trailWidth = BulletComponent.trailWidth;
    // Every number is read before the calls below (texture, layers), which could reach another spawn.
    const f = SPAWN_IN;
    const px = f[0];
    const py = f[1];
    const pvx = f[2];
    const pvy = f[3];
    x[i] = px;
    y[i] = py;

    startX[i] = px;
    startY[i] = py;

    trailWidth[i] = f[7];

    prevX[i] = px;
    prevY[i] = py;
    vx[i] = pvx;
    vy[i] = pvy;
    damage[i] = f[4];
    ownerId[i] = f[5];
    shooterEntityType[i] = f[6];

    scale[i] = f[8];
    alpha[i] = f[9];
    tint[i] = f[10];
    {
      const speedSq = pvx * pvx + pvy * pvy;
      if (speedSq > 1e-12) {
        const inv = 1 / Math.sqrt(speedSq);
        bulletRotC[i] = pvx * inv;
        bulletRotS[i] = pvy * inv;
        speed[i] = speedSq * inv;
      } else {
        bulletRotC[i] = 1;
        bulletRotS[i] = 0;
        speed[i] = 0;
      }
    }
    if (facing === 1) {
      spriteRotC[i] = f[14];
      spriteRotS[i] = f[15];
    } else if (facing === 0) {
      spriteRotC[i] = bulletRotC[i];
      spriteRotS[i] = bulletRotS[i];
    } else {
      const a = f[16];
      spriteRotC[i] = Math.cos(a);
      spriteRotS[i] = Math.sin(a);
    }
    anchorX[i] = f[11];
    anchorY[i] = f[12];
    offsetY[i] = f[13];

    let texId = 0;
    if (texture) {
      const resolvedTextureId = SpriteSheetRegistry.getAnimationIndex('bigAtlas', texture);
      if (resolvedTextureId === undefined) {
        if (!this._warnedMissingTextures.has(texture)) {
          this._warnedMissingTextures.add(texture);
          console.warn(
            `BulletPool.spawn: texture "${texture}" not found in bigAtlas; using textureId 0.`
          );
        }
      } else {
        texId = resolvedTextureId;
      }
    }
    textureId[i] = texId;
    const subscription = SPAWN_SUBSCRIPTION;
    subscription.layers = layers;
    subscription.layer = layer;
    BulletComponent.layerMask[i] = Layer.resolveSubscriptions(subscription);
    subscription.layers = undefined;
    subscription.layer = undefined;
    BulletComponent.isItOnScreen[i] = 0;
    BulletComponent.active[i] = 1;

    return i;
  }

  /**
   * Despawn bullet by index. Called from particle_worker when bullet hits or from logic.
   */
  static despawn(i) {
    if (i < 0 || i >= this.maxCount) return;
    if (BulletComponent.active[i] === 0) return;
    BulletComponent.active[i] = 0;
    this.returnToPool(i);
  }

  /**
   * Fill `out` with indices where `active[i]` is set. Kernel override only.
   * @param {Uint16Array|Uint32Array} out (a Uint32Array past 65 535 bullets)
   * @returns {number} live count
   */
  static collectLiveIndices(out) {
    const active = BulletComponent.active;
    const maxBullets = this.maxCount;
    let n = 0;
    for (let i = 0; i < maxBullets; i++) {
      if (active[i]) out[n++] = i;
    }
    return n;
  }

  /**
   * Advance every active bullet one step: integrate, raycast prev→next, write
   * impacts, despawn on hit. Writes activeData[0] = live count.
   *
   * @param {number} dtRatio
   * @param {Uint16Array|Uint32Array} activeData [count, index, ...], at the pool's slot width (E-129: u32 past 65 535)
   * @param {Int32Array|null} impactHeader
   * @param {Float32Array|null} impactData
   * @param {number} maxImpacts
   * @param {{ speed?: Float32Array|null, excludeSet?: Set<number>|null, liveIndices?: Uint16Array|Uint32Array|null, liveCount?: number }} [opts] kernel-only
   * @returns {{ activeCount: number, impactWrite: number }}
   */
  static tick(dtRatio, activeData, impactHeader, impactData, maxImpacts, opts) {
    // W19: the kernel takes the frame when it is bound, the call is the worker's own (no kernel options), the
    // pool's list is at the kernel's width, its impact region holds the cap, and every column is in its memory. The
    // loop below runs where it cannot read the grid (no spatial workers, or the spatial memory outside the engine
    // block: no regions for it) and for the kernel-only options.
    const k = this._wasm;
    if (k !== null && opts === undefined && activeData.BYTES_PER_ELEMENT === k.activeOut.BYTES_PER_ELEMENT
      && (maxImpacts | 0) <= k.impactCap
      && writeBulletColumns(k, BulletComponent, Transform, Collider, Grid)) {
      return this._tickWasm(dtRatio, activeData, impactHeader, impactData, maxImpacts);
    }
    const bc = BulletComponent;
    const maxBullets = this.maxCount;
    const active = bc.active;
    const x = bc.x;
    const y = bc.y;
    const prevX = bc.prevX;
    const prevY = bc.prevY;
    const vx = bc.vx;
    const vy = bc.vy;
    const bulletRotC = bc.bulletRotC;
    const bulletRotS = bc.bulletRotS;
    const damage = bc.damage;
    const ownerId = bc.ownerId;
    const shooterEntityType = bc.shooterEntityType;
    const speed = opts && Object.prototype.hasOwnProperty.call(opts, 'speed') ? opts.speed : bc.speed;
    const excludeSet = opts && opts.excludeSet != null ? opts.excludeSet : null;
    const liveIndices = opts && opts.liveIndices != null ? opts.liveIndices : null;
    const liveCount = opts && opts.liveCount ? opts.liveCount : 0;

    const dt = dtRatio * (1 / 60);
    let activeWrite = 1;
    let impactWrite = 0;
    const impactCap = maxImpacts | 0;
    const useSpeed = speed != null;
    const useLive = liveIndices != null;
    const iterCount = useLive ? liveCount | 0 : maxBullets;

    for (let n = 0; n < iterCount; n++) {
      const i = useLive ? liveIndices[n] : n;
      if (!active[i]) continue;

      const px = x[i];
      const py = y[i];
      prevX[i] = px;
      prevY[i] = py;

      const dx = vx[i] * dt;
      const dy = vy[i] * dt;
      x[i] = px + dx;
      y[i] = py + dy;

      let len;
      if (useSpeed) {
        len = speed[i] * dt;
      } else {
        const lenSq = dx * dx + dy * dy;
        len = lenSq > 1e-12 ? Math.sqrt(lenSq) : 0;
      }

      if (len > 1e-6) {
        let exclude = ownerId[i];
        if (excludeSet) {
          excludeSet.clear();
          excludeSet.add(ownerId[i]);
          exclude = excludeSet;
        }
        const hit = Ray.linecastDir(px, py, bulletRotC[i], bulletRotS[i], len, exclude);
        if (hit.blocked && hit.entityIndex >= 0) {
          const t = Math.min(hit.distance / len, 1);
          const hitX = px + dx * t;
          const hitY = py + dy * t;

          if (impactHeader && impactWrite < impactCap) {
            const base = impactWrite * 6;
            impactData[base] = hit.entityIndex;
            impactData[base + 1] = damage[i];
            impactData[base + 2] = hitX;
            impactData[base + 3] = hitY;
            impactData[base + 4] = ownerId[i];
            impactData[base + 5] = shooterEntityType[i];
            impactWrite++;
          }
          active[i] = 0;
          this.returnToPool(i);
          continue;
        }
      }

      activeData[activeWrite++] = i;
    }

    activeData[0] = activeWrite - 1;
    if (impactHeader) {
      Atomics.store(impactHeader, 0, impactWrite);
      Atomics.add(impactHeader, 1, 1);
    }

    this._tickResult.activeCount = activeWrite - 1;
    this._tickResult.impactWrite = impactWrite;
    return this._tickResult;
  }

  /**
   * tick() through bulletTick.wasm. The kernel walks the pool and writes the active list and the impacts in its
   * own regions; the JS returns the slots that hit to the pool in the walk's order, ticks a bullet the kernel hands
   * back (a compound polygon or a chain on its way) with Ray, and copies the lists to the buffers other workers
   * read.
   */
  static _tickWasm(dtRatio, activeData, impactHeader, impactData, maxImpacts) {
    const k = this._wasm;
    const res = k.results;
    const count = this.maxCount;
    const dt = dtRatio * (1 / 60);
    res[0] = 1;
    res[1] = 0;
    res[2] = impactHeader ? maxImpacts | 0 : 0;
    res[3] = 0;
    readyBulletStamps(k, count);
    const returned = k.returned;
    let from = 0;
    for (;;) {
      const stop = k.tick(k.tableByte, from, count, dt, Grid.invCellSize, Grid.cellSize, Grid.gridWidth,
        Grid.gridHeight, Grid.cellByteSize, -1);
      const back = res[3];
      for (let n = 0; n < back; n++) this.returnToPool(returned[n]);
      res[3] = 0;
      if (stop >= count) break;
      this._tickOneJs(stop, dt, k.activeOut, k.impacts, res);
      from = stop + 1;
    }
    const activeWrite = res[0];
    const impactWrite = res[1];
    if (activeWrite > 1) activeData.set(k.activeOut.subarray(1, activeWrite), 1);
    activeData[0] = activeWrite - 1;
    if (impactHeader) {
      if (impactWrite > 0) impactData.set(k.impacts.subarray(0, impactWrite * 6));
      Atomics.store(impactHeader, 0, impactWrite);
      Atomics.add(impactHeader, 1, 1);
    }
    this._tickResult.activeCount = activeWrite - 1;
    this._tickResult.impactWrite = impactWrite;
    return this._tickResult;
  }

  /**
   * One bullet of tick()'s loop in JS, for a bullet the kernel handed back: the loop body, copied (the loop is hot),
   * writing the kernel's lists through its results ([0] the next active slot, [1] impacts, [2] their cap).
   */
  static _tickOneJs(i, dt, activeOut, impacts, res) {
    const bc = BulletComponent;
    const x = bc.x;
    const y = bc.y;
    const px = x[i];
    const py = y[i];
    bc.prevX[i] = px;
    bc.prevY[i] = py;
    const dx = bc.vx[i] * dt;
    const dy = bc.vy[i] * dt;
    x[i] = px + dx;
    y[i] = py + dy;
    const len = bc.speed[i] * dt;
    if (len > 1e-6) {
      const hit = Ray.linecastDir(px, py, bc.bulletRotC[i], bc.bulletRotS[i], len, bc.ownerId[i]);
      if (hit.blocked && hit.entityIndex >= 0) {
        const t = Math.min(hit.distance / len, 1);
        const n = res[1];
        if (n < res[2]) {
          const base = n * 6;
          impacts[base] = hit.entityIndex;
          impacts[base + 1] = bc.damage[i];
          impacts[base + 2] = px + dx * t;
          impacts[base + 3] = py + dy * t;
          impacts[base + 4] = bc.ownerId[i];
          impacts[base + 5] = bc.shooterEntityType[i];
          res[1] = n + 1;
        }
        bc.active[i] = 0;
        this.returnToPool(i);
        return;
      }
    }
    activeOut[res[0]] = i;
    res[0] = res[0] + 1;
  }

  static reset() {
    super.reset();
    this._wasm = null;
    this._warnedPoolExhausted = false;
    this._warnedMissingTextures.clear();
  }
}
