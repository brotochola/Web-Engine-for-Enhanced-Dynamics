import { Component } from '../core/Component.js';

export class LightOccluder extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,        // 0 = inactive, 1 = blocks light
    radius: Float32Array,      // occlusion circle radius (world units)
    opacity: Float32Array,     // 0..1, how much light is blocked (1 = fully opaque)
  };
}
