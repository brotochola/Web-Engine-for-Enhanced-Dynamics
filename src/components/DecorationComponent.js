// DecorationComponent.js - Self-contained decoration data
// Decorations are NOT GameObjects - they have their own separate pool
// This component contains ALL data needed for static decorations (position, visuals)
// Decorations are static sprites with configurable anchor - no animation, no physics, no lighting

import { Component } from '../core/Component.js';

export class DecorationComponent extends Component {
  static ARRAY_SCHEMA = {
    // === State ===
    active: Uint8Array, // 0 = inactive (in pool), 1 = active

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
    baseRotation: Float32Array, // Base rotation in radians (sway animation adds to this)
    rotation: Float32Array, // current rotation in radians (sway animation adds to this)
    alpha: Float32Array, // Opacity (0-1)
    tint: Uint32Array, // Color tint (0xRRGGBB)
    anchorX: Float32Array, // Anchor X (0-1, default 0.5)
    anchorY: Float32Array, // Anchor Y (0-1, default 0.5)

    // === Visibility ===
    isItOnScreen: Uint8Array, // 0 = not on screen, 1 = on screen (set by culling)

    // === Sway Animation ===
    sway: Uint8Array, // 0 = no sway, 1 = sway enabled
    swayAmplitude: Float32Array, // Rotation amplitude in radians (e.g., 0.025 ≈ 1.4°)
    swayFrequency: Float32Array, // Speed multiplier (1.0 = normal, 0.5 = slow, 2.0 = fast)

    // === Layer Routing ===
    layerId: Uint8Array, // 0 = default ENTITIES layer, non-zero = custom layer id

    // === Parent attachment (GameObject-owned decorations) ===
    parentEntityIndex: Uint16Array, // 0xffff = no parent; else parent entity index (0 is valid)
    localX: Float32Array,
    localY: Float32Array,
    inheritParentRotation: Uint8Array, // 1 = add parent Transform.rotation to baseRotation for display
    innerZ: Int8Array, // signed; clamp to DECORATION_INNER_Z_MIN..MAX; composite = worldY*SCALE + innerZ
  };

  // Static pool tracking (set during initialization)
  static decorationCount = 0;

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    // Fresh buffers default to 0; 0 is a valid entity index — use sentinel for "no parent"
    const SENT = 0xffff;
    if (this.parentEntityIndex) {
      this.parentEntityIndex.fill(SENT);
    }
  }
}
