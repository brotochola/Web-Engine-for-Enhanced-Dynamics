// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties
// Position and rotation are stored in Transform component

import { Component } from '../core/Component.js';
import { Collider } from './Collider.js';
import { updateMassFromCircle, updateMassFromBox } from '../core/utils.js';

export class RigidBody extends Component {
  // Array schema - defines all physics properties
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    static: Uint8Array, // 0 = dynamic, 1 = static

    // Linear motion
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,

    // Verlet integration (for alternative physics mode)
    px: Float32Array, // Previous X position
    py: Float32Array, // Previous Y position

    // Angular motion
    angularVelocity: Float32Array,
    angularAccel: Float32Array,

    // Mass properties
    mass: Float32Array,
    invMass: Float32Array,

    // Damping
    drag: Float32Array,
    angularDrag: Float32Array,

    // Constraints
    maxVel: Float32Array,
    minSpeed: Float32Array,
    friction: Float32Array,

    // Computed values
    velocityAngle: Float32Array,
    speed: Float32Array,
    collisionCount: Uint8Array, // Number of collisions this frame

    // Sleeping optimization
    sleeping: Uint8Array, // 0 = awake, 1 = sleeping (skips physics integration)
    stillnessTime: Float32Array, // Time entity has been still (in frames or seconds)
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOM GETTERS/SETTERS
  // These override the auto-generated accessors from Component._createInstanceProperties()
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recompute mass and inverse mass from the entity's Collider.
   *
   * Dynamic bodies with invalid or missing collider geometry become unit-mass
   * bodies once here. Static bodies keep `invMass = 0` even if their collider
   * dimensions change later.
   *
   * @param {number} index - Entity index
   * @returns {boolean} True when collider geometry supplied mass, false when unit mass was used
   */
  static syncMassFromCollider(index) {
    if (!RigidBody.active || !RigidBody.active[index]) return false;

    const isStatic = RigidBody.static[index] !== 0;
    let massInitialized = false;

    if (Collider.active && Collider.active[index]) {
      const shapeType = Collider.shapeType[index];
      if (shapeType === 0) {
        const radius = Collider.radius[index];
        if (radius > 0) {
          if (isStatic) {
            RigidBody.mass[index] = Math.PI * radius * radius;
            RigidBody.invMass[index] = 0;
          } else {
            updateMassFromCircle(index, radius, RigidBody);
          }
          massInitialized = true;
        }
      } else if (shapeType === 1) {
        const width = Collider.width[index];
        const height = Collider.height[index];
        if (width > 0 && height > 0) {
          if (isStatic) {
            RigidBody.mass[index] = width * height;
            RigidBody.invMass[index] = 0;
          } else {
            updateMassFromBox(index, width, height, RigidBody);
          }
          massInitialized = true;
        }
      }
    }

    if (!massInitialized) {
      const currentMass = RigidBody.mass[index];
      if (isStatic) {
        if (!(currentMass > 0)) RigidBody.mass[index] = 0;
        RigidBody.invMass[index] = 0;
      } else if (currentMass > 0) {
        RigidBody.invMass[index] = 1 / currentMass;
      } else {
        RigidBody.mass[index] = 1;
        RigidBody.invMass[index] = 1;
      }
    }

    return massInitialized;
  }

  /**
   * Instance convenience wrapper for custom setup/onSpawned code.
   * @returns {boolean}
   */
  syncMassFromCollider() {
    return RigidBody.syncMassFromCollider(this.index);
  }

  /**
   * Static property - custom setter that sets invMass = 0 for static entities
   * Static entities have infinite mass (invMass = 0) and don't move
   *
   * Example:
   *   this.rigidBody.static = 1;  // Sets invMass = 0 (infinite mass)
   */
  get static() {
    return RigidBody.static[this.index];
  }
  set static(value) {
    // 1. Store the static value
    RigidBody.static[this.index] = value ? 1 : 0;

    // 2. Re-sync from collider geometry; static bodies preserve invMass = 0.
    RigidBody.syncMassFromCollider(this.index);
  }

}
