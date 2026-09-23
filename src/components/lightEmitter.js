import { Component } from '../core/component.js';

/**
 * Point / glow light on an entity.
 * Shadow casters come from this entity's Collider.visualRange neighbors (not from lightIntensity).
 * Tune visualRange for shadow reach / cost; lightIntensity still drives lighting / cookie math.
 */
export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    lightColor: Uint32Array,
    lightIntensity: Float32Array,
    sqrtLightIntensity: Float32Array,
    height: Float32Array,
    glowHeightOffset: Float32Array,
    hasGlowSprite: Float32Array, // 0 = no glow; 0.5 = intensity/50000 (default); 1 = twice that alpha
    layerIdOfGlowSprite: Uint8Array, // 0 = inherit entity layerMask; non-zero = that layer id bit only
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
   * OPTIMIZED: Automatically updates sqrtLightIntensity to avoid repeated sqrt calculations.
   * Cull / cookie radius: lightInfluenceRadius(sqrtLightIntensity) in utils.js.
   */
  set lightIntensity(value) {
    LightEmitter.lightIntensity[this.index] = value;
    // Cache sqrt(intensity) to avoid recalculating it every frame in hot loops
    LightEmitter.sqrtLightIntensity[this.index] = Math.sqrt(value);
  }

  get lightColor() {
    return LightEmitter.lightColor[this.index];
  }

  set lightColor(value) {
    LightEmitter.lightColor[this.index] = value;
  }

  get hasGlowSprite() {
    return LightEmitter.hasGlowSprite[this.index];
  }

  /**
   * Glow-sprite strength in [0, 1].
   * 0 hides the sprite. 0.5 is intensity/50000. 1 is twice that alpha.
   */
  set hasGlowSprite(value) {
    let v = +value;
    if (!(v >= 0)) v = 0;
    else if (v > 1) v = 1;
    LightEmitter.hasGlowSprite[this.index] = v;
  }

}
