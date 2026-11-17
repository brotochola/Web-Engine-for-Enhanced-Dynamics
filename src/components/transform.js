// Transform.js - Entity state SoA + pose views
// SoA: active / entityType / isItOnScreen, and DX-PARENT's link columns (parent, localX, localY, localRotation)
// Pose (x/y/rotation/rotC/rotS): Box2D HEAP after box2dReady, or a Weed SAB when
// config.physics.enabled === false (bindWeedPoseFields at init). Same Float32Array
// views either way — hot loops read Transform.x[i], no architecture branch.
//
// DX-PARENT (Transform.parent): an entity follows another, as a car's lights follow the car. The physics worker is the
// one writer of a linked child's pose: right after its step and before it publishes the pose, it puts each child at
// parent.xy + rotate(parent.rotation, local.xy), turned by parent.rotation + localRotation. After the columns,
// Transform's block holds the link region (linkRegionLayout): LINK_WORDS words, each entity's parent generation, the
// child list physics publishes for pre-render and the orphan ring logic0 drains. src/box2d/physicsHostImpl.js binds the
// same layout by hand (its transform-links block; tests/node/transformParent.test.js compares the two).

import { Component } from '../core/component.js';
import { EntityIdArray, entityIdNone } from '../util/entityIdWidth.js';

/** Transform.active while the despawn that claimed the slot runs (GameObject.despawn): neither alive nor free. */
export const ACTIVE_DESPAWNING = 2;

// The link region's words (Int32).
/** Logic moves it (Atomics.add) at every link change; physics rebuilds its child list when it moved. */
export const LINK_VERSION = 0;
/** Live links (logic, Atomics.add and Atomics.sub): 0 = no entity follows another. */
export const LINK_COUNT = 1;
/** The published child list's seqlock (physics): odd while physics writes the list. */
export const LINK_LIST_SEQ = 2;
/** Entries in the published child list (physics). */
export const LINK_LIST_COUNT = 3;
/** Orphans physics queued, ever (its cursor, Int32 arithmetic). */
export const LINK_ORPHAN_HEAD = 4;
/** Orphans logic0 took, ever (its cursor). */
export const LINK_ORPHAN_TAIL = 5;
export const LINK_WORDS = 8;
/** The orphan ring's entries (a power of two). More orphans in one step wait for the next one. */
export const LINK_ORPHAN_CAP = 1024;

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;

/** n rounded up to a multiple of 8. */
function align8(n) {
  return (n + 7) & ~7;
}

/**
 * The link region's parts for `count` entities, in bytes from the region's start (which is 8-aligned, after the
 * columns): the words, each entity's parent generation (Int32), the published child list (Int32) and the orphan ring
 * (Int32, LINK_ORPHAN_CAP).
 * @param {number} count
 */
export function linkRegionLayout(count) {
  const n = count | 0;
  const parentGen = LINK_WORDS * 4;
  const list = parentGen + n * 4;
  const orphans = list + n * 4;
  return { parentGen, list, orphans, bytes: orphans + LINK_ORPHAN_CAP * 4 };
}

/** Whether entity i follows a parent. An unbound Transform (empty columns) reads no. */
export function hasParent(i) {
  return Transform.parent[i] < entityIdNone;
}

