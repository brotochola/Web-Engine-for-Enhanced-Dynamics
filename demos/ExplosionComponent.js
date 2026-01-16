// ExplosionComponent.js - Data for explosion entities
// Tracks lifecycle, intensity, radius growth/shrink, and visual state

import { Component } from "/src/core/Component.js";

export class ExplosionComponent extends Component {
  static ARRAY_SCHEMA = {
    // === Lifecycle ===
    lifespan: Float32Array,      // Total lifetime in ms
    elapsedTime: Float32Array,   // Time alive so far in ms
    justSpawned: Uint8Array,     // Flag to ensure clean state on first tick (1 = just spawned)
    
    // === Intensity & Radius ===
    wantedIntensity: Float32Array,  // Target max light intensity
    maxRadius: Float32Array,        // Maximum collider radius at 50% progress
    
    // === Animation ===
    frameCount: Uint8Array,      // Number of frames in current animation (10 or 12)
    baseScale: Float32Array,     // Base scale value for the explosion
    flipped: Uint8Array,         // Whether sprite is horizontally flipped (1 = flipped)
    
    // === Cached values ===
    originalWidth: Float32Array, // Cached original sprite width
  };
}
