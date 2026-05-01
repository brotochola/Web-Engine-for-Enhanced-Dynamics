import { Component } from '../core/Component.js';

/**
 * Binary circular light blocker for raycasted lighting.
 * Partial opacity is intentionally not modeled here: an active occluder blocks
 * visibility inside its radius, and an inactive occluder does not.
 */
export class LightOccluder extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,        // 0 = inactive, 1 = blocks light
    radius: Float32Array,      // binary occlusion circle radius (world units)
  };
}
