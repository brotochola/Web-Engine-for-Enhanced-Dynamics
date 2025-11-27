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
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   */
  constructor(index) {
    super();
    this.index = index;
  }

  // Instance getters/setters that forward to static arrays
  get animationState() {
    return SpriteRenderer.animationState[this.index];
  }
  set animationState(v) {
    SpriteRenderer.animationState[this.index] = v;
  }

  get animationFrame() {
    return SpriteRenderer.animationFrame[this.index];
  }
  set animationFrame(v) {
    SpriteRenderer.animationFrame[this.index] = v;
  }

  get animationSpeed() {
    return SpriteRenderer.animationSpeed[this.index];
  }
  set animationSpeed(v) {
    SpriteRenderer.animationSpeed[this.index] = v;
  }

  get tint() {
    return SpriteRenderer.tint[this.index];
  }
  set tint(v) {
    SpriteRenderer.tint[this.index] = v;
  }

  get alpha() {
    return SpriteRenderer.alpha[this.index];
  }
  set alpha(v) {
    SpriteRenderer.alpha[this.index] = v;
  }

  get scaleX() {
    return SpriteRenderer.scaleX[this.index];
  }
  set scaleX(v) {
    SpriteRenderer.scaleX[this.index] = v;
  }

  get scaleY() {
    return SpriteRenderer.scaleY[this.index];
  }
  set scaleY(v) {
    SpriteRenderer.scaleY[this.index] = v;
  }

  get spriteVariant() {
    return SpriteRenderer.spriteVariant[this.index];
  }
  set spriteVariant(v) {
    SpriteRenderer.spriteVariant[this.index] = v;
  }

  get zOffset() {
    return SpriteRenderer.zOffset[this.index];
  }
  set zOffset(v) {
    SpriteRenderer.zOffset[this.index] = v;
  }

  get blendMode() {
    return SpriteRenderer.blendMode[this.index];
  }
  set blendMode(v) {
    SpriteRenderer.blendMode[this.index] = v;
  }

  get renderVisible() {
    return SpriteRenderer.renderVisible[this.index];
  }
  set renderVisible(v) {
    SpriteRenderer.renderVisible[this.index] = v ? 1 : 0;
  }

  get isItOnScreen() {
    return SpriteRenderer.isItOnScreen[this.index];
  }
  set isItOnScreen(v) {
    SpriteRenderer.isItOnScreen[this.index] = v ? 1 : 0;
  }

  get renderDirty() {
    return SpriteRenderer.renderDirty[this.index];
  }
  set renderDirty(v) {
    SpriteRenderer.renderDirty[this.index] = v ? 1 : 0;
  }
}

// ES6 module export
export { SpriteRenderer };
