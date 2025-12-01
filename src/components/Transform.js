// Transform.js - Transform component for entity positioning
// Handles position, rotation, and active state (every entity has this)

import { Component } from "../core/Component.js";

export class Transform extends Component {
  // Array schema - defines all transform properties
  static ARRAY_SCHEMA = {
    // Entity state
    active: Uint8Array, // 0 = inactive, 1 = active

    // Position and rotation (world space)
    x: Float32Array,
    y: Float32Array,
    rotation: Float32Array,
  };
}
