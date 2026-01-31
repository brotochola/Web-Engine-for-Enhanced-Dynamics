// Flocking.js - Flocking behavior component for boid-like entities
// Handles cohesion, separation, alignment, and boundary avoidance parameters
// This is a CUSTOM COMPONENT created for the predators demo, not part of the engine core

import WEED from '../../src/index.js';
const { Component } = WEED;

export class FireComponent extends Component {
  static ARRAY_SCHEMA = {
    lifespan: Uint16Array, // Total lifetime in ms
    elapsedTime: Uint16Array, // Time alive so far in ms
    baseAnimationSpeed: Float32Array, // Base animation speed
    baseIntensity: Float32Array, // Base intensity
    baseRadius: Float32Array, // Base radius
    baseScale: Float32Array, // Base scale
    intensityVariation: Float32Array, // Intensity variation
    flipped: Uint8Array, // Flipped
  };
}
