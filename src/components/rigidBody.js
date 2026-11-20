// RigidBody.js - Physics component for entity motion and dynamics
// Handles velocity, acceleration, mass, and physics properties
// Position and rotation are stored in Transform component
// Units (Box2D): vx/vy px/s, ax/ay px/s², angularVelocity rad/s

import { Component } from '../core/component.js';
import { Collider } from './collider.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { Transform as TransformImport, componentBitsAt as componentBitsAtImport } from './transform.js';
import { updateMassFromCircle, updateMassFromBox } from '../util/utils.js';
import { ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';
import { lateBodyWrite, massFromCollider, massSetByHand } from '../core/debug/devChecks.js';
import { SETTER_ARGS as SETTER_ARGSImport, SETTER_ARGS64 as SETTER_ARGS64Import } from '../core/setterArgs.js';
import { HAS_BODY as HAS_BODYImport } from '../core/entityTypes.js';
import {
  enqueueSetAngularVelocity as enqueueSetAngularVelocityImport,
  enqueueSetAwake as enqueueSetAwakeImport,
  enqueueSetFixedRotation as enqueueSetFixedRotationImport,
  enqueueSetSleepThreshold as enqueueSetSleepThresholdImport,
  enqueueSetVelocity as enqueueSetVelocityImport,
  isCommandRingBound as isCommandRingBoundImport,
} from '../box2d/box2dCommandRing.js';

// E-474: the setters' imports as module consts, which TurboFan folds (an import is a cell it loads and hole-checks at
// each use). This module is in gameObject.js's import cycle (it imports utils.js, which imports gameObject.js); these
// exporters are not (importAliases.test.js).
const Transform = TransformImport;
const componentBitsAt = componentBitsAtImport;
const SETTER_ARGS = SETTER_ARGSImport;
const SETTER_ARGS64 = SETTER_ARGS64Import;
const HAS_BODY = HAS_BODYImport;
const enqueueSetAngularVelocity = enqueueSetAngularVelocityImport;
const enqueueSetAwake = enqueueSetAwakeImport;
const enqueueSetFixedRotation = enqueueSetFixedRotationImport;
const enqueueSetSleepThreshold = enqueueSetSleepThresholdImport;
const enqueueSetVelocity = enqueueSetVelocityImport;
const isCommandRingBound = isCommandRingBoundImport;

let _warnedDynamicChain = false;
/**
 * N-132: slots whose rigidBody.mass was set by hand since the last sync from the collider (this thread: a spawn and
 * its onSpawned run on one). The spawn's sync keeps that mass; a shape setter's sync replaces it and clears the mark.
 */
let massByHand = new Uint8Array(0);

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
   * @param {boolean} [fromSpawn] GameObject.spawn's sync, after onSpawned (DX-GUARDS E4's text)
   * @returns {boolean} True when collider geometry supplied mass, false when unit mass was used
   */
  static syncMassFromCollider(index, fromSpawn = false) {
    if (!RigidBody.active || !RigidBody.active[index]) return false;
    const massBefore = RigidBody.mass[index];
    // N-132: the spawn's sync keeps a mass set by hand in onSpawned (or the spawn config); a chain stays static.
    if (fromSpawn && index < massByHand.length && massByHand[index] === 1) {
      massByHand[index] = 0;
      const shape = Collider.active && Collider.active[index] ? Collider.shapeType[index] : -1;
      if (shape !== ShapeType.Chain) {
        const isStaticBody = RigidBody.static[index] !== 0;
        RigidBody.invMass[index] = isStaticBody || !(massBefore > 0) ? 0 : 1 / massBefore;
        RigidBody.syncInertiaFromCollider(index, shape, isStaticBody);
        return true;
      }
    }

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
    // DX-GUARDS E4 (debug build): a mass set by hand, replaced by the collider's.
    if (massInitialized && index < massByHand.length) massByHand[index] = 0;
    if (massInitialized && !isStatic) massFromCollider(index, massBefore, RigidBody.mass[index]);
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
    RigidBody.setActive(this.index, value);
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
    // A RigidBody's own: no component check (RigidBody.setStatic, by type, checks).
    bodyStaticAt(this.index, HAS_BODY, value);
  }

  get linearDamping() {
    return RigidBody.linearDamping[this.index];
  }
  set linearDamping(value) {
    RigidBody.setLinearDamping(this.index, value);
  }

  get angularDamping() {
    return RigidBody.angularDamping[this.index];
  }
  set angularDamping(value) {
    RigidBody.setAngularDamping(this.index, value);
  }

  get sleepThreshold() {
    return RigidBody.sleepThreshold[this.index];
  }
  set sleepThreshold(value) {
    RigidBody.setSleepThreshold(this.index, value);
  }

  /**
   * The column only: once the body is made, GameObject.setFixedRotation (or this.fixedRotation = v on the entity, or
   * RigidBody.setFixedRotation(i, on)) is what reaches Box2D (DX-GUARDS E3 names a write here then).
   */
  get fixedRotation() {
    return RigidBody.fixedRotation[this.index];
  }
  set fixedRotation(value) {
    RigidBody.fixedRotation[this.index] = value;
    lateBodyWrite(this.index, 'rigidBody.fixedRotation');
  }

  /** N-132: rigidBody.mass was set by hand on `index`; the spawn's sync from the collider keeps it. */
  static markMassByHand(index) {
    if (index >= massByHand.length) {
      const grown = new Uint8Array(Math.max(index + 1, massByHand.length * 2, 1024));
      grown.set(massByHand);
      massByHand = grown;
    }
    massByHand[index] = 1;
  }

  /** A spawn starts the slot's mass over: nothing set by hand yet. */
  static clearMassByHand(index) {
    if (index < massByHand.length) massByHand[index] = 0;
  }

  /** Mass: keeps invMass and the rotational inertia in sync when set at runtime (RigidBody.setMass). */
  get mass() {
    return RigidBody.mass[this.index];
  }
  set mass(value) {
    RigidBody.setMass(this.index, value);
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

  // ─── Motion and body settings by index (E-533) ───────────────────────────
  // What the entity's methods and setters do (entity.setVelocity, entity.vx = v, entity.isStatic = on, ...), without an
  // instance (a static tickAll, a static hook): the columns, and Box2D's body through the command ring or its dirty
  // marks. The entity's methods do the same work through the functions below the class; an entity with no RigidBody
  // is left alone, as by the entity's (its type's components, entityTypes.js). The doubles go through SETTER_ARGS
  // (N-215; SETTER_ARGS64 where the work computes with them): each static stays small enough for TurboFan to inline it,
  // and the work takes ints only. A velocity that is the same again (as float32, the columns' type: N-170) sends
  // nothing.

  /**
   * entity.setVelocity(vx, vy) by index: the columns, and Box2D's body on its next step.
   * @param {number} index - entity index
   * @param {number} vx - px/s
   * @param {number} vy - px/s
   */
  static setVelocity(index, vx, vy) {
    const a = SETTER_ARGS;
    a[0] = vx;
    a[1] = vy;
    velocityAt(index, componentBitsAt(index));
  }

  /** entity.vx = vx by index (px/s). @param {number} index @param {number} vx */
  static setVx(index, vx) {
    SETTER_ARGS[0] = vx;
    vxAt(index, componentBitsAt(index));
  }

  /** entity.vy = vy by index (px/s). @param {number} index @param {number} vy */
  static setVy(index, vy) {
    SETTER_ARGS[0] = vy;
    vyAt(index, componentBitsAt(index));
  }

  /** entity.angularVelocity = w by index (rad/s). @param {number} index @param {number} w */
  static setAngularVelocity(index, w) {
    SETTER_ARGS[0] = w;
    angularVelocityAt(index, componentBitsAt(index));
  }

  /**
   * entity.addVelocity(dvx, dvy) by index: a kick that ignores mass (px/s).
   * @param {number} index
   * @param {number} dvx
   * @param {number} dvy
   */
  static addVelocity(index, dvx, dvy) {
    const a = SETTER_ARGS64;
    a[0] = dvx;
    a[1] = dvy;
    addVelocityAt(index, componentBitsAt(index));
  }

  /** entity.scaleVelocity(factor) by index (0.95: 5 % slower). @param {number} index @param {number} factor */
  static scaleVelocity(index, factor) {
    SETTER_ARGS64[0] = factor;
    scaleVelocityAt(index, componentBitsAt(index));
  }

  /**
   * entity.addAcceleration(ax, ay) by index (px/s²): it holds until the body's next tick, as the entity's does.
   * @param {number} index
   * @param {number} ax
   * @param {number} ay
   */
  static addAcceleration(index, ax, ay) {
    const a = SETTER_ARGS64;
    a[0] = ax;
    a[1] = ay;
    accelerationAt(index, componentBitsAt(index));
  }

  /**
   * entity.accelerateTowards(x, y, acc) by index: acc px/s² towards the world point (x, y), nothing within 1 px of it.
   * @param {number} index
   * @param {number} x
   * @param {number} y
   * @param {number} acc
   */
  static accelerateTowards(index, x, y, acc) {
    const a = SETTER_ARGS64;
    a[0] = x;
    a[1] = y;
    a[2] = acc;
    accelerateTowardsAt(index, componentBitsAt(index));
  }

  /**
   * entity.setFixedRotation(on) by index: lock or unlock the body's turn (the column, and Box2D's body once made).
   * @param {number} index
   * @param {number | boolean} on
   */
  static setFixedRotation(index, on) {
    fixedRotationAt(index, componentBitsAt(index), on);
  }

  /**
   * entity.isStatic = on by index: the body's type (Box2D static or dynamic), its mass synced from the collider. Not the
   * class's `static isStatic` (static scenery).
   * @param {number} index
   * @param {number | boolean} on
   */
  static setStatic(index, on) {
    bodyStaticAt(index, componentBitsAt(index), on);
  }

  /** entity.setAwake(awake) by index: wake (or put to sleep) Box2D's body. @param {number} index @param {boolean} [awake] */
  static setAwake(index, awake = true) {
    awakeAt(index, componentBitsAt(index), awake);
  }

  /**
   * rigidBody.active = on by index: off with a Collider still on leaves an implicit static body with the shape.
   * @param {number} index
   * @param {number | boolean} on
   */
  static setActive(index, on) {
    const next = on ? 1 : 0;
    if (RigidBody.active[index] === next) return;
    RigidBody.active[index] = next;
    markBodyDirty(index, BODY_DIRTY.LIFECYCLE | BODY_DIRTY.BODY_TYPE | BODY_DIRTY.MASS);
  }

  /** rigidBody.linearDamping = d by index (0 or more). @param {number} index @param {number} d */
  static setLinearDamping(index, d) {
    RigidBody.linearDamping[index] = Math.max(0, Number(d) || 0);
    markBodyDirty(index, BODY_DIRTY.DAMPING);
  }

  /** rigidBody.angularDamping = d by index (0 or more). @param {number} index @param {number} d */
  static setAngularDamping(index, d) {
    RigidBody.angularDamping[index] = Math.max(0, Number(d) || 0);
    markBodyDirty(index, BODY_DIRTY.DAMPING);
  }

  /**
   * rigidBody.sleepThreshold = t by index: the speed (px/s) under which Box2D lets the body sleep, 0 its default.
   * @param {number} index
   * @param {number} t
   */
  static setSleepThreshold(index, t) {
    const v = Math.max(0, Number(t) || 0);
    RigidBody.sleepThreshold[index] = v;
    enqueueSetSleepThreshold(index, v);
  }

  /**
   * rigidBody.mass = m by index: invMass and the rotational inertia follow; the spawn's sync from the collider keeps a
   * mass set by hand (N-132).
   * @param {number} index
   * @param {number} m
   */
  static setMass(index, m) {
    SETTER_ARGS64[0] = m;
    massAt(index);
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

/**
 * E-474: the class as a module const for the work below and the statics above. TurboFan folds a module const; a module
 * function reads an exported class through its export cell, a load and a hole check at each use.
 */
const RigidBodyClass = RigidBody;

// ═══════════════════════════════════════════════════════════════════════════
// E-533: the motion work, by entity index and the entity's component bits (entityTypes.js): what RigidBody.setVx and
// its siblings run, and what the entity's methods and setters run (with the bits on their class's prototype,
// this._componentBits). Ints only: each reads its values from SETTER_ARGS (or SETTER_ARGS64) first, before it calls
// anything. Nothing without a RigidBody (HAS_BODY).
// ═══════════════════════════════════════════════════════════════════════════

/** set vx's work, the velocity in SETTER_ARGS[0]. @param {number} i @param {number} bits */
export function vxAt(i, bits) {
  const vx = SETTER_ARGS[0];
  if ((bits & HAS_BODY) === 0) return;
  const B = RigidBodyClass;
  if (B.vx[i] === vx) return;
  B.vx[i] = vx;
  if (isCommandRingBound()) enqueueSetVelocity(i, vx, B.vy[i]);
}

/** set vy's work, the velocity in SETTER_ARGS[0]. @param {number} i @param {number} bits */
export function vyAt(i, bits) {
  const vy = SETTER_ARGS[0];
  if ((bits & HAS_BODY) === 0) return;
  const B = RigidBodyClass;
  if (B.vy[i] === vy) return;
  B.vy[i] = vy;
  if (isCommandRingBound()) enqueueSetVelocity(i, B.vx[i], vy);
}

/** set angularVelocity's work, the velocity in SETTER_ARGS[0]. @param {number} i @param {number} bits */
export function angularVelocityAt(i, bits) {
  const w = SETTER_ARGS[0];
  if ((bits & HAS_BODY) === 0) return;
  const B = RigidBodyClass;
  if (B.angularVelocity[i] === w) return;
  B.angularVelocity[i] = w;
  if (isCommandRingBound()) enqueueSetAngularVelocity(i, w);
}

/** setVelocity's work, vx and vy in SETTER_ARGS. @param {number} i @param {number} bits */
export function velocityAt(i, bits) {
  const vx = SETTER_ARGS[0];
  const vy = SETTER_ARGS[1];
  if ((bits & HAS_BODY) === 0) return;
  const B = RigidBodyClass;
  if (B.vx[i] === vx && B.vy[i] === vy) return;
  B.vx[i] = vx;
  B.vy[i] = vy;
  if (isCommandRingBound()) enqueueSetVelocity(i, vx, vy);
}

/** addVelocity's work, dvx and dvy in SETTER_ARGS64 (the sum of the column and the double given). */
export function addVelocityAt(i, bits) {
  const dvx = SETTER_ARGS64[0];
  const dvy = SETTER_ARGS64[1];
  if ((bits & HAS_BODY) === 0) return;
  const vx = RigidBodyClass.vx;
  const vy = RigidBodyClass.vy;
  vx[i] += dvx;
  vy[i] += dvy;
  if (isCommandRingBound()) enqueueSetVelocity(i, vx[i], vy[i]);
}

/** scaleVelocity's work, the factor in SETTER_ARGS64[0]. @param {number} i @param {number} bits */
export function scaleVelocityAt(i, bits) {
  const factor = SETTER_ARGS64[0];
  if ((bits & HAS_BODY) === 0) return;
  const vx = RigidBodyClass.vx;
  const vy = RigidBodyClass.vy;
  vx[i] *= factor;
  vy[i] *= factor;
  if (isCommandRingBound()) enqueueSetVelocity(i, vx[i], vy[i]);
}

/**
 * addAcceleration's work, ax and ay in SETTER_ARGS64. N-290: RigidBody.sleeping is physics' paint of Box2D's sleep,
 * not a request: physics wakes a sleeping body that has an acceleration only where its paint still says asleep
 * (bodies_apply_accelerations), so a 0 stored here before physics' turn kept the body asleep and lost the
 * acceleration. Physics paints and clears that byte every step on its own core, so a store also took the line from it
 * every call (E-434).
 * @param {number} i
 * @param {number} bits
 */
export function accelerationAt(i, bits) {
  const ax = SETTER_ARGS64[0];
  const ay = SETTER_ARGS64[1];
  if ((bits & HAS_BODY) === 0) return;
  RigidBodyClass.ax[i] += ax;
  RigidBodyClass.ay[i] += ay;
}

/** accelerateTowards' work, x, y and acc in SETTER_ARGS64. @param {number} i @param {number} bits */
export function accelerateTowardsAt(i, bits) {
  const x = SETTER_ARGS64[0];
  const y = SETTER_ARGS64[1];
  const acc = SETTER_ARGS64[2];
  if ((bits & HAS_BODY) === 0) return;
  const dx = x - Transform.x[i];
  const dy = y - Transform.y[i];
  const distSq = dx * dx + dy * dy;
  // Within 1 px: no direction worth the division.
  if (distSq > 1) {
    const factor = acc / Math.sqrt(distSq);
    RigidBodyClass.ax[i] += dx * factor;
    RigidBodyClass.ay[i] += dy * factor;
  }
}

/**
 * setFixedRotation's work: the column, and Box2D's body through the ring (a write to the column alone, as
 * rigidBody.fixedRotation = v does, reaches Box2D only when the body is made).
 * @param {number} i
 * @param {number} bits
 * @param {number | boolean} on
 */
export function fixedRotationAt(i, bits, on) {
  if ((bits & HAS_BODY) === 0) return;
  const v = on ? 1 : 0;
  RigidBodyClass.fixedRotation[i] = v;
  if (isCommandRingBound()) enqueueSetFixedRotation(i, v);
}

/**
 * The body's type (entity.isStatic = on, rigidBody.static = on): static bodies keep invMass 0, and the mass is synced
 * from the collider again.
 * @param {number} i
 * @param {number} bits
 * @param {number | boolean} on
 */
export function bodyStaticAt(i, bits, on) {
  if ((bits & HAS_BODY) === 0) return;
  RigidBodyClass.static[i] = on ? 1 : 0;
  RigidBody.syncMassFromCollider(i);
  markBodyDirty(i, BODY_DIRTY.BODY_TYPE);
}

/**
 * setAwake's work: the sleeping paint at once, and Box2D's body through the ring (writing RigidBody.sleeping alone
 * does not change the solver).
 * @param {number} i
 * @param {number} bits
 * @param {boolean} awake
 */
export function awakeAt(i, bits, awake) {
  if ((bits & HAS_BODY) === 0) return;
  const on = awake ? 1 : 0;
  const sleeping = RigidBodyClass.sleeping;
  if (sleeping) sleeping[i] = on ? 0 : 1;
  if (isCommandRingBound()) enqueueSetAwake(i, on);
}

/** rigidBody.mass's work, the mass in SETTER_ARGS64[0] (its inverse is of the double given). @param {number} i */
function massAt(i) {
  const value = SETTER_ARGS64[0];
  const m = value > 0 ? value : 0;
  const B = RigidBodyClass;
  B.mass[i] = m;
  RigidBody.markMassByHand(i);
  massSetByHand(i);
  const isStatic = B.static[i] !== 0;
  B.invMass[i] = isStatic || !(m > 0) ? 0 : 1 / m;
  RigidBody.syncInertiaFromCollider(i, -1, isStatic);
  markBodyDirty(i, BODY_DIRTY.MASS);
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
