// CivilianComponent.js - Data for civilian entities
// Tracks panic state: where to flee from when damaged

import WEED from '/src/index.js';

const { Component } = WEED;

export class CivilianComponent extends Component {
  static ARRAY_SCHEMA = {
    panicOriginX: Float32Array,
    panicOriginY: Float32Array,
  };
}
