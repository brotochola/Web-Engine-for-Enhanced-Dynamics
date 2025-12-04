// Flocking.js - Flocking behavior component for boid-like entities
// Handles cohesion, separation, alignment, and boundary avoidance parameters
// This is a CUSTOM COMPONENT created for the predators demo, not part of the engine core

import { Component } from "../../src/core/Component.js";

export class Flocking extends Component {
  // Array schema - defines all flocking behavior properties
  static ARRAY_SCHEMA = {
    protectedRange: Float32Array, // Minimum distance from other boids
    centeringFactor: Float32Array, // Cohesion strength (pull to center of flock)
    avoidFactor: Float32Array, // Separation strength (push away when too close)
    matchingFactor: Float32Array, // Alignment strength (match velocity of neighbors)
    turnFactor: Float32Array, // Boundary avoidance strength
    margin: Float32Array, // Distance from world edge to start turning
  };
}
