// MamushkaBox — packed roots static; split kids may go dynamic; leaf → LiquidFun sand.

import WEED from '/src/index.js';
import {
  MamushkaComponent,
  MATERIAL_DIRT,
  MATERIAL_TINT,
  maxHpFor,
} from '../components/mamushkaComponent.js';

const {
  GameObject,
  RigidBody,
  Collider,
  SpriteRenderer,
  JointBreakListener,
  Joint,
  Transform,
  LightOccluder,
  Layer,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  SPRITE_TILE_MODE,
  ParticleEmitter,
  enums
} = WEED;
const { ShapeType } = enums;

/** Leaf edge in world px (level 0). Shatter only. Packed finest is level 1. */
export const LEAF_SIZE = 32;
/** Prototype cellSizePx = orderSize(1). */
export const ORDER1_CELL = LEAF_SIZE * 2;
/** Split kids at this level or below become dynamic. Packed roots stay static. */
export const DYNAMIC_MAX_LEVEL = 5;
/** Prototype MATERIALS[*].tileScale — world px per full rocky tile. */
export const ROCK_TILE_SCALE = 0.25;
/** Outset sprite vs collider so packed faces bleed (hides AABB seams in contour RT). */
export const ROCK_FILL_OVERLAP_PX = 2;
const ROCK_TEX_FALLBACK = 512;

const WELD_FORCE = 40e8;
const WELD_TORQUE = 20e10;

const AWAKE_R = 2200;
const AWAKE_R2 = AWAKE_R * AWAKE_R;
const WAKE_R2 = (AWAKE_R * 0.85) * (AWAKE_R * 0.85);

const FACE_EPS = ROCK_FILL_OVERLAP_PX;
const _kids = [];
const _weldQ = new Int32Array(640);
let _weldN = 0;

function sizeForLevel(level) {
  return LEAF_SIZE << (level | 0);
}

function sandLayerId() {
  const id = Layer.getId('sand');
  return id >= 0 ? id : 0;
}

function emitSand(opts) {
  LiquidFun.emit({
    flags: LIQUIDFUN_FLAGS.POWDER,
    lifespan: 10000,
    scale: 1.333,
    // fadeToAlpha0: true,
    // layerId: sandLayerId(),
    ...opts,
  });
}

function facesTouch(ax, ay, as, bx, by, bs) {
  const ha = as * 0.5;
  const hb = bs * 0.5;
  const gapX = Math.abs(ax - bx) - (ha + hb);
  const gapY = Math.abs(ay - by) - (ha + hb);
  const shareX = gapX >= -FACE_EPS && gapX <= FACE_EPS && gapY < -FACE_EPS;
  const shareY = gapY >= -FACE_EPS && gapY <= FACE_EPS && gapX < -FACE_EPS;
  return shareX || shareY;
}

function overlapAnchor(aIdx, bIdx) {
  const as = Collider.width[aIdx];
  const bs = Collider.width[bIdx];
  const ax0 = Transform.x[aIdx] - as * 0.5;
  const ay0 = Transform.y[aIdx] - as * 0.5;
  const bx0 = Transform.x[bIdx] - bs * 0.5;
  const by0 = Transform.y[bIdx] - bs * 0.5;
  const x0 = Math.max(ax0, bx0);
  const y0 = Math.max(ay0, by0);
  const x1 = Math.min(ax0 + as, bx0 + bs);
  const y1 = Math.min(ay0 + as, by0 + bs);
  if (x1 < x0 || y1 < y0) return null;
  return { x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5 };
}

function weldPair(aIdx, bIdx) {
  if (aIdx < 0 || bIdx < 0 || aIdx === bIdx) return;
  let a = aIdx;
  let b = bIdx;
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (Joint.hasBetween(a, b)) return;
  const pt = overlapAnchor(a, b);
  if (!pt) return;
  Joint.addWeld({
    entityA: a,
    entityB: b,
    worldAnchorX: pt.x,
    worldAnchorY: pt.y,
    forceThreshold: WELD_FORCE,
    torqueThreshold: WELD_TORQUE,
  });
}

function weldSiblings(kids) {
  if (kids.length < 4) return;
  const a = kids[0];
  const b = kids[1];
  const c = kids[2];
  const d = kids[3];
  if (!a || !b || !c || !d) return;
  if (!a.active || !b.active || !c.active || !d.active) return;
  weldPair(a.index, b.index);
  weldPair(c.index, d.index);
  weldPair(a.index, c.index);
  weldPair(b.index, d.index);
}

