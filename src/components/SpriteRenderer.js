// SpriteRenderer.js - Rendering component for visual appearance
// Handles animation, tinting, transparency, and sprite effects

import { Component } from '../core/Component.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';

export class SpriteRenderer extends Component {
  // Array schema - defines all rendering properties
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active

    // Animation control
    isAnimated: Uint8Array, // 0 = static sprite (single frame), 1 = animated sprite (multi-frame)
    spritesheetId: Uint8Array, // Which spritesheet to use (civil1, civil2, bunny, etc.) - proxies to bigAtlas
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Current frame within the animation
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)
    loop: Uint8Array, // 0 = no loop, 1 = loop

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

    // Stable sprite binding (pixi_worker): pool index of assigned PIXI.Particle (-1 = none)
    pixiParticleId: Int32Array,
  };

  /**
   * Get the original (unscaled) width of the current sprite/animation frame
   * Looks up dimensions from SpriteSheetRegistry (single source of truth)
   * @returns {number} Original width in pixels, or 0 if not found
   */
  get originalWidth() {
    return SpriteRenderer.getOriginalWidth(this.index);
  }

  /**
   * Get the original (unscaled) height of the current sprite/animation frame
   * Looks up dimensions from SpriteSheetRegistry (single source of truth)
   * @returns {number} Original height in pixels, or 0 if not found
   */
  get originalHeight() {
    return SpriteRenderer.getOriginalHeight(this.index);
  }

  /**
   * Static method to get original (unscaled) width by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original width in pixels, or 0 if not found
   */
  static getOriginalWidth(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animIndex = SpriteRenderer.animationState[entityIndex];
    const dims = SpriteSheetRegistry.getFrameDimensionsById(spritesheetId, animIndex);
    return dims ? dims.w : 0;
  }

  /**
   * Static method to get original (unscaled) height by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original height in pixels, or 0 if not found
   */
  static getOriginalHeight(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animIndex = SpriteRenderer.animationState[entityIndex];
    const dims = SpriteSheetRegistry.getFrameDimensionsById(spritesheetId, animIndex);
    return dims ? dims.h : 0;
  }
}
