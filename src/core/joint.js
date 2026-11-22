// Joint.js - Box2D-mapped joint pool (distance / revolute / weld)
// Thread-safe pool backed by SharedArrayBuffer; syncs to WASM in weedjs_post.
// Extends SharedAtomicPool for atomic free list operations.

import { SharedAtomicPool } from './sharedAtomicPool.js';
import { Transform } from '../components/transform.js';
import { JOINT_TYPE } from '../box2d/box2dConstants.js';
import { entityIdBytes } from '../util/entityIdWidth.js';
import { reportJointPoolExhausted } from '../util/poolExhaustion.js';

function jointGetAPacked(idx) {
  return Joint.pairs[idx] >>> 16;
}
function jointGetBPacked(idx) {
  return Joint.pairs[idx] & 0xffff;
}
function jointSetPacked(idx, entityA, entityB) {
  Joint.pairs[idx] = (entityA << 16) | (entityB & 0xffff);
}
function jointGetAWide(idx) {
  return Joint.entityA[idx] >>> 0;
}
function jointGetBWide(idx) {
  return Joint.entityB[idx] >>> 0;
}
function jointSetWide(idx, entityA, entityB) {
  Joint.entityA[idx] = entityA >>> 0;
  Joint.entityB[idx] = entityB >>> 0;
}
/**
 * CR-19: the joint pool's columns in buffer order, one table for getBufferSize, initializeArrays and reset (the offsets
 * they wrote by hand; physicsHostImpl mirrors this order: append, don't move). [field, array type]: a 1-byte column
 * pads to 4 bytes after it. PAIRS is the entity pair (entityA and entityB, two Uint32 columns, when ids are 4 bytes; one
 * packed Uint32 column, pairs, when 2), META the active list's two Int32 words (activeMeta, activeCount, activeListLock),
 * ALIGN pads to 4 bytes, HEAD the per-entity list heads (entityCount Uint16, or none).
 */
const PAIRS = 1;
const META = 2;
const ALIGN = 3;
const HEAD = 4;
const JOINT_LAYOUT = [
  ['type', Uint8Array],
  [PAIRS],
  ['localAnchorAX', Float32Array], ['localAnchorAY', Float32Array], ['localAnchorBX', Float32Array], ['localAnchorBY', Float32Array],
  ['forceThreshold', Float32Array], ['torqueThreshold', Float32Array],
  ['active', Uint8Array],
  // Distance
  ['length', Float32Array], ['enableSpring', Uint8Array], ['hertz', Float32Array], ['dampingRatio', Float32Array],
  // Revolute (and prismatic)
  ['enableLimit', Uint8Array], ['lowerAngle', Float32Array], ['upperAngle', Float32Array],
  ['enableMotor', Uint8Array], ['motorSpeed', Float32Array], ['maxMotorTorque', Float32Array],
  // Weld (linearHertz is prismatic's axis angle too)
  ['linearHertz', Float32Array], ['angularHertz', Float32Array],
  ['linearDampingRatio', Float32Array], ['angularDampingRatio', Float32Array],
  // The dense active list, revisions, the intrusive per-entity lists
  ['activeIndices', Uint16Array], ['activeIndexPositions', Uint16Array],
  [META],
  ['revision', Uint32Array], [ALIGN],
  ['nextA', Uint16Array], ['nextB', Uint16Array], [ALIGN],
  [HEAD], [ALIGN],
];

const align4 = (o) => Math.ceil(o / 4) * 4;

/**
 * Walks JOINT_LAYOUT for n joints and e entities: with a buffer, sets each column's view on `pool` (null with none: the
 * pair columns that do not apply, the heads when e is 0). Returns the bytes the pool takes.
 */
