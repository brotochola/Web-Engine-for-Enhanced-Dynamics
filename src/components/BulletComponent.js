// BulletComponent.js - Self-contained bullet data
// Bullets are NOT GameObjects - they have their own separate pool
// Straight-line movement, raycast collision (prev→next), no physics

import { Component } from '../core/Component.js';

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
    bulletAngle: Float32Array,

    damage: Float32Array,
    ownerId: Uint16Array,
    shooterEntityType: Uint8Array,

    textureId: Uint16Array,
    scale: Float32Array,
    alpha: Float32Array,
    tint: Uint32Array,
    spriteRotation: Float32Array,
    anchorX: Float32Array,
    anchorY: Float32Array,

    offsetY: Float32Array, // Visual offset (e.g., muzzle height); sort at y, render at y + offsetY

    isItOnScreen: Uint8Array,

    // === Layer Routing ===
    layerId: Uint8Array, // 0 = default ENTITIES layer, non-zero = custom layer id
  };

  static bulletCount = 0;
}
