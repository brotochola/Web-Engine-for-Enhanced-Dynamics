// ShadowCaster.js - Entity marker for shadow casting
// Shadow pixels are written to the double-buffered shadow render queue (not this SoA).
// Entity SoA only stores which entities cast shadows and how tall/anchored they are.

import { Component } from '../core/Component.js';

export class ShadowCaster extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = inactive, 1 = entity casts shadow
    heightMultiplier: Float32Array, // Shadow length multiplier (0=no shadow, 1=normal)
    anchorOffsetX: Float32Array, // Shadow anchor offset X (0-1, relative to sprite size)
    anchorOffsetY: Float32Array, // Shadow anchor offset Y (0-1, relative to sprite size)
  };

  // Static pool tracking (set during initialization)
  static shadowCount = 0;
}
