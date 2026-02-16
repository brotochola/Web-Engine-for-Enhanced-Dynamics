// ShadowCaster.js - Unified component for shadow casting
// Used for TWO purposes:
// 1. Entity marker buffer (entityCount slots) - marks which entities cast shadows
// 2. Shadow sprite buffer (maxShadowSprites slots) - holds rendered shadow data
//
// Both buffers use the same schema. Entity markers only use active/heightMultiplier.
// Shadow sprites use all fields (x, y, rotation, scales, alpha).

import { Component } from '../core/Component.js';

export class ShadowCaster extends Component {
  static ARRAY_SCHEMA = {
    // === Entity marker fields ===
    active: Uint8Array, // 0 = inactive, 1 = active (entity casts shadow / shadow sprite visible)
    heightMultiplier: Float32Array, // Shadow length multiplier (0=no shadow, 1=normal, 2=2x longer)

    // === Shadow sprite fields (only used in sprite buffer) ===
    x: Float32Array, // World X position
    y: Float32Array, // World Y position
    rotation: Float32Array, // Rotation in radians (pointing away from light)
    scaleX: Float32Array, // Width scale
    scaleY: Float32Array, // Length scale
    alpha: Float32Array, // Opacity (fades with distance from light)
    entityIdx: Int32Array, // Entity index that owns this shadow (for interpolation tracking)
    lightIdx: Int32Array, // Light entity index that casts this shadow (for interleaved rendering)
    anchorOffsetX: Float32Array, // Shadow anchor offset X (0-1, relative to sprite size, default 0)
    anchorOffsetY: Float32Array, // Shadow anchor offset Y (0-1, relative to sprite size, default 0)
  };

  // Static pool tracking (set during initialization)
  static shadowCount = 0;
}
