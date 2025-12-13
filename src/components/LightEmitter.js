import { Component } from "../core/Component.js";

export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    lightColor: Uint32Array,
    lightIntensity: Float32Array,
  };
}
