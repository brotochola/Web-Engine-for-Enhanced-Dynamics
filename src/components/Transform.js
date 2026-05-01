// Transform.js - Transform component for entity-wide state and positioning
// Handles active state, render visibility, position, and rotation (every entity has this)

import { Component } from '../core/Component.js';

export class Transform extends Component {
  // Array schema - defines all transform properties
  static ARRAY_SCHEMA = {
    // Entity state
    active: Uint8Array, // 0 = inactive, 1 = active
    entityType: Uint8Array, // Entity type ID (auto-assigned during registration)
    isItOnScreen: Uint8Array, // Canonical entity screen visibility, published by pre_render_worker

    // Position and rotation (world space)
    x: Float32Array,
    y: Float32Array,
    rotation: Float32Array,
  };
}