function layJoints(pool, buffer, n, e, wide) {
  const bind = buffer !== null;
  let offset = 0;
  for (const [name, Type] of JOINT_LAYOUT) {
    if (name === PAIRS) {
      if (bind) {
        pool.entityA = wide ? new Uint32Array(buffer, offset, n) : null;
        pool.entityB = wide ? new Uint32Array(buffer, offset + n * 4, n) : null;
        pool.pairs = wide ? null : new Uint32Array(buffer, offset, n);
      }
      offset += wide ? n * 8 : n * 4;
    } else if (name === META) {
      if (bind) {
        pool.activeMeta = new Int32Array(buffer, offset, 2);
        pool.activeCount = new Int32Array(buffer, offset, 1);
        pool.activeListLock = new Int32Array(buffer, offset + 4, 1);
      }
      offset += 8;
    } else if (name === ALIGN) {
      offset = align4(offset);
    } else if (name === HEAD) {
      if (bind) pool.head = e > 0 ? new Uint16Array(buffer, offset, e) : null;
      offset += e * 2;
    } else {
      if (bind) pool[name] = new Type(buffer, offset, n);
      offset += n * Type.BYTES_PER_ELEMENT;
      if (Type.BYTES_PER_ELEMENT === 1) offset = align4(offset);
    }
  }
  return offset;
}

/** Joint.update's props by joint type: [prop, column, stored as 1/0]. The anchors apply to every type. */
const ANCHOR_PROPS = [
  ['localAnchorAX', 'localAnchorAX'], ['localAnchorAY', 'localAnchorAY'],
  ['localAnchorBX', 'localAnchorBX'], ['localAnchorBY', 'localAnchorBY'],
];
const UPDATE_PROPS = {
  [JOINT_TYPE.DISTANCE]: [
    ['length', 'length'], ['enableSpring', 'enableSpring', true], ['hertz', 'hertz'], ['dampingRatio', 'dampingRatio'],
  ],
  [JOINT_TYPE.REVOLUTE]: [
    ['enableLimit', 'enableLimit', true], ['lowerAngle', 'lowerAngle'], ['upperAngle', 'upperAngle'],
    ['enableMotor', 'enableMotor', true], ['motorSpeed', 'motorSpeed'], ['maxMotorTorque', 'maxMotorTorque'],
  ],
  // maxMotorForce after maxMotorTorque: given both, the force is kept, as before.
  [JOINT_TYPE.PRISMATIC]: [
    ['axisAngle', 'linearHertz'], ['enableLimit', 'enableLimit', true], ['lowerTranslation', 'lowerAngle'],
    ['upperTranslation', 'upperAngle'], ['enableMotor', 'enableMotor', true], ['motorSpeed', 'motorSpeed'],
    ['maxMotorTorque', 'maxMotorTorque'], ['maxMotorForce', 'maxMotorTorque'],
  ],
  [JOINT_TYPE.WELD]: [
    ['linearHertz', 'linearHertz'], ['angularHertz', 'angularHertz'],
    ['linearDampingRatio', 'linearDampingRatio'], ['angularDampingRatio', 'angularDampingRatio'],
  ],
};

function bindJointAccess(wide) {
  if (wide) {
    Joint.getEntityA = jointGetAWide;
    Joint.getEntityB = jointGetBWide;
    Joint.setPair = jointSetWide;
  } else {
    Joint.getEntityA = jointGetAPacked;
    Joint.getEntityB = jointGetBPacked;
    Joint.setPair = jointSetPacked;
  }
}

/**
 * Static class for distance / revolute / weld joints between entities.
 * Attachment points are body-local (localAnchor*). Default (0,0) = COM.
 */
export class Joint extends SharedAtomicPool {
  static INVALID_INDEX = 0xffff;

  static poolName = 'Joint';

  static TYPE = JOINT_TYPE;

  // Shared
  static type = null; // Uint8Array
  static pairs = null; // Uint32Array packed when width 16; null when width 32
  static entityA = null; // Uint32Array when width 32
  static entityB = null;
  static _widePairs = false;
  static localAnchorAX = null; // Float32Array
  static localAnchorAY = null;
  static localAnchorBX = null;
  static localAnchorBY = null;
  static active = null; // Uint8Array

  // Break thresholds (Box2D joint_configure). Infinity = never breaks.
  static forceThreshold = null; // Float32Array
  static torqueThreshold = null; // Float32Array

