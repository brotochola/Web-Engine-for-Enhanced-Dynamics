// Per-person multipliers for sidewalk follow, separation, and speed cap.

import { Component } from '/src/core/component.js';

export class CityPersonComponent extends Component {
  static ARRAY_SCHEMA = {
    flowFollow: Float32Array,
    separation: Float32Array,
    maxSpeed: Float32Array,
  };
}
