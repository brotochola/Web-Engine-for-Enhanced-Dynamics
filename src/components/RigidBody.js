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
    inertia: Float32Array, // moment of inertia
    invInertia: Float32Array,

    // Damping
    drag: Float32Array,
    angularDrag: Float32Array,

    // Constraints
    maxVel: Float32Array,
    maxAcc: Float32Array,
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

    // 2. If static, set invMass to 0 (infinite mass - entity won't move)
    //    If dynamic, recalculate mass from collider if available
    if (value) {
      RigidBody.invMass[this.index] = 0;
    } else {
      // Entity is now dynamic - recalculate mass from collider if it exists
      if (Collider.active && Collider.active[this.index]) {
        const shapeType = Collider.shapeType[this.index];
        if (shapeType === 0) {
          // Circle
          const radius = Collider.radius[this.index];
          if (radius > 0) {
            updateMassFromCircle(this.index, radius, RigidBody);
          }
        } else if (shapeType === 1) {
          // Box
          const width = Collider.width[this.index];
          const height = Collider.height[this.index];
          if (width > 0 && height > 0) {
            updateMassFromBox(this.index, width, height, RigidBody);
          }
        }
      }
    }
  }

}