function neighborCountOf(go) {
  if (!go || go._neighborOffset < 0 || !go._neighbors) return 0;
  return go.neighborCount | 0;
}

function isQueuedKid(kids, nid) {
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid && kid.index === nid) return true;
  }
  return false;
}

function weldKidsToUncles(kids, parent) {
  if (!parent || !parent.active) return;
  const n = neighborCountOf(parent);
  const boxType = MamushkaBox.entityType;
  for (let i = 0; i < n; i++) {
    const nid = parent.getNeighbor(i);
    if (nid < 0 || nid === parent.index) continue;
    if (!Transform.active[nid]) continue;
    if (Transform.entityType[nid] !== boxType) continue;
    if (isQueuedKid(kids, nid)) continue;
    const uncle = GameObject.get(nid);
    if (!uncle || !uncle.active) continue;
    const us = uncle.mamushkaComponent.size;
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k];
      if (!kid || !kid.active) continue;
      const ks = kid.mamushkaComponent.size;
      if (!facesTouch(kid.x, kid.y, ks, uncle.x, uncle.y, us)) continue;
      weldPair(kid.index, nid);
    }
  }
}

function queueSplitJob(parentIdx, kids) {
  if (_weldN + 5 > _weldQ.length) return;
  _weldQ[_weldN++] = parentIdx;
  for (let i = 0; i < 4; i++) {
    _weldQ[_weldN++] = kids[i] ? kids[i].index : -1;
  }
}

function enableSplitKidsDynamic(kids) {
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (!kid || !kid.active || !kid._wantDynamic) continue;
    kid.rigidBody.static = 0;
    kid.rigidBody.vx = kid._splitVx || 0;
    kid.rigidBody.vy = kid._splitVy || 0;
    kid.rigidBody.angularVelocity = kid._splitOmega || 0;
    kid._wantDynamic = false;
  }
}

export function flushMamushkaDeferred() {
  if (!_weldN) return;
  const group = _kids;
  for (let i = 0; i < _weldN; i += 5) {
    const parent = GameObject.get(_weldQ[i]);
    group.length = 0;
    group.push(
      GameObject.get(_weldQ[i + 1]),
      GameObject.get(_weldQ[i + 2]),
      GameObject.get(_weldQ[i + 3]),
      GameObject.get(_weldQ[i + 4]),
    );
    weldSiblings(group);
    weldKidsToUncles(group, parent);
    enableSplitKidsDynamic(group);
    if (parent && parent.active) parent.despawn();
  }
  _weldN = 0;
}

/** AABB face welds for active boxes. Skip both-static. Each pair once (lower index). */
export function weldTouchingMamushkas() {
  const start = MamushkaBox.startIndex | 0;
  const end = start + (MamushkaBox.poolSize | 0);
  const active = Transform.active;
  const boxType = MamushkaBox.entityType;
  const entityType = Transform.entityType;
  for (let i = start; i < end; i++) {
    if (!active[i]) continue;
    const go = GameObject.get(i);
    if (!go) continue;
    const n = neighborCountOf(go);
    const sizeA = go.mamushkaComponent.size;
    for (let k = 0; k < n; k++) {
      const nid = go.getNeighbor(k);
      if (nid <= i) continue;
      if (!active[nid] || entityType[nid] !== boxType) continue;
      const other = GameObject.get(nid);
      if (!other || !other.active) continue;
      if (RigidBody.static[i] && RigidBody.static[nid]) continue;
      if (!facesTouch(go.x, go.y, sizeA, other.x, other.y, other.mamushkaComponent.size)) continue;
      weldPair(i, nid);
    }
  }
}

/** Sleep far dynamics via setAwake. Not rigidBody.static (type change, frozen walls, weld anchors). Island/weld can re-wake; expected. Packed roots already static. */
export function sleepFarMamushkaBoxes(px, py) {
  const start = MamushkaBox.startIndex | 0;
  const end = start + (MamushkaBox.poolSize | 0);
  const active = Transform.active;
  const xs = Transform.x;
  const ys = Transform.y;
  const isStatic = RigidBody.static;
  const sleeping = RigidBody.sleeping;
  for (let i = start; i < end; i++) {
    if (!active[i] || isStatic[i]) continue;
    const dx = xs[i] - px;
    const dy = ys[i] - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > AWAKE_R2) {
      if (!sleeping[i]) {
        const go = GameObject.get(i);
        if (go) go.setAwake(false);
      }
    } else if (d2 < WAKE_R2) {
      if (sleeping[i]) {
        const go = GameObject.get(i);
        if (go) go.setAwake(true);
      }
    }
  }
}

