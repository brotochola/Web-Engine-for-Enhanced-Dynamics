// PredatorBehavior.js - Predator-specific behavior component
// Handles prey hunting behavior

import { Component } from "../../src/core/Component.js";

class PredatorBehavior extends Component {
  // Array schema - defines all predator behavior properties
  static ARRAY_SCHEMA = {
    huntFactor: Float32Array, // How strongly to chase prey
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   *
   * Note: Getters/setters for properties (huntFactor) are auto-generated
   * from ARRAY_SCHEMA by Component._createInstanceProperties()
   */
  constructor(index) {
    super();
    this.index = index;
  }
}

// ES6 module export
export { PredatorBehavior };
