// PreyBehavior.js - Prey-specific behavior component
// Handles predator avoidance and health/life tracking

import WEED from "../../src/index.js";
const { Component } = WEED;

export class PreyBehavior extends Component {
  // Array schema - defines all prey behavior properties
  static ARRAY_SCHEMA = {
    predatorAvoidFactor: Float32Array, // How strongly to flee from predators
    life: Float32Array, // Health/life points
  };
}
