// ropes.js – chapter 3, at sunset: a beam on two posts over a ravine with a pond. From the beam, on ropes, hang three
// lanterns (real lights: their rays are cast against the crates and planks, so the shadows swing with them), and
// two crates; a rope bridge of planks crosses the ravine. A rope is a chain of thin links joined by revolute joints
// (Box2D 3 in WebAssembly); the blade (jelly.js) cuts a rope or the bridge where a swipe crosses it, and what hung
// from it falls into the pond. Some seconds after the last cut, everything is rebuilt.

import { WATER_LAYER, fall } from './water.js';
import { groundY } from './terrain.js';

const {
  GameObject,
  Component,
  RigidBody,
  Collider,
  SpriteRenderer,
  LightEmitter,
  LightOccluder,
  Joint,
  LiquidFun,
  LIQUIDFUN_FLAGS,
} = WEED;

/**
 * A rope or bridge piece in shared memory: its neighbours and the joints to them (-1: none). The page writes them
 * right after the spawn (RopeWorks.link), and onSpawned leaves them alone: it runs on a logic worker a frame later
 * and would overwrite them.
 */
export class Link extends Component {
  static ARRAY_SCHEMA = {
    prev: Int32Array,
    next: Int32Array,
    jointPrev: Int32Array,
    jointNext: Int32Array,
    halfLen: Float32Array,
    axisY: Uint8Array, // 1: the long axis is the body's local y (rope links), 0: local x (planks)
  };
}

// Collision layers: links and planks touch only layer 0 (the ground, crates, lanterns), never each other; the beam and
// posts touch nothing. A joint's two bodies never collide either.
const LINK_LAYER = 3;
const LINK_MASK = 1 << 0;
const NOTHING = 1 << 31;

/** A rope link: a thin dark stick, joined at both ends. */
export class RopeLink extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, Link];

  onSpawned({ len = 12, thick = 3, color = 0x4a3420 } = {}) {
    Link.halfLen[this.index] = len / 2;
    Link.axisY[this.index] = 1; // spawned unturned, joined above and below: long along local y
    this.collider.width = thick;
    this.collider.height = len;
    this.collider.collisionLayer = LINK_LAYER;
    this.collider.collisionMask = LINK_MASK;
    this.rigidBody.linearDamping = 0.4;
    this.rigidBody.angularDamping = 0.6;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(thick, len + 1.5);
    this.setTint(color);
  }

  tick() {
    fall(this);
  }

  onDespawned() {
    Joint.removeAllForEntity(this.index);
  }
}

/** A plank of the bridge: a link that things stand on, and that casts shadows. */
export class Plank extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, Link, LightOccluder];

  onSpawned({ len = 30, thick = 8 } = {}) {
    Link.halfLen[this.index] = len / 2;
    Link.axisY[this.index] = 0;
    this.collider.width = len;
    this.collider.height = thick;
    this.collider.friction = 0.8;
    this.collider.collisionLayer = LINK_LAYER;
    this.collider.collisionMask = LINK_MASK;
    this.rigidBody.linearDamping = 0.3;
    this.rigidBody.angularDamping = 0.5;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(len - 1, thick);
    this.setTint(0x7a5634);
    this.lightOccluder.active = 1;
  }

  tick() {
    fall(this);
  }

  onDespawned() {
    Joint.removeAllForEntity(this.index);
  }
}

/** A lantern: a warm light that swings on its rope. */
export class Lantern extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, LightEmitter];

  onSpawned({ size = 22, color = 0xffc070, range = 520 } = {}) {
    this.collider.width = size * 0.8;
    this.collider.height = size;
    this.lightEmitter.shadowRange = range; // how far its shadows reach
    this.rigidBody.linearDamping = 0.3;
    this.rigidBody.angularDamping = 0.8;
    this.setSprite('_whiteCircle');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(size * 0.9, size);
    this.setTint(0xfff0c0);
    const light = this.lightEmitter;
    light.active = 1;
    light.color = color;
    light.radius = 1183;
    light.glow = 0.392;
  }

  tick() {
    fall(this);
  }
}

/** A crate on a rope: it casts the lanterns' shadows. */
export class HungCrate extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, LightOccluder];

  onSpawned({ size = 50 } = {}) {
    this.setSprite('campCrate');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(size, size);
    this.collider.width = size * 0.96;
    this.collider.height = size * 0.96;
    this.collider.friction = 0.6;
    this.rigidBody.linearDamping = 0.2;
    this.rigidBody.angularDamping = 0.4;
    this.rigidBody.mass = size * size * 0.45; // after the geometry: it floats when it falls in the pond
    this.lightOccluder.active = 1;
  }

  tick() {
    fall(this);
  }
}

