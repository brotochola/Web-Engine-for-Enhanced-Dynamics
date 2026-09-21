// DecorationComponent.js - Self-contained decoration data
// Decorations are NOT GameObjects - they have their own separate pool
// This component contains ALL data needed for static decorations (position, visuals)
// Decorations are static sprites with optional sway - no physics, no lighting

import { Component } from '../core/component.js';
import { EntityIdArray, entityIdNone } from '../util/entityIdWidth.js';

export class DecorationComponent extends Component {
  static ARRAY_SCHEMA = {
    // === State ===
    active: Uint8Array, // 0 = inactive (in pool), 1 = active
    generation: Uint32Array, // increments on spawn; prevents stale facades mutating recycled slots

    // === Position ===
    x: Float32Array,
    y: Float32Array,
    // Offset from position for depth sorting (e.g., sort at ground level while sprite is at gun height)
    offsetX: Float32Array,
    offsetY: Float32Array,

    // === Visuals ===
    textureId: Uint16Array, // Index into texture atlas (bigAtlas animation index)
    scaleX: Float32Array, // Scale X
    scaleY: Float32Array, // Scale Y
    baseRotC: Float32Array, // Base facing cos (sway composes onto this)
    baseRotS: Float32Array, // Base facing sin
    rotC: Float32Array, // Current world facing cos (after parent compose + sway)
    rotS: Float32Array, // Current world facing sin
    alpha: Float32Array, // Opacity (0-1)
    tint: Uint32Array, // Color tint (0xRRGGBB)
    anchorX: Float32Array, // Anchor X (0-1, default 0.5)
    anchorY: Float32Array, // Anchor Y (0-1, default 0.5)

    // === Visibility ===
    isItOnScreen: Uint8Array, // 0 = not on screen, 1 = on screen (set by culling)

    // === Sway Animation ===
    // sway: 0 = off, 1 = continuous loop, 2 = one-shot impulse (0→π then clears)
    sway: Uint8Array,
    swayAmplitude: Float32Array, // Rotation amplitude in radians (e.g., 0.025 ≈ 1.4°)
    swayFrequency: Float32Array, // Speed multiplier (1.0 = normal, 0.5 = slow, 2.0 = fast)
    swayPhase: Float32Array, // Impulse progress in radians [0, π); unused for loop

    // === Layer Routing ===
    layerMask: Uint16Array,

    // === Parent attachment (GameObject-owned decorations) ===
    parentEntityIndex: Uint16Array, // rebound to EntityIdArray when entityIdWidth is 32
    localX: Float32Array,
    localY: Float32Array,
    inheritParentRotation: Uint8Array, // 1 = add parent Transform.rotation to baseRotation for display
    innerZ: Int8Array, // signed; clamp to DECORATION_INNER_Z_MIN..MAX; composite = worldY*SCALE + innerZ
  };

  // Static pool tracking (set during initialization)
  static decorationCount = 0;

  static getBufferSize(count) {
    this.ARRAY_SCHEMA.parentEntityIndex = EntityIdArray();
    return super.getBufferSize(count);
  }

  static initializeArrays(buffer, count) {
    this.ARRAY_SCHEMA.parentEntityIndex = EntityIdArray();
    super.initializeArrays(buffer, count);
    // Fresh buffers default to 0; 0 is a valid entity index — use sentinel for "no parent"
    if (this.parentEntityIndex) {
      this.parentEntityIndex.fill(entityIdNone);
    }
    if (this.baseRotC) this.baseRotC.fill(1);
    if (this.rotC) this.rotC.fill(1);
    // baseRotS / rotS default 0
  }
}
