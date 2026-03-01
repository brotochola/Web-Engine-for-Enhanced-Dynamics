// CivilianComponent.js - Data for civilian entities
// Tracks panic state: where to flee from when damaged

import { Component } from '/src/core/Component.js';

export class CivilianComponent extends Component {
  static ARRAY_SCHEMA = {
    panicOriginX: Float32Array,
    panicOriginY: Float32Array,
  };
}
