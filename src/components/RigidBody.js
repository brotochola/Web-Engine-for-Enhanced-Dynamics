// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties

import { Component } from '../core/Component.js';

class RigidBody extends Component {
  // Array schema - defines all physics properties
  static ARRAY_SCHEMA = {
    // Position (for physics simulation)
    x: Float32Array,
    y: Float32Array,

    // Linear motion
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,

    // Verlet integration (for alternative physics mode)
    px: Float32Array, // Previous X position
    py: Float32Array, // Previous Y position

    // Angular motion
    rotation: Float32Array,
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

    // Physics mode
    isKinematic: Uint8Array, // 0 = dynamic, 1 = kinematic
    useGravity: Uint8Array,

    // Computed values
    velocityAngle: Float32Array,
    speed: Float32Array,
    collisionCount: Uint8Array, // Number of collisions this frame
  };
}

// ES6 module export
export { RigidBody };