  // Distance
  static length = null; // Float32Array
  static enableSpring = null; // Uint8Array
  static hertz = null; // Float32Array
  static dampingRatio = null; // Float32Array

  // Revolute
  static enableLimit = null; // Uint8Array
  static lowerAngle = null; // Float32Array
  static upperAngle = null; // Float32Array
  static enableMotor = null; // Uint8Array
  static motorSpeed = null; // Float32Array
  static maxMotorTorque = null; // Float32Array

  // Weld
  static linearHertz = null; // Float32Array
  static angularHertz = null; // Float32Array
  static linearDampingRatio = null; // Float32Array
  static angularDampingRatio = null; // Float32Array

  // Dense active list
  static activeIndices = null; // Uint16Array
  static activeIndexPositions = null; // Uint16Array
  static activeMeta = null; // Int32Array[2]
  static activeCount = null; // Int32Array[1]
  static activeListLock = null; // Int32Array[1]
  static revision = null; // Uint32Array — bump on add/update/remove
  static nextA = null; // Uint16Array maxJoints — intrusive list
  static nextB = null;
  static head = null; // Uint16Array entityCount
  static _entityCount = 0;

  static getBufferSize(maxJoints, entityCount = 0) {
    return layJoints(null, null, maxJoints, entityCount | 0, entityIdBytes() === 4);
  }

  static initializeArrays(buffer, maxJoints, entityCount = 0) {
    this._widePairs = entityIdBytes() === 4;
    bindJointAccess(this._widePairs);
    this._entityCount = entityCount | 0;
    layJoints(this, buffer, maxJoints, this._entityCount, this._widePairs);

    this.active.fill(0);
    this.type.fill(0);
    this.forceThreshold.fill(Infinity);
    this.torqueThreshold.fill(Infinity);
    this.revision.fill(0);
    this.activeIndices.fill(this.INVALID_INDEX);
    this.activeIndexPositions.fill(this.INVALID_INDEX);
    this.nextA.fill(this.INVALID_INDEX);
    this.nextB.fill(this.INVALID_INDEX);
    if (this.head) this.head.fill(this.INVALID_INDEX);
    this.activeMeta[0] = 0;
    this.activeMeta[1] = 0;
  }

  static getEntityA(idx) {
    return jointGetAPacked(idx);
  }

  static getEntityB(idx) {
    return jointGetBPacked(idx);
  }

  static setPair(idx, entityA, entityB) {
    jointSetPacked(idx, entityA, entityB);
  }

  static bumpRevision(idx) {
    if (this.revision) Atomics.add(this.revision, idx, 1);
  }

  static _w2lA = { x: 0, y: 0 };
  static _w2lB = { x: 0, y: 0 };
  static _anchorsScratch = { ax: 0, ay: 0, bx: 0, by: 0 };

  static _worldToLocal(entity, wx, wy, out) {
    const x = Transform.x[entity];
    const y = Transform.y[entity];
    const c = Transform.rotC ? Transform.rotC[entity] : 1;
    const s = Transform.rotS ? Transform.rotS[entity] : 0;
    const dx = wx - x;
    const dy = wy - y;
    const dest = out || this._w2lA;
    dest.x = dx * c + dy * s;
    dest.y = -dx * s + dy * c;
    return dest;
  }

  static _resolveLocalAnchors(opts, entityA, entityB) {
    const dest = this._anchorsScratch;
    if (opts.worldAnchorX !== undefined && opts.worldAnchorY !== undefined) {
      const la = this._worldToLocal(entityA, opts.worldAnchorX, opts.worldAnchorY, this._w2lA);
      const lb = this._worldToLocal(entityB, opts.worldAnchorX, opts.worldAnchorY, this._w2lB);
      dest.ax = la.x;
      dest.ay = la.y;
      dest.bx = lb.x;
      dest.by = lb.y;
      return dest;
    }
    dest.ax = opts.localAnchorAX ?? 0;
    dest.ay = opts.localAnchorAY ?? 0;
    dest.bx = opts.localAnchorBX ?? 0;
    dest.by = opts.localAnchorBY ?? 0;
    return dest;
  }

