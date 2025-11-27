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
   */
  constructor(index) {
    super();
    this.index = index;
  }

  // Instance getters/setters that forward to static arrays
  get active() {
    return Transform.active[this.index];
  }
  set active(v) {
    Transform.active[this.index] = v ? 1 : 0;
  }

  get x() {
    return Transform.x[this.index];
  }
  set x(v) {
    Transform.x[this.index] = v;
  }

  get y() {
    return Transform.y[this.index];
  }
  set y(v) {
    Transform.y[this.index] = v;
  }

  get rotation() {
    return Transform.rotation[this.index];
  }
  set rotation(v) {
    Transform.rotation[this.index] = v;
  }
}

// ES6 module export
export { Transform };
