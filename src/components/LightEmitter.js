import { Component } from "../core/Component.js";

export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    enabled: Uint8Array,
    lightColor: Uint32Array,
    lightIntensity: Float32Array,
  };
}