export class MamushkaBox extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [
    RigidBody,
    Collider,
    SpriteRenderer,
    JointBreakListener,
    MamushkaComponent,
  ];

  setup() {
    this.setAnchor(0.5, 0.5);
  }

  onSpawned(spawnConfig = {}) {
    const level = spawnConfig.level != null ? spawnConfig.level | 0 : 0;
    const material =
      spawnConfig.material != null ? spawnConfig.material | 0 : MATERIAL_DIRT;
    const size = spawnConfig.size != null ? spawnConfig.size : sizeForLevel(level);
    const isDynamic = spawnConfig.dynamic ? 1 : 0;

    this.mamushkaComponent.level = level;
    this.mamushkaComponent.material = material;
    this.mamushkaComponent.size = size;
    this.mamushkaComponent.hp =
      spawnConfig.hp != null ? spawnConfig.hp | 0 : maxHpFor(level, material);

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = size;
    this.collider.height = size;
    this.collider.radius = 0;
    this.collider.isTrigger = 0;
    this.collider.friction = 0.85;
    this.collider.restitution = 0;
    this.collider.visualRange = size * 0.707 + 200;

    this.rigidBody.static = isDynamic ? 0 : 1;
    this._wantDynamic = !!spawnConfig.wantDynamic;
    this.rigidBody.linearDamping = 0.05;
    this.rigidBody.angularDamping = 0.08;
    this.rigidBody.angularVelocity = spawnConfig.angularVelocity ?? 0;
    this.rigidBody.sleeping = 0;
    if (spawnConfig.vx != null) this.rigidBody.vx = spawnConfig.vx;
    if (spawnConfig.vy != null) this.rigidBody.vy = spawnConfig.vy;
    this.rigidBody.syncMassFromCollider();

    this.rotation = spawnConfig.rotation ?? 0;
    this.setAnchor(0.5, 0.5);
    this.setLayer('terrain');

    this.setSprite(spawnConfig.sprite || 'rocky');
    const texW = this.spriteRenderer.originalWidth || ROCK_TEX_FALLBACK;
    const texH = this.spriteRenderer.originalHeight || ROCK_TEX_FALLBACK;
    const vis = size + ROCK_FILL_OVERLAP_PX;
    this.setScale(vis / texW, vis / texH);
    const period = Math.max(1, (texW * ROCK_TILE_SCALE) | 0);
    this.setTileWorld(period);
    if (isDynamic || this._wantDynamic) {
      if (spawnConfig.tileMode === SPRITE_TILE_MODE.LOCAL) {
        this.setTileLocal(
          period,
          period,
          spawnConfig.tileOffsetU ?? 0,
          spawnConfig.tileOffsetV ?? 0
        );
      } else {
        this.bakeWorldTileToLocal();
      }
    }
    this.setTint(MATERIAL_TINT[material] ?? 0xffffff);
    this._splitting = false;
    this.alpha = 1;
    this._splitVx = 0;
    this._splitVy = 0;
    this._splitOmega = 0;
  }

  onDespawned() {
    Joint.removeAllForEntity(this.index);
  }

  onGotShot(damage, hitX, hitY) {
    this.takeHit(damage);
    // const layerId = Layer.getId('fx');
    ParticleEmitter.emitFlat({
      count: { min: 4, max: 8 },
      x: hitX,
      y: hitY,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 10 },
      gravity: 0.15,
      lifespan: { min: 70, max: 160 },
      scale: { min: 1, max: 2.2 },
      texture: '_whiteCircle',
      tint: { min: 0xaaffff, max: 0xffffff },
      alpha: { from: { min: 0.5, max: 0.95 }, to: 0 },
      // layerId: layerId >= 0 ? layerId : 0,
    });
  }

  /**
   * Laser / blast damage. Splits or shatters when hp hits 0.
   * @param {number} damage
   * @returns {boolean}
   */
  takeHit(damage = 1) {
    if (!this.active || this._splitting) return false;
    const dmg = Math.max(0, damage * 10 | 0);
    if (dmg <= 0) return false;
    const hp = (this.mamushkaComponent.hp | 0) - dmg;
    this.mamushkaComponent.hp = hp < 0 ? 0 : hp;
    if (hp > 0) return false;

    if ((this.mamushkaComponent.level | 0) <= 0) {
      this._shatterToSand();
      return true;
    }
    this._split();
    return true;
  }

  _shatterToSand() {
    const x = this.x;
    const y = this.y;
    const size = this.mamushkaComponent.size || LEAF_SIZE;
    const material = this.mamushkaComponent.material | 0;
    const tint = MATERIAL_TINT[material] ?? 0xc4a574;
    Joint.removeAllForEntity(this.index);
    emitSand({
      shape: 'box',
      posX: x,
      posY: y,
      halfWidth: size * 0.5,
      halfHeight: size * 0.5,
      tint,
    });
    this.despawn();
  }

  _split() {
    const level = this.mamushkaComponent.level | 0;
    const material = this.mamushkaComponent.material | 0;
    const size = this.mamushkaComponent.size || sizeForLevel(level);
    const childLevel = level - 1;
    const childSize = size * 0.5;
    const cx = this.x;
    const cy = this.y;
    const rot = this.rotation;
    const vx = this.rigidBody.vx || 0;
    const vy = this.rigidBody.vy || 0;
    const omega = this.rigidBody.angularVelocity || 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const q = childSize * 0.5;

    const locals = [
      [-q, -q],
      [q, -q],
      [-q, q],
      [q, q],
    ];

    Joint.removeAllForEntity(this.index);

    const childDynamic = childLevel <= DYNAMIC_MAX_LEVEL;
    const parentMode = this.spriteRenderer.tileMode | 0;
    const parentPeriod = this.spriteRenderer.repeatX | 0;
    const parentRepeatsX =
      parentPeriod > 0 ? (SpriteRenderer.boundsHalfW[this.index] * 2) / parentPeriod : 0;
    const parentRepeatsY =
      parentPeriod > 0 ? (SpriteRenderer.boundsHalfH[this.index] * 2) / parentPeriod : 0;
    const parentOffU = this.spriteRenderer.tileOffsetU;
    const parentOffV = this.spriteRenderer.tileOffsetV;
    const inheritLocal = childDynamic && parentMode === SPRITE_TILE_MODE.LOCAL;

    _kids.length = 0;
    for (let i = 0; i < 4; i++) {
      const lx = locals[i][0];
      const ly = locals[i][1];
      const wx = cx + lx * cos - ly * sin;
      const wy = cy + lx * sin + ly * cos;
      const qU = (i === 1 || i === 3) ? 0.5 : 0;
      const qV = (i === 2 || i === 3) ? 0.5 : 0;
      const kid = MamushkaBox.spawn({
        x: wx,
        y: wy,
        level: childLevel,
        size: childSize,
        material,
        rotation: rot,
        wantDynamic: childDynamic,
        tileMode: inheritLocal ? SPRITE_TILE_MODE.LOCAL : undefined,
        tileOffsetU: inheritLocal ? parentOffU + qU * parentRepeatsX : undefined,
        tileOffsetV: inheritLocal ? parentOffV + qV * parentRepeatsY : undefined,
      });
      if (kid) {
        kid._wantDynamic = childDynamic;
        kid._splitVx = vx;
        kid._splitVy = vy;
        kid._splitOmega = omega;
        _kids.push(kid);
      } else console.warn('[MamushkaBox] pool exhausted during split');
    }

    this.alpha = 0;
    this.collider.isTrigger = 1;
    this._splitting = true;
    queueSplitJob(this.index, _kids);
  }

  onJointBreak(_jointIndex, entityA, entityB) {
    if (this.index !== entityA) return;
    const x = (Transform.x[entityA] + Transform.x[entityB]) * 0.5;
    const y = (Transform.y[entityA] + Transform.y[entityB]) * 0.5;
    const material = this.mamushkaComponent.material | 0;
    emitSand({
      shape: 'circle',
      posX: x,
      posY: y,
      radius: 10,
      tint: MATERIAL_TINT[material] ?? 0xbba888,
    });
  }
}
