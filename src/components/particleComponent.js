// ParticleComponent.js - Self-contained particle data
// Particles are NOT GameObjects - they have their own separate pool
// This component contains ALL data needed for particles (position, velocity, visuals)
// Particles have fixed anchor (0.5, 0.5); optional over-life tweens + short frame cycle

import { Component } from '../core/component.js';

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

    // === Visuals (sprites + optional life-progress frame cycle) ===
    scaleX: Float32Array, // Horizontal scale
    scaleY: Float32Array, // Vertical scale
    alpha: Float32Array, // Opacity (0-1)
    tint: Uint32Array, // Color tint (0xRRGGBB) - modified by lighting
    baseTint: Uint32Array, // Original color set by emitter (preserved for lighting calculation)
    textureId: Uint16Array, // Index into texture atlas (NOT spritesheetId)
    rotC: Float32Array, // Facing cos
    rotS: Float32Array, // Facing sin
    flipX: Uint8Array, // 0 = normal, 1 = flip horizontally
    flipY: Uint8Array, // 0 = normal, 1 = flip vertically

    // === Floor behavior ===
    fadeOnTheFloor: Uint16Array, // Time in ms to fade out when on floor (0 = no fade)
    timeOnFloor: Uint16Array, // Tracks how long particle has been on floor
    initialAlpha: Float32Array, // Alpha when particle hit the floor (for fade calculation)

    // === Floor decals (stamp on ground hit) ===
    // When stayOnTheFloor=1, particle will stamp a decal on the tilemap when hitting floor
    // The particle is then immediately despawned (no fade animation)
    stayOnTheFloor: Uint8Array, // 0 = normal behavior, 1 = stamp decal on floor hit

    // === Ground Despawn ===
    // When despawnOnGroundContact=1, particle will despawn immediately when touching the ground (no decal stamping)
    despawnOnGroundContact: Uint8Array, // 0 = normal behavior, 1 = despawn on ground contact

    // === Over-life tweens (from/to) ===
    // tweenMask bits: ALPHA=1 SCALEX=2 SCALEY=4 TINT=8 ROT=16 (see particleTween.PARTICLE_TWEEN)
    tweenMask: Uint16Array,
    easeId: Uint8Array,
    alphaFrom: Float32Array,
    alphaTo: Float32Array,
    scaleXFrom: Float32Array,
    scaleXTo: Float32Array,
    scaleYFrom: Float32Array,
    scaleYTo: Float32Array,
    tintFrom: Uint32Array,
    tintTo: Uint32Array,
    rotFrom: Float32Array, // radians (API still takes degrees)
    rotTo: Float32Array,
    // Angular velocity (rad per ms) — constant or from/to over life
    angularVelFrom: Float32Array,
    angularVelTo: Float32Array,
    hasAngularVel: Uint8Array,
    // Frame cycle over life (resolved texture ids)
    animCount: Uint8Array,
    animMode: Uint8Array, // 0=none, 1=cycle by life progress
    animFrames: { type: Uint16Array, length: 8 },

    // === Visibility ===
    isItOnScreen: Uint8Array, // 0 = not on screen, 1 = on screen

    // === Decal Blend Mode ===
    // Used when stayOnTheFloor=1 to determine how decal is blended onto tilemap
    // 0 = normal (alpha over), 1 = multiply (darkens underlying pixels)
    blendMode: Uint8Array,

    // Layer subscriptions (bit i = Layer.id)
    layerMask: Uint16Array,

    // === Physics / view mode (set by ParticleEmitter.emit / emitFlat / emitZenithal) ===
    // flat=1: screen-plane XY + gravity on vy; ignore ground / floor flags
    flat: Uint8Array,
    // viewMode: CAMERA_TYPES.TOPDOWN | ZENITHAL
    viewMode: Uint8Array,
    // Note: Anchor is always 0.5, 0.5 for particles (centered)
  };

  // Static pool tracking (set during initialization)
  static particleCount = 0;

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.rotC) this.rotC.fill(1);
  }
}
