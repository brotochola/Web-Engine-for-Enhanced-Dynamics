// Joint.js - Box2D-mapped joint pool (distance / revolute / weld)
// Thread-safe pool backed by SharedArrayBuffer; syncs to WASM in weedjs_post.
// Extends SharedAtomicPool for atomic free list operations.

import { SharedAtomicPool } from './SharedAtomicPool.js';
import { Transform } from '../components/Transform.js';
import { JOINT_TYPE } from '../box2d/box2dConstants.js';

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
  static pairs = null; // Uint32Array (entityA << 16) | entityB
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
    // Mirror initializeArrays offsets
    let offset = 0;
    const n = maxJoints;
    const e = entityCount | 0;
    const align4 = (o) => Math.ceil(o / 4) * 4;
    offset = align4(offset + n); // type
    offset += n * 4; // pairs
    offset += n * 4 * 4; // localAnchors
    offset += n * 4; // forceThreshold
    offset += n * 4; // torqueThreshold
    offset = align4(offset + n); // active
    offset += n * 4; // length
    offset = align4(offset + n); // enableSpring
    offset += n * 4; // hertz
    offset += n * 4; // dampingRatio
    offset = align4(offset + n); // enableLimit
    offset += n * 4; // lowerAngle
    offset += n * 4; // upperAngle
    offset = align4(offset + n); // enableMotor
    offset += n * 4; // motorSpeed
    offset += n * 4; // maxMotorTorque
    offset += n * 4 * 4; // weld floats
    offset += n * 2; // activeIndices
    offset += n * 2; // activeIndexPositions
    offset += 8; // activeMeta
    offset += n * 4; // revision
    offset = align4(offset);
    offset += n * 2; // nextA
    offset += n * 2; // nextB
    offset = align4(offset);
    offset += e * 2; // head
    offset = align4(offset);
    return offset;
  }

  static initializeArrays(buffer, maxJoints, entityCount = 0) {
    let offset = 0;
    const n = maxJoints;
    const align4 = (o) => Math.ceil(o / 4) * 4;

    this.type = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);

    this.pairs = new Uint32Array(buffer, offset, n);
    offset += n * 4;

    this.localAnchorAX = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.localAnchorAY = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.localAnchorBX = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.localAnchorBY = new Float32Array(buffer, offset, n);
    offset += n * 4;

    this.forceThreshold = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.torqueThreshold = new Float32Array(buffer, offset, n);
    offset += n * 4;

    this.active = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);

    this.length = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.enableSpring = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    this.hertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.dampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;

    this.enableLimit = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    this.lowerAngle = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.upperAngle = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.enableMotor = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    this.motorSpeed = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.maxMotorTorque = new Float32Array(buffer, offset, n);
    offset += n * 4;

    this.linearHertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.angularHertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.linearDampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;
    this.angularDampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;

    this.activeIndices = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    this.activeIndexPositions = new Uint16Array(buffer, offset, n);
    offset += n * 2;

    this.activeMeta = new Int32Array(buffer, offset, 2);
    this.activeCount = new Int32Array(buffer, offset, 1);
    this.activeListLock = new Int32Array(buffer, offset + 4, 1);
    offset += 8;

    this.revision = new Uint32Array(buffer, offset, n);
    offset += n * 4;
    offset = align4(offset);

    this.nextA = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    this.nextB = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    offset = align4(offset);

    this._entityCount = entityCount | 0;
    this.head =
      this._entityCount > 0
        ? new Uint16Array(buffer, offset, this._entityCount)
        : null;
    offset += this._entityCount * 2;
    offset = align4(offset);

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

  static bumpRevision(idx) {
    if (this.revision) Atomics.add(this.revision, idx, 1);
  }

  static _worldToLocal(entity, wx, wy) {
    const x = Transform.x[entity];
    const y = Transform.y[entity];
    const c = Transform.rotC ? Transform.rotC[entity] : 1;
    const s = Transform.rotS ? Transform.rotS[entity] : 0;
    const dx = wx - x;
    const dy = wy - y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  static _resolveLocalAnchors(opts, entityA, entityB) {
    if (opts.worldAnchorX !== undefined && opts.worldAnchorY !== undefined) {
      const la = this._worldToLocal(entityA, opts.worldAnchorX, opts.worldAnchorY);
      const lb = this._worldToLocal(entityB, opts.worldAnchorX, opts.worldAnchorY);
      return { ax: la.x, ay: la.y, bx: lb.x, by: lb.y };
    }
    return {
      ax: opts.localAnchorAX ?? 0,
      ay: opts.localAnchorAY ?? 0,
      bx: opts.localAnchorBX ?? 0,
      by: opts.localAnchorBY ?? 0,
    };
  }

  static _nextOnEntity(jointIdx, entity) {
    const a = this.pairs[jointIdx] >>> 16;
    return a === entity ? this.nextA[jointIdx] : this.nextB[jointIdx];
  }

  static _setNextOnEntity(jointIdx, entity, next) {
    const a = this.pairs[jointIdx] >>> 16;
    if (a === entity) this.nextA[jointIdx] = next;
    else this.nextB[jointIdx] = next;
  }

  static _linkPair(idx) {
    if (!this.head) return;
    const packed = this.pairs[idx];
    const a = packed >>> 16;
    const b = packed & 0xffff;
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
    const packed = this.pairs[idx];
    this._unlinkEntity(packed >>> 16, idx);
    this._unlinkEntity(packed & 0xffff, idx);
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
      console.warn('Joint: Pool exhausted');
    }
    return idx;
  }

  static _setPairAndAnchors(idx, entityA, entityB, anchors) {
    this.pairs[idx] = (entityA << 16) | (entityB & 0xffff);
    this.localAnchorAX[idx] = anchors.ax;
    this.localAnchorAY[idx] = anchors.ay;
    this.localAnchorBX[idx] = anchors.bx;
    this.localAnchorBY[idx] = anchors.by;
  }

  static addDistance(opts = {}) {
    const entityA = opts.entityA | 0;
    const entityB = opts.entityB | 0;
    const idx = this._acquireOrWarn();
    if (idx === -1) return -1;

    const anchors = this._resolveLocalAnchors(opts, entityA, entityB);
    this.type[idx] = JOINT_TYPE.DISTANCE;
    this._setPairAndAnchors(idx, entityA, entityB, anchors);
    this.forceThreshold[idx] = opts.forceThreshold ?? Infinity;
    this.torqueThreshold[idx] = opts.torqueThreshold ?? Infinity;
    this.length[idx] = opts.length ?? 0;
    this.enableSpring[idx] = opts.enableSpring ? 1 : 0;
    this.hertz[idx] = opts.hertz ?? 1;
    this.dampingRatio[idx] = opts.dampingRatio ?? 0.7;
    this._activate(idx);
    return idx;
  }

  static addRevolute(opts = {}) {
    const entityA = opts.entityA | 0;
    const entityB = opts.entityB | 0;
    const idx = this._acquireOrWarn();
    if (idx === -1) return -1;

    const anchors = this._resolveLocalAnchors(opts, entityA, entityB);
    this.type[idx] = JOINT_TYPE.REVOLUTE;
    this._setPairAndAnchors(idx, entityA, entityB, anchors);
    this.forceThreshold[idx] = opts.forceThreshold ?? Infinity;
    this.torqueThreshold[idx] = opts.torqueThreshold ?? Infinity;
    this.enableLimit[idx] = opts.enableLimit ? 1 : 0;
    this.lowerAngle[idx] = opts.lowerAngle ?? 0;
    this.upperAngle[idx] = opts.upperAngle ?? 0;
    this.enableMotor[idx] = opts.enableMotor ? 1 : 0;
    this.motorSpeed[idx] = opts.motorSpeed ?? 0;
    this.maxMotorTorque[idx] = opts.maxMotorTorque ?? 0;
    this._activate(idx);
    return idx;
  }

  static addWeld(opts = {}) {
    const entityA = opts.entityA | 0;
    const entityB = opts.entityB | 0;
    const idx = this._acquireOrWarn();
    if (idx === -1) return -1;

    const anchors = this._resolveLocalAnchors(opts, entityA, entityB);
    this.type[idx] = JOINT_TYPE.WELD;
    this._setPairAndAnchors(idx, entityA, entityB, anchors);
    this.forceThreshold[idx] = opts.forceThreshold ?? Infinity;
    this.torqueThreshold[idx] = opts.torqueThreshold ?? Infinity;
    this.linearHertz[idx] = opts.linearHertz ?? 0;
    this.angularHertz[idx] = opts.angularHertz ?? 0;
    this.linearDampingRatio[idx] = opts.linearDampingRatio ?? 1;
    this.angularDampingRatio[idx] = opts.angularDampingRatio ?? 1;
    this._activate(idx);
    return idx;
  }

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
    const packed = this.pairs[idx];
    return {
      entityA: packed >>> 16,
      entityB: packed & 0xffff,
    };
  }

  static update(idx, props = {}) {
    if (idx < 0 || idx >= this.maxCount || !this.active[idx]) return;
    const t = this.type[idx];
    let changed = false;

    if (props.localAnchorAX !== undefined) {
      this.localAnchorAX[idx] = props.localAnchorAX;
      changed = true;
    }
    if (props.localAnchorAY !== undefined) {
      this.localAnchorAY[idx] = props.localAnchorAY;
      changed = true;
    }
    if (props.localAnchorBX !== undefined) {
      this.localAnchorBX[idx] = props.localAnchorBX;
      changed = true;
    }
    if (props.localAnchorBY !== undefined) {
      this.localAnchorBY[idx] = props.localAnchorBY;
      changed = true;
    }

    if (t === JOINT_TYPE.DISTANCE) {
      if (props.length !== undefined) {
        this.length[idx] = props.length;
        changed = true;
      }
      if (props.enableSpring !== undefined) {
        this.enableSpring[idx] = props.enableSpring ? 1 : 0;
        changed = true;
      }
      if (props.hertz !== undefined) {
        this.hertz[idx] = props.hertz;
        changed = true;
      }
      if (props.dampingRatio !== undefined) {
        this.dampingRatio[idx] = props.dampingRatio;
        changed = true;
      }
    } else if (t === JOINT_TYPE.REVOLUTE) {
      if (props.enableLimit !== undefined) {
        this.enableLimit[idx] = props.enableLimit ? 1 : 0;
        changed = true;
      }
      if (props.lowerAngle !== undefined) {
        this.lowerAngle[idx] = props.lowerAngle;
        changed = true;
      }
      if (props.upperAngle !== undefined) {
        this.upperAngle[idx] = props.upperAngle;
        changed = true;
      }
      if (props.enableMotor !== undefined) {
        this.enableMotor[idx] = props.enableMotor ? 1 : 0;
        changed = true;
      }
      if (props.motorSpeed !== undefined) {
        this.motorSpeed[idx] = props.motorSpeed;
        changed = true;
      }
      if (props.maxMotorTorque !== undefined) {
        this.maxMotorTorque[idx] = props.maxMotorTorque;
        changed = true;
      }
    } else if (t === JOINT_TYPE.WELD) {
      if (props.linearHertz !== undefined) {
        this.linearHertz[idx] = props.linearHertz;
        changed = true;
      }
      if (props.angularHertz !== undefined) {
        this.angularHertz[idx] = props.angularHertz;
        changed = true;
      }
      if (props.linearDampingRatio !== undefined) {
        this.linearDampingRatio[idx] = props.linearDampingRatio;
        changed = true;
      }
      if (props.angularDampingRatio !== undefined) {
        this.angularDampingRatio[idx] = props.angularDampingRatio;
        changed = true;
      }
    }
    if (changed) this.bumpRevision(idx);
  }

  static isActive(idx) {
    return idx >= 0 && idx < this.maxCount && this.active[idx] === 1;
  }

  static removeAllForEntity(entityIdx) {
    if (this.head && entityIdx >= 0 && entityIdx < this._entityCount) {
      const inv = this.INVALID_INDEX;
      let cur = this.head[entityIdx];
      while (cur !== inv) {
        const packed = this.pairs[cur];
        const a = packed >>> 16;
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
      const packed = this.pairs[idx];
      const a = packed >>> 16;
      const b = packed & 0xffff;
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
      const packed = this.pairs[cur];
      const ea = packed >>> 16;
      const eb = packed & 0xffff;
      if ((ea === a && eb === b) || (ea === b && eb === a)) return true;
      cur = ea === a ? this.nextA[cur] : this.nextB[cur];
    }
    return false;
  }

  static getJointCount(entityIdx) {
    if (!this.head || entityIdx < 0 || entityIdx >= this._entityCount) return 0;
    const inv = this.INVALID_INDEX;
    let n = 0;
    let cur = this.head[entityIdx];
    while (cur !== inv) {
      n++;
      const a = this.pairs[cur] >>> 16;
      cur = a === entityIdx ? this.nextA[cur] : this.nextB[cur];
    }
    return n;
  }

  static getJoint(entityIdx, i) {
    if (!this.head || i < 0 || entityIdx < 0 || entityIdx >= this._entityCount) {
      return -1;
    }
    const inv = this.INVALID_INDEX;
    let cur = this.head[entityIdx];
    let k = 0;
    while (cur !== inv) {
      if (k === i) return cur;
      k++;
      const a = this.pairs[cur] >>> 16;
      cur = a === entityIdx ? this.nextA[cur] : this.nextB[cur];
    }
    return -1;
  }

  static forEachOnEntity(entityIdx, fn) {
    if (!this.head || entityIdx < 0 || entityIdx >= this._entityCount) return;
    const inv = this.INVALID_INDEX;
    let cur = this.head[entityIdx];
    while (cur !== inv) {
      const packed = this.pairs[cur];
      const ea = packed >>> 16;
      const eb = packed & 0xffff;
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
      const packed = this.pairs[idx];
      result.push({
        idx,
        type: this.type[idx],
        entityA: packed >>> 16,
        entityB: packed & 0xffff,
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
      const packed = this.pairs[idx];
      const type = this.type[idx];
      const rec = {
        type,
        entityA: packed >>> 16,
        entityB: packed & 0xffff,
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
    this.type = null;
    this.pairs = null;
    this.localAnchorAX = null;
    this.localAnchorAY = null;
    this.localAnchorBX = null;
    this.localAnchorBY = null;
    this.forceThreshold = null;
    this.torqueThreshold = null;
    this.active = null;
    this.length = null;
    this.enableSpring = null;
    this.hertz = null;
    this.dampingRatio = null;
    this.enableLimit = null;
    this.lowerAngle = null;
    this.upperAngle = null;
    this.enableMotor = null;
    this.motorSpeed = null;
    this.maxMotorTorque = null;
    this.linearHertz = null;
    this.angularHertz = null;
    this.linearDampingRatio = null;
    this.angularDampingRatio = null;
    this.activeIndices = null;
    this.activeIndexPositions = null;
    this.activeMeta = null;
    this.activeCount = null;
    this.activeListLock = null;
    this.revision = null;
    this.nextA = null;
    this.nextB = null;
    this.head = null;
    this._entityCount = 0;
  }
}
