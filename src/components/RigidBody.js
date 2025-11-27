// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties
// Position and rotation are stored in Transform component

import { Component } from "../core/Component.js";

class RigidBody extends Component {
  // Array schema - defines all physics properties
  static ARRAY_SCHEMA = {
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
  };

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   */
  constructor(index) {
    super();
    this.index = index;
  }

  // Instance getters/setters that forward to static arrays
  get vx() {
    return RigidBody.vx[this.index];
  }
  set vx(v) {
    RigidBody.vx[this.index] = v;
  }

  get vy() {
    return RigidBody.vy[this.index];
  }
  set vy(v) {
    RigidBody.vy[this.index] = v;
  }

  get ax() {
    return RigidBody.ax[this.index];
  }
  set ax(v) {
    RigidBody.ax[this.index] = v;
  }

  get ay() {
    return RigidBody.ay[this.index];
  }
  set ay(v) {
    RigidBody.ay[this.index] = v;
  }

  get px() {
    return RigidBody.px[this.index];
  }
  set px(v) {
    RigidBody.px[this.index] = v;
  }

  get py() {
    return RigidBody.py[this.index];
  }
  set py(v) {
    RigidBody.py[this.index] = v;
  }

  get angularVelocity() {
    return RigidBody.angularVelocity[this.index];
  }
  set angularVelocity(v) {
    RigidBody.angularVelocity[this.index] = v;
  }

  get angularAccel() {
    return RigidBody.angularAccel[this.index];
  }
  set angularAccel(v) {
    RigidBody.angularAccel[this.index] = v;
  }

  get mass() {
    return RigidBody.mass[this.index];
  }
  set mass(v) {
    RigidBody.mass[this.index] = v;
  }

  get invMass() {
    return RigidBody.invMass[this.index];
  }
  set invMass(v) {
    RigidBody.invMass[this.index] = v;
  }

  get inertia() {
    return RigidBody.inertia[this.index];
  }
  set inertia(v) {
    RigidBody.inertia[this.index] = v;
  }

  get invInertia() {
    return RigidBody.invInertia[this.index];
  }
  set invInertia(v) {
    RigidBody.invInertia[this.index] = v;
  }

  get drag() {
    return RigidBody.drag[this.index];
  }
  set drag(v) {
    RigidBody.drag[this.index] = v;
  }

  get angularDrag() {
    return RigidBody.angularDrag[this.index];
  }
  set angularDrag(v) {
    RigidBody.angularDrag[this.index] = v;
  }

  get maxVel() {
    return RigidBody.maxVel[this.index];
  }
  set maxVel(v) {
    RigidBody.maxVel[this.index] = v;
  }

  get maxAcc() {
    return RigidBody.maxAcc[this.index];
  }
  set maxAcc(v) {
    RigidBody.maxAcc[this.index] = v;
  }

  get minSpeed() {
    return RigidBody.minSpeed[this.index];
  }
  set minSpeed(v) {
    RigidBody.minSpeed[this.index] = v;
  }

  get friction() {
    return RigidBody.friction[this.index];
  }
  set friction(v) {
    RigidBody.friction[this.index] = v;
  }

  get velocityAngle() {
    return RigidBody.velocityAngle[this.index];
  }
  set velocityAngle(v) {
    RigidBody.velocityAngle[this.index] = v;
  }

  get speed() {
    return RigidBody.speed[this.index];
  }
  set speed(v) {
    RigidBody.speed[this.index] = v;
  }

  get collisionCount() {
    return RigidBody.collisionCount[this.index];
  }
  set collisionCount(v) {
    RigidBody.collisionCount[this.index] = v ? 1 : 0;
  }
}

// ES6 module export
export { RigidBody };