  static _nextOnEntity(jointIdx, entity) {
    const a = this.getEntityA(jointIdx);
    return a === entity ? this.nextA[jointIdx] : this.nextB[jointIdx];
  }

  static _setNextOnEntity(jointIdx, entity, next) {
    const a = this.getEntityA(jointIdx);
    if (a === entity) this.nextA[jointIdx] = next;
    else this.nextB[jointIdx] = next;
  }

  static _linkPair(idx) {
    if (!this.head) return;
    const a = this.getEntityA(idx);
    const b = this.getEntityB(idx);
    const inv = this.INVALID_INDEX;
    if (a < this._entityCount) {
      this.nextA[idx] = this.head[a];
      this.head[a] = idx;
    } else {
      this.nextA[idx] = inv;
    }
    if (b < this._entityCount) {
      this.nextB[idx] = this.head[b];
      this.head[b] = idx;
    } else {
      this.nextB[idx] = inv;
    }
  }

  static _unlinkEntity(entity, jointIdx) {
    if (!this.head || entity < 0 || entity >= this._entityCount) return;
    const inv = this.INVALID_INDEX;
    let prev = inv;
    let cur = this.head[entity];
    while (cur !== inv) {
      const nxt = this._nextOnEntity(cur, entity);
      if (cur === jointIdx) {
        if (prev === inv) this.head[entity] = nxt;
        else this._setNextOnEntity(prev, entity, nxt);
        return;
      }
      prev = cur;
      cur = nxt;
    }
  }

  static _unlinkPair(idx) {
    if (!this.head) return;
    this._unlinkEntity(this.getEntityA(idx), idx);
    this._unlinkEntity(this.getEntityB(idx), idx);
  }

  static _activate(idx) {
    this.bumpRevision(idx);
    this.acquireSpinLock(this.activeListLock);
    try {
      const slot = this.activeCount ? Atomics.load(this.activeCount, 0) : 0;
      this.activeIndices[slot] = idx;
      this.activeIndexPositions[idx] = slot;
      this.active[idx] = 1;
      this._linkPair(idx);
      if (this.activeCount) {
        Atomics.store(this.activeCount, 0, slot + 1);
      }
    } finally {
      this.releaseSpinLock(this.activeListLock);
    }
  }

  static _acquireOrWarn() {
    const idx = this.acquireIndex();
    if (idx === -1) {
      reportJointPoolExhausted(this.type ? this.type.length : 0);
    }
    return idx;
  }

  /**
   * The start every add* shares: a slot (-1 when the pool is full), its type, pair, anchors and break thresholds.
   * @returns {number}
   */
  static _begin(opts, type) {
    const entityA = opts.entityA | 0;
    const entityB = opts.entityB | 0;
    const idx = this._acquireOrWarn();
    if (idx === -1) return -1;
    const anchors = this._resolveLocalAnchors(opts, entityA, entityB);
    this.type[idx] = type;
    this._setPairAndAnchors(idx, entityA, entityB, anchors);
    this.forceThreshold[idx] = opts.forceThreshold ?? Infinity;
    this.torqueThreshold[idx] = opts.torqueThreshold ?? Infinity;
    return idx;
  }

  static _setPairAndAnchors(idx, entityA, entityB, anchors) {
    this.setPair(idx, entityA, entityB);
    this.localAnchorAX[idx] = anchors.ax;
    this.localAnchorAY[idx] = anchors.ay;
    this.localAnchorBX[idx] = anchors.bx;
    this.localAnchorBY[idx] = anchors.by;
  }

  /**
   * Distance joint between two entities. Returns pool index, or -1 if exhausted.
   * @param {{entityA:number, entityB:number, length?:number, enableSpring?:boolean, hertz?:number, dampingRatio?:number, forceThreshold?:number, torqueThreshold?:number, ax?:number, ay?:number, bx?:number, by?:number}} [opts]
   * @returns {number}
   */
  static addDistance(opts = {}) {
    const idx = this._begin(opts, JOINT_TYPE.DISTANCE);
    if (idx === -1) return -1;
    this.length[idx] = opts.length ?? 0;
    this.enableSpring[idx] = opts.enableSpring ? 1 : 0;
    this.hertz[idx] = opts.hertz ?? 1;
    this.dampingRatio[idx] = opts.dampingRatio ?? 0.7;
    this._activate(idx);
    return idx;
  }

