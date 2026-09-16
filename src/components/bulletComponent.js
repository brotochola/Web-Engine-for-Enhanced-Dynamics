// BulletComponent.js - Self-contained bullet data
// Bullets are NOT GameObjects - they have their own separate pool
// Straight-line movement, raycast collision (prev→next), no physics

import { Component } from '../core/component.js';

export class BulletComponent extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    startX: Float32Array,
    startY: Float32Array,
    trailWidth: Float32Array,

    x: Float32Array,
    y: Float32Array,
    prevX: Float32Array,
    prevY: Float32Array,

    vx: Float32Array,
    vy: Float32Array,
    /** |v| at spawn. Straight bullets never change it; tick uses speed * dt. */
    speed: Float32Array,
    /** Facing of velocity / trail (cos, sin of atan2(vy,vx)). */
    bulletRotC: Float32Array,
    bulletRotS: Float32Array,

    damage: Float32Array,
    ownerId: Uint16Array,
    shooterEntityType: Uint8Array,

    textureId: Uint16Array,
    scale: Float32Array,
    alpha: Float32Array,
    tint: Uint32Array,
    spriteRotC: Float32Array,
    spriteRotS: Float32Array,
    anchorX: Float32Array,
    anchorY: Float32Array,

    offsetY: Float32Array, // Visual offset (e.g., muzzle height); sort at y, render at y + offsetY

    isItOnScreen: Uint8Array,

    // === Layer Routing ===
    layerMask: Uint16Array,
  };

  static bulletCount = 0;

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.bulletRotC) this.bulletRotC.fill(1);
    if (this.spriteRotC) this.spriteRotC.fill(1);
  }
}
