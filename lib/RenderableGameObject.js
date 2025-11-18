// RenderableGameObject.js - Game object with rendering properties
// Extends GameObject to add visual/animation state for rendering

class RenderableGameObject extends GameObject {
  // Define rendering-specific properties schema
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
  };

  /**
   * Sprite configuration - override in subclasses
   * Defines what spritesheet and animations this entity uses
   */
  static spriteConfig = {
    spritesheet: null, // Name of spritesheet (e.g., "person", "perro")
    animations: {}, // Map of animationState -> animation name
    defaultAnimation: null, // Default animation name
    animationSpeed: 0.2, // Default animation speed
  };

  /**
   * Constructor - initializes rendering properties
   */
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    // Initialize rendering properties with defaults
    RenderableGameObject.animationState[i] = 0;
    RenderableGameObject.animationFrame[i] = 0;
    RenderableGameObject.animationSpeed[i] =
      this.constructor.spriteConfig.animationSpeed || 0.2;

    RenderableGameObject.tint[i] = 0xffffff; // White (no tint)
    RenderableGameObject.alpha[i] = 1.0; // Fully opaque

    RenderableGameObject.flipX[i] = 0;
    RenderableGameObject.flipY[i] = 0;
    RenderableGameObject.scaleX[i] = 1.0;
    RenderableGameObject.scaleY[i] = 1.0;

    RenderableGameObject.spriteVariant[i] = 0;
    RenderableGameObject.zOffset[i] = 0;
    RenderableGameObject.blendMode[i] = 0; // Normal blend mode

    RenderableGameObject.renderVisible[i] = 1; // Visible by default
  }

  /**
   * Helper method to send sprite property changes to renderer
   * For rare/complex changes that can't be done via SharedArrayBuffer
   * @param {string} prop - Property path (e.g., "tint", "scale.x")
   * @param {*} value - Value to set
   */
  setSpriteProp(prop, value) {
    if (this.logicWorker) {
      this.logicWorker.self.postMessage({
        msg: "toRenderer",
        cmd: "setProp",
        entityId: this.index,
        prop: prop,
        value: value,
      });
    }
  }

  /**
   * Helper method to call sprite methods
   * @param {string} method - Method name
   * @param {Array} args - Method arguments
   */
  callSpriteMethod(method, args = []) {
    if (this.logicWorker) {
      this.logicWorker.self.postMessage({
        msg: "toRenderer",
        cmd: "callMethod",
        entityId: this.index,
        method: method,
        args: args,
      });
    }
  }

  /**
   * Helper method to batch multiple sprite updates
   * @param {Object} updates - Object with 'set' and/or 'call' properties
   */
  updateSprite(updates) {
    if (this.logicWorker) {
      this.logicWorker.self.postMessage({
        msg: "toRenderer",
        cmd: "batchUpdate",
        entityId: this.index,
        ...updates,
      });
    }
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = RenderableGameObject;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.RenderableGameObject = RenderableGameObject;
}
