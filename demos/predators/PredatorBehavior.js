// PredatorBehavior.js - Predator-specific behavior component
// Handles prey hunting behavior

import { Component } from "../../src/core/Component.js";

export class PredatorBehavior extends Component {
  // Array schema - defines all predator behavior properties
  static ARRAY_SCHEMA = {
    huntFactor: Float32Array, // How strongly to chase prey
  };
}
