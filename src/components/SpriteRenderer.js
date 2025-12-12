// SpriteRenderer.js - Rendering component for visual appearance
// Handles animation, tinting, transparency, and sprite effects

import { Component } from "../core/Component.js";

export class SpriteRenderer extends Component {
  // Array schema - defines all rendering properties
  static ARRAY_SCHEMA = {
    // Animation control
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Current frame within the animation
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)
    isAnimated: Uint8Array, // 0 = static sprite (single frame), 1 = animated sprite (multi-frame)
    spritesheetId: Uint8Array, // Which spritesheet to use (civil1, civil2, bunny, etc.) - proxies to bigAtlas

    // Visual effects
    tint: Uint32Array, // Color tint (0xFFFFFF = white/normal) - modified by lighting
    baseTint: Uint32Array, // Original color set by game logic (preserved for lighting calculation)
    alpha: Float32Array, // Transparency (0-1)

    scaleX: Float32Array, // Separate X scale
    scaleY: Float32Array, // Separate Y scale
    anchorX: Float32Array, // Separate X anchor
    anchorY: Float32Array, // Separate Y anchor

    // Rendering options

    zOffset: Float32Array,
    blendMode: Uint8Array, // Blend mode (0=normal, 1=add, 2=multiply, etc.)

    // Visibility
    renderVisible: Uint8Array, // Override visibility (separate from culling)
    isItOnScreen: Uint8Array, // Screen culling - updated by spatial worker

    // Performance optimization - dirty flag
    renderDirty: Uint8Array, // 1 = visual properties changed, needs update this frame
    screenX: Float32Array,
    screenY: Float32Array,
  };
}
