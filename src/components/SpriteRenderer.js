// SpriteRenderer.js - Rendering component for visual appearance
// Handles animation, tinting, transparency, and sprite effects

import { Component } from "../core/Component.js";

class SpriteRenderer extends Component {
  // Array schema - defines all rendering properties
  static ARRAY_SCHEMA = {
    // Animation control
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Manual frame control if needed
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)

    // Visual effects
    tint: Uint32Array, // Color tint (0xFFFFFF = white/normal)
    alpha: Float32Array, // Transparency (0-1)

    scaleX: Float32Array, // Separate X scale
    scaleY: Float32Array, // Separate Y scale

    // Rendering options
    spriteVariant: Uint8Array, // Texture/sprite variant (for different skins)
    zOffset: Float32Array, // Z-index offset (for layering)
    blendMode: Uint8Array, // Blend mode (0=normal, 1=add, 2=multiply, etc.)

    // Visibility
    renderVisible: Uint8Array, // Override visibility (separate from culling)
    isItOnScreen: Uint8Array, // Screen culling - updated by spatial worker

    // Performance optimization - dirty flag
    renderDirty: Uint8Array, // 1 = visual properties changed, needs update this frame
    screenX: Float32Array,
    screenY: Float32Array,
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   *
   * Note: Getters/setters for all properties (animationState, tint, alpha, scaleX, etc.)
   * are auto-generated from ARRAY_SCHEMA by Component._createInstanceProperties()
   */
  constructor(index) {
    super();
    this.index = index;
  }
}

// ES6 module export
export { SpriteRenderer };
