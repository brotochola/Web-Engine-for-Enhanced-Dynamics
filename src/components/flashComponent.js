// FlashComponent.js - Data for light flashes (muzzle flashes, sparks, etc.)
// Flashes are short-lived light sources that fade out over their lifespan
// Used with LightEmitter component for rendering

import { Component } from '../core/component.js';

export class FlashComponent extends Component {
  static ARRAY_SCHEMA = {
    // === State ===
    active: Uint8Array, // 0 = inactive (in pool), 1 = active

    // === Lifecycle (in milliseconds) ===
    lifespan: Float32Array, // Total lifetime in ms
    currentLife: Float32Array, // Time alive so far in ms

    // === Initial values (for calculating decay) ===
    initialRadius: Float32Array, // Starting reach (px)
    initialGlow: Float32Array, // Starting halo alpha
  };
}