  /**
   * Revolute (hinge) joint. Returns pool index, or -1 if exhausted.
   * @param {{entityA:number, entityB:number, enableLimit?:boolean, lowerAngle?:number, upperAngle?:number, enableMotor?:boolean, motorSpeed?:number, maxMotorTorque?:number, forceThreshold?:number, torqueThreshold?:number}} [opts]
   * @returns {number}
   */
  static addRevolute(opts = {}) {
    const idx = this._begin(opts, JOINT_TYPE.REVOLUTE);
    if (idx === -1) return -1;
    this.enableLimit[idx] = opts.enableLimit ? 1 : 0;
    this.lowerAngle[idx] = opts.lowerAngle ?? 0;
    this.upperAngle[idx] = opts.upperAngle ?? 0;
    this.enableMotor[idx] = opts.enableMotor ? 1 : 0;
    this.motorSpeed[idx] = opts.motorSpeed ?? 0;
    this.maxMotorTorque[idx] = opts.maxMotorTorque ?? 0;
    this._activate(idx);
    return idx;
  }

  /**
   * Weld (rigid) joint. Returns pool index, or -1 if exhausted.
   * @param {{entityA:number, entityB:number, linearHertz?:number, angularHertz?:number, linearDampingRatio?:number, angularDampingRatio?:number, forceThreshold?:number, torqueThreshold?:number}} [opts]
   * @returns {number}
   */
  static addWeld(opts = {}) {
    const idx = this._begin(opts, JOINT_TYPE.WELD);
    if (idx === -1) return -1;
    this.linearHertz[idx] = opts.linearHertz ?? 0;
    this.angularHertz[idx] = opts.angularHertz ?? 0;
    this.linearDampingRatio[idx] = opts.linearDampingRatio ?? 1;
    this.angularDampingRatio[idx] = opts.angularDampingRatio ?? 1;
    this._activate(idx);
    return idx;
  }

  /**
   * Prismatic (slider) joint. No spin: motion is along axisAngle (radians, body-local).
   * Limits and the motor reuse the revolute columns. axisAngle reuses the weld
   * linearHertz column so the joint SAB does not grow.
   * @param {{entityA:number, entityB:number, axisAngle?:number, enableLimit?:boolean, lowerTranslation?:number, upperTranslation?:number, enableMotor?:boolean, motorSpeed?:number, maxMotorForce?:number, forceThreshold?:number, torqueThreshold?:number}} [opts]
   * @returns {number}
   */
  static addPrismatic(opts = {}) {
    const idx = this._begin(opts, JOINT_TYPE.PRISMATIC);
    if (idx === -1) return -1;
    this.enableLimit[idx] = opts.enableLimit ? 1 : 0;
    this.lowerAngle[idx] = opts.lowerTranslation ?? 0;
    this.upperAngle[idx] = opts.upperTranslation ?? 0;
    this.enableMotor[idx] = opts.enableMotor ? 1 : 0;
    this.motorSpeed[idx] = opts.motorSpeed ?? 0;
    this.maxMotorTorque[idx] = opts.maxMotorForce ?? opts.maxMotorTorque ?? 0;
    this.linearHertz[idx] = opts.axisAngle ?? 0;
    this._activate(idx);
    return idx;
  }

