// MouseComponent.js - Mouse input state component
// Stores button states and presence flag for the Mouse entity
// This allows mouse state to be shared across all workers via SharedArrayBuffer

import { Component } from "../core/Component.js";

class MouseComponent extends Component {
  // Array schema - defines all mouse input properties
  static ARRAY_SCHEMA = {
    // Button states (0 = up, 1 = down)
    button0Down: Uint8Array, // Left mouse button
    button1Down: Uint8Array, // Middle mouse button
    button2Down: Uint8Array, // Right mouse button

    // Presence flag (1 = mouse is over canvas, 0 = mouse left canvas)
    isPresent: Uint8Array,
  };
}

// ES6 module export
export { MouseComponent };
