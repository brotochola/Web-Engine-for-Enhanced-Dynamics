// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties
// Position and rotation are stored in Transform component
// Units (Box2D): vx/vy px/s, ax/ay px/s², angularVelocity rad/s

import { Component } from '../core/Component.js';
import { Collider } from './Collider.js';
import { updateMassFromCircle, updateMassFromBox } from '../core/utils.js';
import { ShapeType } from '../core/ConfigDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';

export class RigidBody extends Component {
  // SoA fields only. vx/vy/angularVelocity/sleeping live on Box2D HEAP
  // (bound via bindBox2dHotFields after box2dReady) — not allocated here.
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    static: Uint8Array, // 0 = dynamic, 1 = static

    ax: Float32Array,
    ay: Float32Array,

    // Previous pose (physics writes each step before world.step)
    px: Float32Array,
    py: Float32Array,
    pRotation: Float32Array,

    angularAccel: Float32Array,

    // Mass properties
    mass: Float32Array,
    invMass: Float32Array,
    inertia: Float32Array,
    invInertia: Float32Array,

    // Damping (Box2D body linearDamping / angularDamping)
    linearDamping: Float32Array,
    angularDamping: Float32Array,

    /** 1 = lock Box2D angular DOF (motionLocks.angularZ); sprite stays upright */
    fixedRotation: Uint8Array,

    // Computed values
    speed: Float32Array,

    // Linear sleep speed threshold (m/s). 0 = Box2D default (~0.05 * lengthUnits)
    sleepThreshold: Float32Array,
  };

  static clearArrays() {
    super.clearArrays();
    RigidBody.vx = null;
    RigidBody.vy = null;
    RigidBody.angularVelocity = null;
    RigidBody.sleeping = null;
  }

  // HEAP-bound (not in ARRAY_SCHEMA)
  get vx() {
    return RigidBody.vx[this.index];
  }
  set vx(value) {
    RigidBody.vx[this.index] = value;
  }
  get vy() {
    return RigidBody.vy[this.index];
  }
  set vy(value) {
    RigidBody.vy[this.index] = value;
  }
  get angularVelocity() {
    return RigidBody.angularVelocity[this.index];
  }
  set angularVelocity(value) {
    RigidBody.angularVelocity[this.index] = value;
  }
  get sleeping() {
    return RigidBody.sleeping[this.index];
  }
  set sleeping(value) {
    RigidBody.sleeping[this.index] = value;
  }

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
    let shapeType = -1;

    if (Collider.active && Collider.active[index]) {
      shapeType = Collider.shapeType[index];
      if (shapeType === ShapeType.Circle) {
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
      } else if (shapeType === ShapeType.Box) {
        // Box — rectangle area mass
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
      } else if (shapeType === ShapeType.Polygon) {
        // Convex polygon — shoelace area
        const area = Collider.polygonArea(index);
        if (area > 0) {
          RigidBody.mass[index] = area;
          RigidBody.invMass[index] = isStatic ? 0 : 1 / area;
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

    RigidBody.syncInertiaFromCollider(index, shapeType, isStatic);
    return massInitialized;
  }

  /**
   * Recompute rotational inertia from collider geometry and mass.
   * Circle: I = 0.5 * m * r²; Box: I = m * (w² + h²) / 12;
   * Polygon: Box2D-style about centroid.
   * Static bodies always get invInertia = 0.
   */
  static syncInertiaFromCollider(index, shapeType = -1, isStatic = null) {
    if (!RigidBody.active || !RigidBody.active[index]) return;

    if (isStatic === null) isStatic = RigidBody.static[index] !== 0;
    if (shapeType < 0 && Collider.active && Collider.active[index]) {
      shapeType = Collider.shapeType[index];
    }

    const mass = RigidBody.mass[index];
    let inertia = 0;

    if (shapeType === ShapeType.Circle) {
      const r = Collider.radius[index];
      if (r > 0 && mass > 0) inertia = 0.5 * mass * r * r;
    } else if (shapeType === ShapeType.Box) {
      const w = Collider.width[index];
      const h = Collider.height[index];
      if (w > 0 && h > 0 && mass > 0) inertia = (mass * (w * w + h * h)) / 12;
    } else if (shapeType === ShapeType.Polygon) {
      if (mass > 0) inertia = Collider.polygonInertia(index, mass);
    }

    RigidBody.inertia[index] = inertia;
    RigidBody.invInertia[index] = isStatic || !(inertia > 0) ? 0 : 1 / inertia;
  }

  /**
   * Instance convenience wrapper for custom setup/onSpawned code.
   * @returns {boolean}
   */
  syncMassFromCollider() {
    return RigidBody.syncMassFromCollider(this.index);
  }

  /**
   * Toggle RigidBody participation. Off + Collider still on → implicit static
   * body with shape. Host applies BODY_TYPE; mass from collider density.
   */
  get active() {
    return RigidBody.active[this.index];
  }
  set active(value) {
    const next = value ? 1 : 0;
    if (RigidBody.active[this.index] === next) return;
    RigidBody.active[this.index] = next;
    markBodyDirty(
      this.index,
      BODY_DIRTY.LIFECYCLE | BODY_DIRTY.BODY_TYPE | BODY_DIRTY.MASS,
    );
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
    markBodyDirty(this.index, BODY_DIRTY.BODY_TYPE);
  }

  get linearDamping() {
    return RigidBody.linearDamping[this.index];
  }
  set linearDamping(value) {
    RigidBody.linearDamping[this.index] = Math.max(0, Number(value) || 0);
    markBodyDirty(this.index, BODY_DIRTY.DAMPING);
  }

  get angularDamping() {
    return RigidBody.angularDamping[this.index];
  }
  set angularDamping(value) {
    RigidBody.angularDamping[this.index] = Math.max(0, Number(value) || 0);
    markBodyDirty(this.index, BODY_DIRTY.DAMPING);
  }

  get sleepThreshold() {
    return RigidBody.sleepThreshold[this.index];
  }
  set sleepThreshold(value) {
    const v = Math.max(0, Number(value) || 0);
    RigidBody.sleepThreshold[this.index] = v;
    if (typeof globalThis.Box2dCommandRing?.enqueueSetSleepThreshold === 'function') {
      globalThis.Box2dCommandRing.enqueueSetSleepThreshold(this.index, v);
    }
  }

  /**
   * Mass — keeps invMass + rotational inertia in sync when set at runtime.
   */
  get mass() {
    return RigidBody.mass[this.index];
  }
  set mass(value) {
    const m = value > 0 ? value : 0;
    RigidBody.mass[this.index] = m;
    const isStatic = RigidBody.static[this.index] !== 0;
    RigidBody.invMass[this.index] = isStatic || !(m > 0) ? 0 : 1 / m;
    RigidBody.syncInertiaFromCollider(this.index, -1, isStatic);
    markBodyDirty(this.index, BODY_DIRTY.MASS);
  }

}