  /**
   * Return a joint slot to the pool.
   * @param {number} idx
   */
  static remove(idx) {
    if (idx < 0 || idx >= this.maxCount) return;
    if (!this.active[idx]) return;

    this.acquireSpinLock(this.activeListLock);
    try {
      if (!this.active[idx]) return;

      const count = this.activeCount ? Atomics.load(this.activeCount, 0) : 0;
      const slot = this.activeIndexPositions[idx];
      const lastSlot = count - 1;

      this._unlinkPair(idx);
      this.active[idx] = 0;

      if (slot !== this.INVALID_INDEX && lastSlot >= 0) {
        const lastIdx = this.activeIndices[lastSlot];
        if (slot !== lastSlot) {
          this.activeIndices[slot] = lastIdx;
          this.activeIndexPositions[lastIdx] = slot;
        }
        this.activeIndices[lastSlot] = this.INVALID_INDEX;
        this.activeIndexPositions[idx] = this.INVALID_INDEX;
        if (this.activeCount) {
          Atomics.store(this.activeCount, 0, lastSlot);
        }
      }
    } finally {
      this.releaseSpinLock(this.activeListLock);
    }

    this.bumpRevision(idx);
    this.returnToPool(idx);
  }

  static getEntities(idx) {
    return {
      entityA: this.getEntityA(idx),
      entityB: this.getEntityB(idx),
    };
  }

  static update(idx, props = {}) {
    if (idx < 0 || idx >= this.maxCount || !this.active[idx]) return;
    const byType = UPDATE_PROPS[this.type[idx]];
    let changed = this._applyProps(idx, props, ANCHOR_PROPS);
    if (byType !== undefined && this._applyProps(idx, props, byType)) changed = true;
    if (changed) this.bumpRevision(idx);
  }

  /** The props a table names, each into its column; true when any was given. */
  static _applyProps(idx, props, table) {
    let changed = false;
    for (const [key, column, flag] of table) {
      const v = props[key];
      if (v === undefined) continue;
      this[column][idx] = flag === true ? (v ? 1 : 0) : v;
      changed = true;
    }
    return changed;
  }

  static isActive(idx) {
    return idx >= 0 && idx < this.maxCount && this.active[idx] === 1;
  }

  /**
   * Remove every joint attached to an entity.
   * @param {number} entityIdx
   */
  static removeAllForEntity(entityIdx) {
    if (this.head && entityIdx >= 0 && entityIdx < this._entityCount) {
      const inv = this.INVALID_INDEX;
      let cur = this.head[entityIdx];
      while (cur !== inv) {
        const a = this.getEntityA(cur);
        const nxt = a === entityIdx ? this.nextA[cur] : this.nextB[cur];
        this.remove(cur);
        cur = nxt;
      }
      return;
    }
    const activeCount = this.getDenseActiveCount();
    for (let slot = activeCount - 1; slot >= 0; slot--) {
      const idx = this.activeIndices[slot];
      if (idx === this.INVALID_INDEX || !this.active[idx]) continue;
      const a = this.getEntityA(idx);
      const b = this.getEntityB(idx);
      if (a === entityIdx || b === entityIdx) {
        this.remove(idx);
      }
    }
  }

  static hasBetween(entityA, entityB) {
    const a = entityA | 0;
    const b = entityB | 0;
    if (a === b || !this.head || a < 0 || a >= this._entityCount) return false;
    const inv = this.INVALID_INDEX;
    let cur = this.head[a];
    while (cur !== inv) {
      const ea = this.getEntityA(cur);
      const eb = this.getEntityB(cur);
      if ((ea === a && eb === b) || (ea === b && eb === a)) return true;
      cur = ea === a ? this.nextA[cur] : this.nextB[cur];
    }
    return false;
  }

  static getJointCount(entityIdx) {
    // Not `entityIdx < 0`: undefined and fractions pass it and the walk never ends (N-100).
    if (!this.head || entityIdx >>> 0 !== entityIdx || entityIdx >= this._entityCount) return 0;
    const inv = this.INVALID_INDEX;
    let n = 0;
    let cur = this.head[entityIdx];
    while (cur !== inv) {
      n++;
      const a = this.getEntityA(cur);
      cur = a === entityIdx ? this.nextA[cur] : this.nextB[cur];
    }
    return n;
  }

  static getJoint(entityIdx, i) {
    if (!this.head || i < 0 || entityIdx >>> 0 !== entityIdx || entityIdx >= this._entityCount) {
      return -1;
    }
    const inv = this.INVALID_INDEX;
    let cur = this.head[entityIdx];
    let k = 0;
    while (cur !== inv) {
      if (k === i) return cur;
      k++;
      const a = this.getEntityA(cur);
      cur = a === entityIdx ? this.nextA[cur] : this.nextB[cur];
    }
    return -1;
  }

