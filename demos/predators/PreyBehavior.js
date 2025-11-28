// PreyBehavior.js - Prey-specific behavior component
// Handles predator avoidance and health/life tracking

import { Component } from "../../src/core/Component.js";

class PreyBehavior extends Component {
  // Array schema - defines all prey behavior properties
  static ARRAY_SCHEMA = {
    predatorAvoidFactor: Float32Array, // How strongly to flee from predators
    life: Float32Array, // Health/life points
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   *
   * Note: Getters/setters for properties (predatorAvoidFactor, life) are auto-generated
   * from ARRAY_SCHEMA by Component._createInstanceProperties()
   */
  constructor(index) {
    super();
    this.index = index;
  }
}

// ES6 module export
export { PreyBehavior };