export class Transform extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = inactive, 1 = active, ACTIVE_DESPAWNING while its despawn runs
    entityType: Uint8Array, // Entity type ID (auto-assigned during registration)
    isItOnScreen: Uint8Array, // Canonical entity screen visibility, published by pre_render_worker
    // DX-PARENT: the entity this one follows (entityIdNone: none; a saved game remaps it), and where it sits in its
    // parent's frame. Logic writes them; physics reads them after each step.
    parent: { type: Uint16Array, entityId: true }, // rebound to EntityIdArray() with the scene's id width
    localX: Float32Array,
    localY: Float32Array,
    localRotation: Float32Array,
  };

  // DX-PARENT. Unbound (a realm that never bound Transform, or after clearArrays): empty columns, which read as "no
  // parent" (hasParent), and words that read as "no link".
  static parent = new Uint16Array(0);
  static localX = new Float32Array(0);
  static localY = new Float32Array(0);
  static localRotation = new Float32Array(0);
  /** The link region's words (LINK_*). */
  static links = new Int32Array(LINK_WORDS);
  /** Each child's parent body generation when it was linked (logic writes it; physics compares). */
  static parentGen = new Int32Array(0);
  /** The child list physics publishes (LINK_LIST_COUNT entries, under LINK_LIST_SEQ), which pre-render composes. */
  static childList = new Int32Array(0);
  /** Children physics found orphaned (their parent despawned), for logic0 to despawn (LINK_ORPHAN_HEAD / TAIL). */
  static orphans = new Int32Array(LINK_ORPHAN_CAP);
  /**
   * What `transform.parent = …` runs: (childIndex, entity | index | null). GameObject sets it (what may link, the
   * warnings that name the class); unset, the setter does nothing.
   */
  static _linkPolicy = null;
  /** What a pose write to a child runs instead of writing (index): GameObject's warning. */
  static _poseWriteIgnored = null;

  /** The parent column takes the scene's entity id width (16 or 32 bits), as DecorationComponent's does. */
  static _bindParentWidth() {
    const type = EntityIdArray();
    if (Transform.ARRAY_SCHEMA.parent.type !== type) Transform.ARRAY_SCHEMA.parent = { type, entityId: true };
  }

  static getBufferSize(count) {
    Transform._bindParentWidth();
    return align8(super.getBufferSize(count)) + linkRegionLayout(count).bytes;
  }

  static initializeArrays(buffer, count, byteOffset = 0) {
    Transform._bindParentWidth();
    super.initializeArrays(buffer, count, byteOffset);
    // A fresh buffer is zeros, and 0 is an entity.
    Transform.parent.fill(entityIdNone);
    // byteOffset is a multiple of 8, so the columns lie as they do from 0 and the region starts 8-aligned.
    const at = byteOffset + align8(super.getBufferSize(count));
    const layout = linkRegionLayout(count);
    Transform.links = new Int32Array(buffer, at, LINK_WORDS);
    Transform.parentGen = new Int32Array(buffer, at + layout.parentGen, count);
    Transform.childList = new Int32Array(buffer, at + layout.list, count);
    Transform.orphans = new Int32Array(buffer, at + layout.orphans, LINK_ORPHAN_CAP);
  }

  static clearArrays() {
    super.clearArrays();
    Transform.x = null;
    Transform.y = null;
    Transform.rotation = null;
    Transform.rotC = null;
    Transform.rotS = null;
    Transform.parent = new Uint16Array(0);
    Transform.localX = new Float32Array(0);
    Transform.localY = new Float32Array(0);
    Transform.localRotation = new Float32Array(0);
    Transform.links = new Int32Array(LINK_WORDS);
    Transform.parentGen = new Int32Array(0);
    Transform.childList = new Int32Array(0);
    Transform.orphans = new Int32Array(LINK_ORPHAN_CAP);
  }

  /**
   * DX-PARENT: link child i to parent p, whose body generation is `gen` (physics despawns the child once the parent is
   * not active or its generation moved, so a child never follows the next entity in its parent's slot). `publish`
   * false, with `gen` 0, holds the link until settleLink: the parent is still spawning, and its generation moves when
   * it activates (a body's generation is 1 or more once spawned, so physics and logic0 read 0 as "waiting", never as
   * an orphan). The child is put where its parent is at once, so it is right before physics' next step.
   */
  static writeLink(i, p, gen, publish) {
    const links = Transform.links;
    const was = Transform.parent[i];
    // The generation before the parent, and both before the version: physics reads the version first.
    Transform.parentGen[i] = gen;
    Transform.parent[i] = p;
    if (!(was < entityIdNone)) Atomics.add(links, LINK_COUNT, 1);
    if (publish) Atomics.add(links, LINK_VERSION, 1);
    Transform.composeChildPose(i);
  }

  /** A link writeLink held (publish false): its parent is active now, with generation `gen`. */
  static settleLink(i, gen) {
    Transform.parentGen[i] = gen;
    Atomics.add(Transform.links, LINK_VERSION, 1);
  }

  /** Unlink child i (it stays where it is). False when it had no parent. */
  static clearLink(i) {
    if (!(Transform.parent[i] < entityIdNone)) return false;
    Transform.parent[i] = entityIdNone;
    const links = Transform.links;
    Atomics.sub(links, LINK_COUNT, 1);
    Atomics.add(links, LINK_VERSION, 1);
    return true;
  }

  /** Tell physics to read the links again (a link it may hold as orphaned is good again). */
  static bumpLinks() {
    Atomics.add(Transform.links, LINK_VERSION, 1);
  }

  /**
   * Put child i where its parent's live pose and its local offset place it, as physics does after each step: at a
   * link, and after a pose write to it that was ignored. Physics writes it again after its next step.
   */
  static composeChildPose(i) {
    const p = Transform.parent[i];
    const x = Transform.x;
    const y = Transform.y;
    if (!(p < entityIdNone) || !x || !y) return;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const pc = rotC ? rotC[p] : 1;
    const ps = rotS ? rotS[p] : 0;
    const lx = Transform.localX[i];
    const ly = Transform.localY[i];
    const lr = Transform.localRotation[i];
    x[i] = x[p] + pc * lx - ps * ly;
    y[i] = y[p] + ps * lx + pc * ly;
    if (rotC && rotS) {
      const lc = Math.cos(lr);
      const ls = Math.sin(lr);
      rotC[i] = pc * lc - ps * ls;
      rotS[i] = ps * lc + pc * ls;
    }
    const rotation = Transform.rotation;
    if (rotation) {
      let r = rotation[p] + lr;
      if (r > PI) r -= TWO_PI;
      else if (r <= -PI) r += TWO_PI;
      rotation[i] = r;
    }
  }

  /** A pose write to a child: GameObject's warning, and nothing written. */
  static _ignoredPoseWrite(i) {
    const hook = Transform._poseWriteIgnored;
    if (hook !== null) hook(i);
  }

  // Pose views (HEAP or Weed SAB) — instance accessors for entity.transform.x etc. A child's pose is physics' (its
  // parent's plus its local offset): a write to it is ignored, with a warning.
  get x() {
    return Transform.x[this.index];
  }
  set x(value) {
    const i = this.index;
    if (Transform.parent[i] < entityIdNone) {
      Transform._ignoredPoseWrite(i);
      return;
    }
    Transform.x[i] = value;
  }
  get y() {
    return Transform.y[this.index];
  }
  set y(value) {
    const i = this.index;
    if (Transform.parent[i] < entityIdNone) {
      Transform._ignoredPoseWrite(i);
      return;
    }
    Transform.y[i] = value;
  }
  get rotation() {
    return Transform.rotation ? Transform.rotation[this.index] : 0;
  }
  set rotation(value) {
    const i = this.index;
    if (Transform.parent[i] < entityIdNone) {
      Transform._ignoredPoseWrite(i);
      return;
    }
    if (Transform.rotation) Transform.rotation[i] = value;
    if (Transform.rotC && Transform.rotS) {
      Transform.rotC[i] = Math.cos(value);
      Transform.rotS[i] = Math.sin(value);
    }
  }
  get rotC() {
    return Transform.rotC[this.index];
  }
  get rotS() {
    return Transform.rotS[this.index];
  }

  /**
   * DX-PARENT: the entity this one follows, as its index (GameObject.get(index) gives the entity), or null.
   * `transform.parent = car` (an entity or its index) links it; null unlinks it, and it stays where it is. The parent
   * must have a body (v1); the child must not have one.
   */
  get parent() {
    const p = Transform.parent[this.index];
    return p < entityIdNone ? p : null;
  }
  set parent(value) {
    const policy = Transform._linkPolicy;
    if (policy !== null) policy(this.index, value);
  }
  /** Its offset in the parent's frame (px, turned with the parent). Physics places it there after its next step. */
  get localX() {
    return Transform.localX[this.index];
  }
  set localX(value) {
    Transform.localX[this.index] = value;
  }
  get localY() {
    return Transform.localY[this.index];
  }
  set localY(value) {
    Transform.localY[this.index] = value;
  }
  /** Its turn relative to the parent (radians): its rotation is the parent's plus this. */
  get localRotation() {
    return Transform.localRotation[this.index];
  }
  set localRotation(value) {
    Transform.localRotation[this.index] = value;
  }
}
