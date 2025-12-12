// ParticleComponent.js - Self-contained particle data
// Particles are NOT GameObjects - they have their own separate pool
// This component contains ALL data needed for particles (position, velocity, visuals)
// Particles are static sprites with fixed anchor (0.5, 0.5) - no animation support

import { Component } from "../core/Component.js";

export class ParticleComponent extends Component {
  static ARRAY_SCHEMA = {
    // === State ===
    active: Uint8Array, // 0 = inactive (in pool), 1 = active

    // === Position (particles have their own position, separate from Transform) ===
    x: Float32Array,
    y: Float32Array,
    z: Float32Array, // Height for 3D effect (z < 0 = above ground)

    // === Velocity ===
    vx: Float32Array,
    vy: Float32Array,
    vz: Float32Array, // Positive = falling down

    // === Lifecycle (in milliseconds) ===
    lifespan: Uint16Array, // Total lifetime (max ~65 seconds)
    currentLife: Uint16Array, // Time alive so far

    // === Physics ===
    gravity: Float32Array, // Per-particle gravity strength

    // === Visuals (simplified - static sprites only) ===
    scale: Float32Array, // Uniform scale (particles don't need scaleX/Y)
    alpha: Float32Array, // Opacity (0-1)
    tint: Uint32Array, // Color tint (0xRRGGBB) - modified by lighting
    baseTint: Uint32Array, // Original color set by emitter (preserved for lighting calculation)
    textureId: Uint16Array, // Index into texture atlas (NOT spritesheetId)

    // === Floor behavior ===
    fadeOnTheFloor: Uint16Array, // Time in ms to fade out when on floor (0 = no fade)
    timeOnFloor: Uint16Array, // Tracks how long particle has been on floor
    initialAlpha: Float32Array, // Alpha when particle hit the floor (for fade calculation)

    // === Blood Decals System ===
    // When stayOnTheFloor=1, particle will stamp a decal on the tilemap when hitting floor
    // The particle is then immediately despawned (no fade animation)
    stayOnTheFloor: Uint8Array, // 0 = normal behavior, 1 = stamp decal on floor hit

    // === Visibility ===
    isItOnScreen: Uint8Array, // 0 = not on screen, 1 = on screen
    // Note: Anchor is always 0.5, 0.5 for particles (centered)
    // Note: No animation support - particles are static sprites
  };

  // Static pool tracking (set during initialization)
  static particleCount = 0;
}