  static forEachOnEntity(entityIdx, fn) {
    if (!this.head || entityIdx >>> 0 !== entityIdx || entityIdx >= this._entityCount) return;
    const inv = this.INVALID_INDEX;
    let cur = this.head[entityIdx];
    while (cur !== inv) {
      const ea = this.getEntityA(cur);
      const eb = this.getEntityB(cur);
      const other = ea === entityIdx ? eb : ea;
      const nxt = ea === entityIdx ? this.nextA[cur] : this.nextB[cur];
      fn(cur, other);
      cur = nxt;
    }
  }

  static getDenseActiveCount() {
    if (!this.activeCount) return 0;
    return Atomics.load(this.activeCount, 0);
  }

  static getAllActive() {
    const result = [];
    const activeCount = this.getDenseActiveCount();
    for (let slot = 0; slot < activeCount; slot++) {
      const idx = this.activeIndices[slot];
      if (idx === this.INVALID_INDEX || !this.active[idx]) continue;
      result.push({
        idx,
        type: this.type[idx],
        entityA: this.getEntityA(idx),
        entityB: this.getEntityB(idx),
        localAnchorAX: this.localAnchorAX[idx],
        localAnchorAY: this.localAnchorAY[idx],
        localAnchorBX: this.localAnchorBX[idx],
        localAnchorBY: this.localAnchorBY[idx],
        length: this.length[idx],
      });
    }
    return result;
  }

  /**
   * Full SoA dump of every dense-active joint for save games.
   * Prefer local anchors; do not re-resolve from world.
   * @returns {object[]}
   */
  static serializeActive() {
    const result = [];
    if (!this.activeIndices || !this.active) return result;
    const activeCount = this.getDenseActiveCount();
    for (let slot = 0; slot < activeCount; slot++) {
      const idx = this.activeIndices[slot];
      if (idx === this.INVALID_INDEX || !this.active[idx]) continue;
      const type = this.type[idx];
      const rec = {
        type,
        entityA: this.getEntityA(idx),
        entityB: this.getEntityB(idx),
        localAnchorAX: this.localAnchorAX[idx],
        localAnchorAY: this.localAnchorAY[idx],
        localAnchorBX: this.localAnchorBX[idx],
        localAnchorBY: this.localAnchorBY[idx],
        forceThreshold: this.forceThreshold[idx],
        torqueThreshold: this.torqueThreshold[idx],
      };
      if (type === JOINT_TYPE.DISTANCE) {
        rec.length = this.length[idx];
        rec.enableSpring = this.enableSpring[idx] ? 1 : 0;
        rec.hertz = this.hertz[idx];
        rec.dampingRatio = this.dampingRatio[idx];
      } else if (type === JOINT_TYPE.REVOLUTE) {
        rec.enableLimit = this.enableLimit[idx] ? 1 : 0;
        rec.lowerAngle = this.lowerAngle[idx];
        rec.upperAngle = this.upperAngle[idx];
        rec.enableMotor = this.enableMotor[idx] ? 1 : 0;
        rec.motorSpeed = this.motorSpeed[idx];
        rec.maxMotorTorque = this.maxMotorTorque[idx];
      } else if (type === JOINT_TYPE.PRISMATIC) {
        rec.axisAngle = this.linearHertz[idx];
        rec.enableLimit = this.enableLimit[idx] ? 1 : 0;
        rec.lowerTranslation = this.lowerAngle[idx];
        rec.upperTranslation = this.upperAngle[idx];
        rec.enableMotor = this.enableMotor[idx] ? 1 : 0;
        rec.motorSpeed = this.motorSpeed[idx];
        rec.maxMotorForce = this.maxMotorTorque[idx];
      } else if (type === JOINT_TYPE.WELD) {
        rec.linearHertz = this.linearHertz[idx];
        rec.angularHertz = this.angularHertz[idx];
        rec.linearDampingRatio = this.linearDampingRatio[idx];
        rec.angularDampingRatio = this.angularDampingRatio[idx];
      }
      result.push(rec);
    }
    return result;
  }

