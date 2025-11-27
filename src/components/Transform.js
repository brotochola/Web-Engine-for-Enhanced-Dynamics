// Transform.js - Transform component for entity positioning
// Handles position, rotation, and active state (every entity has this)

import { Component } from "../core/Component.js";

class Transform extends Component {
  // Array schema - defines all transform properties
  static ARRAY_SCHEMA = {
    // Entity state
    active: Uint8Array, // 0 = inactive, 1 = active

    // Position and rotation (world space)
    x: Float32Array,
    y: Float32Array,
    rotation: Float32Array,
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   *
   * Note: Getters/setters for properties (active, x, y, rotation) are auto-generated
   * from ARRAY_SCHEMA by Component._createInstanceProperties() when arrays are initialized
   */
  constructor(index) {
    super();
    this.index = index;
  }
}

// ES6 module export
export { Transform };