/** The beam and the posts: static, drawn, shadow-casting. */
export class Beam extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, LightOccluder];

  onSpawned({ w = 100, h = 14, tint = 0x5a3e24 } = {}) {
    this.rigidBody.static = 1;
    this.collider.width = w;
    this.collider.height = h;
    this.collider.collisionLayer = LINK_LAYER;
    this.collider.collisionMask = NOTHING;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(w, h);
    this.setTint(tint);
    this.lightOccluder.active = 1;
  }
}

/** The page's part: builds the chapter, and rebuilds it some seconds after the last cut. */
export class RopeWorks {
  constructor(left, width, height, unit) {
    this.left = left;
    this.width = width;
    this.height = height;
    this.unit = Math.max(0.7, unit);
    const g = (fx) => groundY(left + width * fx, width, height);
    this.bankL = left + width * 0.3; // the ravine's edges (terrain.js)
    this.bankR = left + width * 0.7;
    this.bankY = Math.min(g(0.3), g(0.7));
    this.beamY = height * 0.27;
    this.postL = left + width * 0.2;
    this.postR = left + width * 0.8;
    this.pond = { x0: left + width * 0.38, x1: left + width * 0.62, level: height * 0.9 };
    this.pieces = []; // every entity this chapter spawned
    this.rebuildMs = 0;
    this.lastCuts = 0;
  }

  spawn() {
    // A pond in the ravine: what falls lands in water.
    const p = this.pond;
    for (let x = p.x0; x < p.x1; x += 24) {
      const bottom = groundY(x + 12, this.width, this.height) - 10;
      if (bottom > p.level) {
        LiquidFun.emit({
          shape: 'box', posX: x + 12, posY: (p.level + bottom) / 2, halfWidth: 12, halfHeight: (bottom - p.level) / 2,
          flags: LIQUIDFUN_FLAGS.WATER, tint: 0x2a8ec8, layers: [WATER_LAYER],
        });
      }
    }
    this.build();
  }

  /** The posts, the beam, the ropes and what hangs from them, the bridge. */
  build() {
    const u = this.unit;
    const add = (e) => {
      if (e) this.pieces.push(e);
      return e;
    };
    const postW = 18 * u;
    const postTop = this.beamY;
    for (const x of [this.postL, this.postR]) {
      const foot = groundY(x, this.width, this.height);
      add(Beam.spawn({ x, y: (postTop + foot) / 2, w: postW, h: foot - postTop }));
    }
    const beam = add(
      Beam.spawn({ x: (this.postL + this.postR) / 2, y: this.beamY, w: this.postR - this.postL + postW, h: 16 * u }),
    );
    if (!beam) return;
    const hangY = this.beamY + 8 * u;
    const span = this.postR - this.postL;
    // Lanterns and crates, alternating along the beam, on ropes of different lengths.
    const hangs = [
      [0.14, 0.2, 'lantern'],
      [0.3, 0.34, 'crate'],
      [0.46, 0.26, 'lantern'],
      [0.62, 0.38, 'crate'],
      [0.8, 0.22, 'lantern'],
    ];
    for (const [fx, fl, kind] of hangs) {
      const x = this.postL + span * fx;
      const len = this.height * fl;
      const end = kind === 'lantern'
        ? add(Lantern.spawn({ x, y: hangY + len + 12 * u, size: 22 * u }))
        : add(HungCrate.spawn({ x, y: hangY + len + 26 * u, size: 50 * u }));
      if (end) this.rope(beam, x, hangY, len, end);
    }
    this.bridge(add);
  }

  /** A vertical rope from (x, y0) on `top` down `len` px to `end`, which hangs from the rope's end. */
  rope(top, x, y0, len, end) {
    const n = Math.max(6, Math.round(len / (14 * this.unit)));
    const seg = len / n;
    let prev = top;
    let prevLink = -1;
    for (let k = 0; k < n; k++) {
      const link = RopeLink.spawn({ x, y: y0 + seg * (k + 0.5), len: seg, thick: 3 * this.unit });
      if (!link) return;
      this.pieces.push(link);
      const j = Joint.addRevolute({ entityA: prev.index, entityB: link.index, worldAnchorX: x, worldAnchorY: y0 + seg * k });
      Link.jointPrev[link.index] = j;
      Link.prev[link.index] = prevLink;
      if (prevLink >= 0) {
        Link.next[prevLink] = link.index;
        Link.jointNext[prevLink] = j;
      }
      prev = link;
      prevLink = link.index;
    }
    const j = Joint.addRevolute({ entityA: prev.index, entityB: end.index, worldAnchorX: x, worldAnchorY: y0 + len });
    Link.jointNext[prevLink] = j;
    Link.next[prevLink] = -1; // the end hangs from it: not a link
  }

