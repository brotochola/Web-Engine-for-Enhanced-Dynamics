// DecorationComponent.js - Self-contained decoration data
// Decorations are NOT GameObjects - they have their own separate pool
// This component contains ALL data needed for static decorations (position, visuals)
// Decorations are static sprites with configurable anchor - no animation, no physics, no lighting

import { Component } from "../core/Component.js";

export class DecorationComponent extends Component {
  static ARRAY_SCHEMA = {
    // === State ===
    active: Uint8Array, // 0 = inactive (in pool), 1 = active

    // === Position ===
    x: Float32Array,
    y: Float32Array,

    // === Visuals ===
    textureId: Uint16Array, // Index into texture atlas (bigAtlas animation index)
    scale: Float32Array, // Uniform scale
    alpha: Float32Array, // Opacity (0-1)
    tint: Uint32Array, // Color tint (0xRRGGBB)
    anchorX: Float32Array, // Anchor X (0-1, default 0.5)
    anchorY: Float32Array, // Anchor Y (0-1, default 0.5)

    // === Visibility ===
    isItOnScreen: Uint8Array, // 0 = not on screen, 1 = on screen (set by culling)
  };

  // Static pool tracking (set during initialization)
  static decorationCount = 0;
}