  /** Remove every active joint (pool return). */
  static clearAllActive() {
    if (!this.activeIndices || !this.active) return;
    for (let slot = this.getDenseActiveCount() - 1; slot >= 0; slot--) {
      const idx = this.activeIndices[slot];
      if (idx === this.INVALID_INDEX || !this.active[idx]) continue;
      this.remove(idx);
    }
  }

  /**
   * Recreate joints from save records after entity index remap.
   * @param {object[]} records
   * @param {Map<number, number>|Record<number, number>} oldToNew
   * @returns {number[]} new joint indices
   */
  static restoreFromSave(records, oldToNew) {
    const created = [];
    if (!records || !records.length) return created;
    const mapGet = (old) => {
      if (oldToNew == null) return old | 0;
      if (typeof oldToNew.get === 'function') {
        return oldToNew.has(old) ? oldToNew.get(old) : old | 0;
      }
      return oldToNew[old] !== undefined ? oldToNew[old] : old | 0;
    };

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const entityA = mapGet(rec.entityA | 0);
      const entityB = mapGet(rec.entityB | 0);
      if (entityA < 0 || entityB < 0) continue;

      const opts = {
        entityA,
        entityB,
        localAnchorAX: rec.localAnchorAX ?? 0,
        localAnchorAY: rec.localAnchorAY ?? 0,
        localAnchorBX: rec.localAnchorBX ?? 0,
        localAnchorBY: rec.localAnchorBY ?? 0,
        forceThreshold: rec.forceThreshold ?? Infinity,
        torqueThreshold: rec.torqueThreshold ?? Infinity,
      };

      let idx = -1;
      const t = rec.type | 0;
      if (t === JOINT_TYPE.DISTANCE) {
        idx = this.addDistance({
          ...opts,
          length: rec.length ?? 0,
          enableSpring: !!rec.enableSpring,
          hertz: rec.hertz ?? 1,
          dampingRatio: rec.dampingRatio ?? 0.7,
        });
      } else if (t === JOINT_TYPE.REVOLUTE) {
        idx = this.addRevolute({
          ...opts,
          enableLimit: !!rec.enableLimit,
          lowerAngle: rec.lowerAngle ?? 0,
          upperAngle: rec.upperAngle ?? 0,
          enableMotor: !!rec.enableMotor,
          motorSpeed: rec.motorSpeed ?? 0,
          maxMotorTorque: rec.maxMotorTorque ?? 0,
        });
      } else if (t === JOINT_TYPE.PRISMATIC) {
        idx = this.addPrismatic({
          ...opts,
          axisAngle: rec.axisAngle ?? 0,
          enableLimit: !!rec.enableLimit,
          lowerTranslation: rec.lowerTranslation ?? 0,
          upperTranslation: rec.upperTranslation ?? 0,
          enableMotor: !!rec.enableMotor,
          motorSpeed: rec.motorSpeed ?? 0,
          maxMotorForce: rec.maxMotorForce ?? 0,
        });
      } else if (t === JOINT_TYPE.WELD) {
        idx = this.addWeld({
          ...opts,
          linearHertz: rec.linearHertz ?? 0,
          angularHertz: rec.angularHertz ?? 0,
          linearDampingRatio: rec.linearDampingRatio ?? 1,
          angularDampingRatio: rec.angularDampingRatio ?? 1,
        });
      }
      if (idx >= 0) created.push(idx);
    }
    return created;
  }

  static reset() {
    super.reset();
    for (const [name] of JOINT_LAYOUT) {
      if (typeof name === 'string') this[name] = null;
    }
    this.pairs = null;
    this.entityA = null;
    this.entityB = null;
    this._widePairs = false;
    bindJointAccess(false);
    this.activeMeta = null;
    this.activeCount = null;
    this.activeListLock = null;
    this.head = null;
    this._entityCount = 0;
  }
}