  /** Planks across the ravine, end to end, sagging a little; each end pinned to a bank. */
  bridge(add) {
    const u = this.unit;
    const x0 = this.bankL - 6 * u;
    const x1 = this.bankR + 6 * u;
    const n = Math.max(10, Math.round((x1 - x0) / (34 * u)));
    const seg = (x1 - x0) / n;
    const sag = 34 * u;
    const y = (t) => this.bankY - 4 + sag * 4 * t * (1 - t);
    const anchorL = add(Beam.spawn({ x: x0 - 8 * u, y: this.bankY - 4, w: 16 * u, h: 10 * u, tint: 0x4a3420 }));
    const anchorR = add(Beam.spawn({ x: x1 + 8 * u, y: this.bankY - 4, w: 16 * u, h: 10 * u, tint: 0x4a3420 }));
    if (!anchorL || !anchorR) return;
    let prev = anchorL;
    let prevLink = -1;
    for (let k = 0; k < n; k++) {
      const ta = k / n;
      const tb = (k + 1) / n;
      const ax = x0 + seg * k;
      const bx = ax + seg;
      const ay = y(ta);
      const by = y(tb);
      const plank = add(
        Plank.spawn({ x: (ax + bx) / 2, y: (ay + by) / 2, len: seg, thick: 8 * u }),
      );
      if (!plank) return;
      const j = Joint.addRevolute({ entityA: prev.index, entityB: plank.index, worldAnchorX: ax, worldAnchorY: ay });
      Link.jointPrev[plank.index] = j;
      Link.prev[plank.index] = prevLink;
      if (prevLink >= 0) {
        Link.next[prevLink] = plank.index;
        Link.jointNext[prevLink] = j;
      }
      prev = plank;
      prevLink = plank.index;
    }
    const j = Joint.addRevolute({ entityA: prev.index, entityB: anchorR.index, worldAnchorX: x1, worldAnchorY: y(1) });
    Link.jointNext[prevLink] = j;
    Link.next[prevLink] = -1; // the anchor: not a link
  }

  /** Rebuilds some seconds after the blade's last cut (`cuts`: the blade's count, BladeState). */
  update(deltaMs, cuts) {
    if (cuts !== this.lastCuts) {
      this.lastCuts = cuts;
      this.rebuildMs = 9000;
      return;
    }
    if (this.rebuildMs <= 0) return;
    this.rebuildMs -= deltaMs;
    if (this.rebuildMs > 0) return;
    for (const e of this.pieces) {
      if (e.active) e.constructor.despawn(e);
    }
    this.pieces.length = 0;
    this.build();
  }
}

/**
 * Logic worker (the blade): cuts the rope or bridge piece the stroke from (x1, y1) along (dx, dy) crosses, at the
 * joint nearest the crossing. Returns how many joints it removed.
 */
export function cutLinks(x1, y1, dx, dy, list) {
  let cut = 0;
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const e = GameObject.get(i);
    const h = Link.halfLen[i];
    // The long axis, from the prev end to the next end.
    const c = Link.axisY[i] ? -e.forwardY : e.forwardX;
    const s = Link.axisY[i] ? e.forwardX : e.forwardY;
    // The piece's segment, from its prev end to its next end.
    const ax = e.x - c * h;
    const ay = e.y - s * h;
    const bx = e.x + c * h;
    const by = e.y + s * h;
    const t = segmentHit(x1, y1, dx, dy, ax, ay, bx - ax, by - ay);
    if (t < 0) continue;
    const side = t < 0.5 ? 'prev' : 'next';
    const j = side === 'prev' ? Link.jointPrev[i] : Link.jointNext[i];
    if (j < 0) continue;
    // Wake both sides first: Box2D sleeps a still rope, and a removed joint wakes nothing. The wake is a command
    // (applied before the joint sync), so the island is awake when it splits.
    e.setAwake(true);
    const other = side === 'prev' ? Link.prev[i] : Link.next[i];
    if (other >= 0) GameObject.get(other).setAwake(true);
    Joint.remove(j);
    if (side === 'prev') {
      Link.jointPrev[i] = -1;
      const p = Link.prev[i];
      if (p >= 0) Link.jointNext[p] = -1;
    } else {
      Link.jointNext[i] = -1;
      const nx = Link.next[i];
      if (nx >= 0) Link.jointPrev[nx] = -1;
    }
    cut++;
  }
  return cut;
}

/** Where segment B (b0 + t·bd) crosses segment A (a0 + u·ad), as t in [0, 1]; -1 if they do not cross. */
function segmentHit(ax, ay, adx, ady, bx, by, bdx, bdy) {
  const den = adx * bdy - ady * bdx;
  if (Math.abs(den) < 1e-6) return -1;
  const ex = bx - ax;
  const ey = by - ay;
  const u = (ex * bdy - ey * bdx) / den;
  const t = (ex * ady - ey * adx) / den;
  return u >= 0 && u <= 1 && t >= 0 && t <= 1 ? t : -1;
}
