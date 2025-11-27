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

    // Sprite modifications
    flipX: Uint8Array, // Flip horizontally
    flipY: Uint8Array, // Flip vertically
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
  };
}

// ES6 module export
export { SpriteRenderer };
