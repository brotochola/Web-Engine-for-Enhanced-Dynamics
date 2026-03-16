import { Component } from '../core/Component.js';

export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    lightColor: Uint32Array,
    lightIntensity: Float32Array,
    sqrtLightIntensity: Float32Array,
    height: Float32Array,
    glowHeightOffset: Float32Array,
    hasGlowSprite: Uint8Array, // 0 = no glow sprite, 1 = render glow sprite (default for static lights)
    layerIdOfGlowSprite: Uint8Array, // 0 = inherit from SpriteRenderer.layerId, non-zero = explicit custom layer id
  };

  /**
   * Custom getter for lightIntensity
   * Returns the light intensity value
   */
  get lightIntensity() {
    return LightEmitter.lightIntensity[this.index];
  }

  /**
   * Custom setter for lightIntensity
   * OPTIMIZED: Automatically updates sqrtLightIntensity to avoid repeated sqrt calculations
   * This is used in pixi_worker for light culling: influenceRadius = 10 * sqrt(intensity)
   */
  set lightIntensity(value) {
    LightEmitter.lightIntensity[this.index] = value;
    // Cache sqrt(intensity) to avoid recalculating it every frame in hot loops
    LightEmitter.sqrtLightIntensity[this.index] = Math.sqrt(value);
  }

  set lightColor(value) {
    LightEmitter.lightColor[this.index] = value;
  }

}
