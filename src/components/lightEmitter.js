import { Component } from '../core/component.js';
import { lightInfluenceRadius } from '../util/lightRadius.js';

/**
 * Point / glow light on an entity.
 *
 * Three heights, three jobs:
 * - `height` moves the whole light up the screen (pool centre included).
 * - `glowHeightOffset` moves only the glow sprite (put it on the bulb).
 * - `sourceHeight` lifts the source off the floor without moving its pool: the falloff uses
 *   I / (I + h² + d²), so a lamp post lights a wider, flatter pool than a torch on the ground,
 *   with the same reach. 0 (the default) is the old I / (I + d²).
 * Shadow casters and raycasted occluders come from this entity's Collider.visualRange
 * neighbors (not from lightIntensity): an occluder past visualRange does not block
 * the light. Tune visualRange for that reach / cost (`influenceRadius` is the light's
 * full reach); lightIntensity still drives lighting / cookie math.
 */
export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    lightColor: Uint32Array,
    lightIntensity: Float32Array,
    sqrtLightIntensity: Float32Array,
    height: Float32Array, // moves the light (and its pool) up the screen by this many px
    glowHeightOffset: Float32Array,
    sourceHeight: Float32Array, // the source's height above the floor: widens and softens the pool, does not move it
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

  /** World radius this light reaches. Collider.visualRange at least this occludes all of it. */
  get influenceRadius() {
    return lightInfluenceRadius(LightEmitter.sqrtLightIntensity[this.index]);
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
