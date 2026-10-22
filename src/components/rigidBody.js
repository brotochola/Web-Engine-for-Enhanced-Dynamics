// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties
// Position and rotation are stored in Transform component
// Units (Box2D): vx/vy px/s, ax/ay px/s², angularVelocity rad/s

import { Component } from '../core/component.js';
import { Collider } from './collider.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { Transform } from './transform.js';
import { updateMassFromCircle, updateMassFromBox } from '../util/utils.js';
import { ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';

let _warnedDynamicChain = false;

/**
 * RigidBody.static value for a dynamic body made static only because its
 * collider is a chain (Box2D chains are static). Nonzero, so every reader sees
 * a static body; syncMassFromCollider makes it dynamic again when the collider
 * stops being a chain. A user's static is 1 and is never undone.
 */
export const RIGID_BODY_CHAIN_STATIC = 2;

export class RigidBody extends Component {
  // SoA fields only. vx/vy/angularVelocity/sleeping live on Box2D HEAP
  // (bindBox2dHotFields after box2dReady). Stay null if physics.enabled === false —
  // do not read this.vx on that path (a null-check here would tax the default).
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    static: Uint8Array, // 0 = dynamic, 1 = static, 2 = static because the collider is a chain

    ax: Float32Array,
    ay: Float32Array,

    // Previous pose (physics writes each step before world.step)
    px: Float32Array,
    py: Float32Array,
    pRotation: Float32Array,

    // Angular acceleration (rad/s²) for this step: physics applies torque =
    // angularAccel × inertia (mass for a body without inertia; N-4).
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

    // Linear sleep speed (length units/s ≈ px/s). 0 = Box2D default
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

    let isStatic = RigidBody.static[index] !== 0;
    let massInitialized = false;
    let shapeType = -1;

    if (Collider.active && Collider.active[index]) {
      shapeType = Collider.shapeType[index];
      // Static only because it was a chain: dynamic again once it is not.
      if (RigidBody.static[index] === RIGID_BODY_CHAIN_STATIC && shapeType !== ShapeType.Chain) {
        RigidBody.static[index] = 0;
        isStatic = false;
        markBodyDirty(index, BODY_DIRTY.BODY_TYPE);
      }
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
        const fixtureCount = Collider.fixtureCount ? Collider.fixtureCount[index] : 0;
        const area = fixtureCount > 0
          ? ColliderFixture.areaSum(index)
          : Collider.polygonArea(index);
        if (area > 0) {
          RigidBody.mass[index] = area;
          RigidBody.invMass[index] = isStatic ? 0 : 1 / area;
          massInitialized = true;
        }
      } else if (shapeType === ShapeType.Chain) {
        if (!isStatic) {
          if (!_warnedDynamicChain) {
            _warnedDynamicChain = true;
            console.warn(`[RigidBody] entity ${index} has a chain collider, so the body is static`);
          }
          // Not 1: the body was not made static by choice, and a 1 stuck after
          // the collider stopped being a chain.
          RigidBody.static[index] = RIGID_BODY_CHAIN_STATIC;
          isStatic = true;
        }
        RigidBody.mass[index] = 0;
        RigidBody.invMass[index] = 0;
        massInitialized = true;
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
      const fixtureCount = Collider.fixtureCount ? Collider.fixtureCount[index] : 0;
      if (mass > 0) {
        // Compound I is about body origin (0,0), not each polygon centroid.
        inertia = fixtureCount > 0
          ? ColliderFixture.inertiaAboutOrigin(index, mass)
          : Collider.polygonInertia(index, mass);
      }
    } else if (shapeType === ShapeType.Chain) {
      inertia = 0;
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

  get inertia() {
    return RigidBody.inertia[this.index];
  }

  // ─── Forces and impulses ─────────────────────────────────────────────────
  // Every tick: applyForce / applyTorque write ax / ay / angularAccel (force ×
  // invMass, torque × invInertia). Logic clears those just before the body's
  // next tick, and the physics worker applies them on every step in between
  // as ax × mass and angularAccel × inertia: the force and torque asked for,
  // however the logic and physics frames line up. Once: applyImpulse /
  // applyAngularImpulse run Box2D's own impulse through the command ring, so
  // several in one frame add up, from any worker.

  /**
   * Push for this tick (call it every tick while it should act). Heavier bodies react less.
   * @param {number} index - entity index
   * @param {number} fx - mass·px/s²
   * @param {number} fy
   * @param {number} [atX] - world point; with atY the force also turns the body
   * @param {number} [atY]
   */
  static applyForce(index, fx, fy, atX, atY) {
    const invMass = RigidBody.invMass[index];
    RigidBody.ax[index] += fx * invMass;
    RigidBody.ay[index] += fy * invMass;
    if (atX !== undefined && atY !== undefined) {
      writeCenterOfMass(index);
      const rx = atX - _com[0];
      const ry = atY - _com[1];
      RigidBody.angularAccel[index] += (rx * fy - ry * fx) * RigidBody.invInertia[index];
    }
  }

  /** Turn for this tick (every tick while it should act). @param {number} index @param {number} torque */
  static applyTorque(index, torque) {
    RigidBody.angularAccel[index] += torque * RigidBody.invInertia[index];
  }

  /**
   * One kick on the next physics step (mass·px/s). Heavier bodies react less.
   * @param {number} index
   * @param {number} ix
   * @param {number} iy
   * @param {number} [atX] - world point; with atY the impulse also spins the body
   * @param {number} [atY]
   */
  static applyImpulse(index, ix, iy, atX, atY) {
    const ring = globalThis.Box2dCommandRing;
    if (ring && ring.isCommandRingBound()) ring.enqueueApplyImpulse(index, ix, iy, atX, atY);
  }

  /** One spin kick on the next physics step. @param {number} index @param {number} impulse */
  static applyAngularImpulse(index, impulse) {
    const ring = globalThis.Box2dCommandRing;
    if (ring && ring.isCommandRingBound()) ring.enqueueApplyAngularImpulse(index, impulse);
  }

  applyForce(fx, fy, atX, atY) {
    RigidBody.applyForce(this.index, fx, fy, atX, atY);
  }

  applyTorque(torque) {
    RigidBody.applyTorque(this.index, torque);
  }

  applyImpulse(ix, iy, atX, atY) {
    RigidBody.applyImpulse(this.index, ix, iy, atX, atY);
  }

  applyAngularImpulse(impulse) {
    RigidBody.applyAngularImpulse(this.index, impulse);
  }
}

/** World centre of mass scratch for applyForce at a point (no allocation). */
const _com = new Float64Array(2);

/**
 * The collider offset plus: nothing for a box or a circle, the centroid for a
 * polygon, the area-weighted fixture centroid for a compound collider (the
 * physics host shifts every shape by offsetX / offsetY); rotated into the world.
 */
function writeCenterOfMass(index) {
  let lx = 0;
  let ly = 0;
  if (Collider.active && Collider.active[index]) {
    const extras = Collider.fixtureCount ? Collider.fixtureCount[index] | 0 : 0;
    if (extras > 0 && ColliderFixture.head && ColliderFixture.active) {
      const vx = ColliderFixture.vertexX;
      const vy = ColliderFixture.vertexY;
      const inv = ColliderFixture.INVALID_INDEX;
      const max = ColliderFixture.maxCount | 0;
      let areaTwice = 0;
      let cx = 0;
      let cy = 0;
      let cur = ColliderFixture.headOf(index);
      let guard = 0;
      while (cur !== inv && guard++ < max) {
        if (ColliderFixture.active[cur]) {
          const count = ColliderFixture.vertCount[cur] | 0;
          const base = ColliderFixture.vertBase(cur);
          for (let i = 0; i < count; i++) {
            const j = i + 1 < count ? i + 1 : 0;
            const ax = vx[base + i];
            const ay = vy[base + i];
            const bx = vx[base + j];
            const by = vy[base + j];
            const cross = ax * by - bx * ay;
            areaTwice += cross;
            cx += (ax + bx) * cross;
            cy += (ay + by) * cross;
          }
        }
        cur = ColliderFixture.next[cur];
      }
      if (areaTwice > 1e-12 || areaTwice < -1e-12) {
        lx = cx / (3 * areaTwice);
        ly = cy / (3 * areaTwice);
      }
    } else if (Collider.shapeType[index] === ShapeType.Polygon && Collider.polyCount[index] >= 3) {
      lx = Collider.polyCentroidX[index];
      ly = Collider.polyCentroidY[index];
    }
    lx += Collider.offsetX[index];
    ly += Collider.offsetY[index];
  }
  const c = Transform.rotC[index];
  const s = Transform.rotS[index];
  _com[0] = Transform.x[index] + c * lx - s * ly;
  _com[1] = Transform.y[index] + s * lx + c * ly;
}
