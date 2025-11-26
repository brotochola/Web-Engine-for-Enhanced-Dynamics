// Transform.js - Transform component for entity positioning and hierarchy
// Handles local and world space transforms with parent-child relationships

import { Component } from '../core/Component.js';

class Transform extends Component {
  // Array schema - defines all transform properties
  static ARRAY_SCHEMA = {
    // Hierarchy
    parentId: Int32Array, // -1 if no parent

    // Local transform (relative to parent)
    localX: Float32Array,
    localY: Float32Array,
    localRotation: Float32Array,
    localScaleX: Float32Array,
    localScaleY: Float32Array,

    // World transform (computed by TransformSystem)
    worldX: Float32Array,
    worldY: Float32Array,
    worldRotation: Float32Array,
    worldScaleX: Float32Array,
    worldScaleY: Float32Array,
  };
}

// ES6 module export
export { Transform };
