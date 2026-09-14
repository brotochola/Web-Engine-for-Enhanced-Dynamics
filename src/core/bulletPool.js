// BulletPool.js - Static API for spawning bullets
// Bullets are NOT GameObjects - they use BulletComponent directly
// Straight-line movement, raycast collision (prev→next), no physics
//
// EXTENDS SharedAtomicPool for thread-safe free list management

import { BulletComponent } from '../components/bulletComponent.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { SharedAtomicPool } from './sharedAtomicPool.js';
import { Layer } from './layer.js';

export class BulletPool extends SharedAtomicPool {
  static poolName = 'BulletPool';
  static _warnedPoolExhausted = false;
  static _warnedMissingTextures = new Set();

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
    const px = config.x;
    const py = config.y;
    x[i] = px;
    y[i] = py;

    startX[i] = px;
    startY[i] = py;

    trailWidth[i] = config.trailWidth ?? 0;

    prevX[i] = px;
    prevY[i] = py;
    vx[i] = config.vx;
    vy[i] = config.vy;
    damage[i] = config.damage;
    ownerId[i] = config.ownerId;
    shooterEntityType[i] = config.shooterEntityType ?? 0;

    let texId = 0;
    if (config.texture) {
      const resolvedTextureId = SpriteSheetRegistry.getAnimationIndex('bigAtlas', config.texture);
      if (resolvedTextureId === undefined) {
        if (!this._warnedMissingTextures.has(config.texture)) {
          this._warnedMissingTextures.add(config.texture);
          console.warn(
            `BulletPool.spawn: texture "${config.texture}" not found in bigAtlas; using textureId 0.`
          );
        }
      } else {
        texId = resolvedTextureId;
      }
    }
    textureId[i] = texId;
    scale[i] = config.scale ?? 1;
    alpha[i] = config.alpha ?? 1;
    tint[i] = config.tint ?? 0xffffff;
    {
      const speedSq = config.vx * config.vx + config.vy * config.vy;
      if (speedSq > 1e-12) {
        const inv = 1 / Math.sqrt(speedSq);
        bulletRotC[i] = config.vx * inv;
        bulletRotS[i] = config.vy * inv;
      } else {
        bulletRotC[i] = 1;
        bulletRotS[i] = 0;
      }
    }
    if (config.spriteRotC != null && config.spriteRotS != null) {
      spriteRotC[i] = config.spriteRotC;
      spriteRotS[i] = config.spriteRotS;
    } else if (config.spriteRotation == null && config.rotation == null) {
      spriteRotC[i] = bulletRotC[i];
      spriteRotS[i] = bulletRotS[i];
    } else {
      const a = config.spriteRotation ?? config.rotation ?? 0;
      spriteRotC[i] = Math.cos(a);
      spriteRotS[i] = Math.sin(a);
    }
    anchorX[i] = config.anchorX ?? 0;
    anchorY[i] = config.anchorY ?? 0.5;
    offsetY[i] = config.offsetY ?? 0;
    BulletComponent.layerMask[i] = Layer.resolveSubscriptions(config);
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

  static reset() {
    super.reset();
    this._warnedPoolExhausted = false;
    this._warnedMissingTextures.clear();
  }
}
