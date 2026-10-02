import WEED from '/src/index.js';
import { readTune } from './proceduralTree.js';
import { LAYER_BRANCH, LAYER_GROUND, LEAF_SIDES } from '../components/treeComponent.js';
import { DeadBranch } from './deadBranch.js';

const {
  GameObject,
  SpriteRenderer,
  RigidBody,
  Collider,
  Decoration,
  DecorationComponent,
  Transform,
  Joint,
} = WEED;

export const SEASON_SPRING = 0;
export const SEASON_SUMMER = 1;
export const SEASON_AUTUMN = 2;
export const SEASON_WINTER = 3;

const WHITE_PX = 8;
const CHILD_SLOTS = 5;
const LEAF_SLOTS = 8;
const LENGTH_SPEED = 40;
const WIDTH_SPEED = 2.4;
const BRANCH_GROUP = -1;
const SHOOT_GREEN = 0x7cb342;
const DEAD_WOOD = 0x4a4036;
const SETTLE_MS = 150;
const DEAD_HANG_MS = 4000;

function autumnTint(t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const g = (255 + (0x5a - 255) * u) | 0;
  const b = (255 * (1 - u)) | 0;
  return (255 << 16) | (g << 8) | b;
}

export class Branch extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(cfg = {}) {
    this._generation = cfg.generation | 0;
    this._parentIndex = cfg.parentIndex == null ? -1 : cfg.parentIndex | 0;
    this._treeIndex = cfg.treeIndex | 0;
    this._localAngle = cfg.localAngle || 0;
    this._birthParentLength = cfg.birthParentLength || 0;
    this._regionMask = 0;
    this._childCount = 0;
    this._leafCount = 0;
    this._shed = 0;
    this._placedLength = -1;
    this._drawnSx = -1;
    this._drawnSy = -1;
    this._jointIdx = -1;
    this._flexApplied = -1;
    this._dampApplied = -1;
    this._detached = 0;
    this._dead = 0;
    this._deathRoot = 0;
    this._deadMs = 0;
    this._converting = 0;
    this._bornYear = 0;
    this._ageChecked = -1;
    this._settleMs = SETTLE_MS;
    this._colLength = -1;
    this._colWidth = -1;
    this._tintApplied = -1;

    const tree = GameObject.get(this._treeIndex);
    const gene = tree && tree.treeComponent;
    if (tree) this._bornYear = tree._yearIndex | 0;
    const decay = 1 + this._generation * (gene ? gene.lengthDecay : 0.5);
    const lengthScale = gene ? gene.segmentLength : 180;
    const widthScale = gene ? gene.segmentWidth : 22;
    this._maxKids = Math.min(CHILD_SLOTS, Math.max(1, gene ? gene.maxChildren | 0 : 3));
    this._length = 4;
    this._width = 2;
    this._maxLength = lengthScale / decay;
    this._maxWidth = widthScale / decay;

    if (!this._childIndices) {
      this._childIndices = [-1, -1, -1, -1, -1];
      this._leafIds = [-1, -1, -1, -1, -1, -1, -1, -1];
      this._leafAlong = [0, 0, 0, 0, 0, 0, 0, 0];
      this._leafSide = [0, 0, 0, 0, 0, 0, 0, 0];
      this._leafTarget = [0, 0, 0, 0, 0, 0, 0, 0];
    } else {
      for (let i = 0; i < CHILD_SLOTS; i++) this._childIndices[i] = -1;
      for (let i = 0; i < LEAF_SLOTS; i++) this._leafIds[i] = -1;
    }

    this.rigidBody.static = 0;
    this.collider.friction = 0.65;
    this.collider.restitution = 0;
    this.collider.collisionLayer = LAYER_BRANCH;
    this.collider.collisionMask = 1 << LAYER_GROUND;
    this.collider.collisionGroupIndex = BRANCH_GROUP;
    this._applyDamping(readTune('damp'));

    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setTint(SHOOT_GREEN);
    this._tintApplied = SHOOT_GREEN;
    this.setAlpha(1);
    this._paint();

    let worldAngle = this._localAngle;
    if (this._parentIndex >= 0 && Transform.active[this._parentIndex]) {
      const parent = GameObject.get(this._parentIndex);
      if (parent) worldAngle += parent.rotation;
    }
    this.rotation = worldAngle;
    this.vx = 0;
    this.vy = 0;
    this.angularVelocity = 0;
    this._attachJoint();
    if (tree && gene) this._sproutLeaves(gene);
  }

  onDespawned() {
    if (this._jointIdx >= 0) {
      Joint.remove(this._jointIdx);
      this._jointIdx = -1;
    }
    const kids = this._childIndices;
    if (!kids) return;
    for (let i = 0; i < CHILD_SLOTS; i++) {
      const id = kids[i];
      kids[i] = -1;
      if (id < 0 || !Transform.active[id]) continue;
      const child = GameObject.get(id);
      if (child) child.despawn();
    }
  }

  tick(dtRatio, deltaTime) {
    const tree = GameObject.get(this._treeIndex);
    if (!tree || tree.season == null) return;

    const gene = tree.treeComponent;
    const season = tree.season | 0;
    if (this._dead) {
      this._deadMs += deltaTime * (tree.timeScale || 1);
      this._paint();
      if (this._deathRoot && this._deadMs >= DEAD_HANG_MS) this._toDead(tree);
      return;
    }
    this._maybeDie(tree, gene, season);

    if (this._detached) {
      this._paint();
      return;
    }

    const dtSec = deltaTime * 0.001 * (tree.timeScale || 1);
    if (this._settleMs > 0) {
      this._settleMs -= deltaTime;
      this._applyDamping(8);
    } else {
      this._applyDamping(readTune('damp'));
    }
    if (season !== SEASON_WINTER) this._grow(dtSec, season, gene);
    this._paint();
    this._applyWind(tree);
    const grown = this._maxLength > 0 ? this._length / this._maxLength : 1;
    const open = grown < 0 ? 0 : grown > 1 ? 1 : grown;
    this._applyFlex(Math.round(gene.flexDeg * (0.25 + 0.75 * open)));

    if (season === SEASON_WINTER || tree.shedPending) {
      if (!this._shed) {
        this._shed = 1;
        this._shedLeaves(tree);
      }
    } else if (this._shed) {
      this._shed = 0;
    }

    const sides = (gene.leafLayout | 0) === LEAF_SIDES;
    const young = this._maxWidth > 1 && this._width / this._maxWidth < 0.55;
    if (season === SEASON_SPRING) this._maybeChild(dtSec, tree, gene);
    if (!sides && this._childCount > 0 && !young) {
      if (this._leafCount > 0) this._discardLeaves();
    } else if (season === SEASON_SPRING || season === SEASON_SUMMER) {
      if (sides) this._maybeSideLeaves(gene);
      else this._maybeLeaf(dtSec, season, tree, gene);
    }
    this._updateLeaves(tree, gene);
    if (this._settleMs > 0) {
      this.vx = 0;
      this.vy = 0;
      this.angularVelocity = 0;
    }
  }

  _maybeDie(tree, gene, season) {
    if (this._dead) return;
    if (this._generation < (gene.dieFromGeneration | 0)) return;
    const maxAge = gene.maxAgeYears | 0;
    const chance = gene.dieChance;
    if (maxAge <= 0 || chance <= 0 || season !== SEASON_SPRING) return;
    const year = tree._yearIndex | 0;
    if (year === this._ageChecked) return;
    this._ageChecked = year;
    const age = year - this._bornYear;
    if (age >= maxAge && tree.rand() < chance) this._killTree(tree, false);
  }

  _killTree(tree, fromParent) {
    if (this._dead) return;
    this._dead = 1;
    this._deathRoot = fromParent ? 0 : 1;
    this._deadMs = 0;
    this._shedLeaves(tree);
    const kids = this._childIndices;
    if (!kids) return;
    for (let i = 0; i < CHILD_SLOTS; i++) {
      const id = kids[i];
      if (id < 0 || !Transform.active[id]) continue;
      const child = GameObject.get(id);
      if (child && child._killTree) child._killTree(tree, true);
    }
  }

  _toDead(tree) {
    if (this._converting) return;
    this._converting = 1;
    this._detached = 1;
    this._shedLeaves(tree);
    if (this._jointIdx >= 0) {
      Joint.remove(this._jointIdx);
      this._jointIdx = -1;
    }
    const kids = this._childIndices;
    if (kids) {
      for (let i = 0; i < CHILD_SLOTS; i++) {
        const id = kids[i];
        kids[i] = -1;
        if (id < 0 || !Transform.active[id]) continue;
        const child = GameObject.get(id);
        if (child && child._toDead) child._toDead(tree);
      }
    }
    DeadBranch.spawn({
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      length: this._length,
      width: this._width,
      vx: this.vx,
      vy: this.vy,
      ang: this.angularVelocity,
    });
    this.despawn();
  }

  _attachJoint() {
    const tree = GameObject.get(this._treeIndex);
    const flexDeg = tree && tree.treeComponent ? tree.treeComponent.flexDeg : 12;
    const flexDeg0 = Math.round((flexDeg || 12) * 0.25);
    const flex = (flexDeg0 * Math.PI) / 180;
    this._flexApplied = flexDeg0;
    const parent = this._parentIndex < 0 ? this._treeIndex : this._parentIndex;
    const along = this._parentIndex < 0 ? 0 : this._birthParentLength;
    const idx = Joint.addRevolute({
      entityA: parent,
      entityB: this.index,
      localAnchorAX: 0,
      localAnchorAY: -along,
      localAnchorBX: 0,
      localAnchorBY: 0,
      enableLimit: true,
      lowerAngle: -flex,
      upperAngle: flex,
    });
    this._jointIdx = idx;
  }

  _applyFlex(degrees) {
    if (this._jointIdx < 0 || degrees === this._flexApplied) return;
    this._flexApplied = degrees;
    const flex = (degrees * Math.PI) / 180;
    Joint.update(this._jointIdx, {
      enableLimit: true,
      lowerAngle: -flex,
      upperAngle: flex,
    });
  }

  _applyDamping(damp) {
    if (damp === this._dampApplied) return;
    this._dampApplied = damp;
    this.rigidBody.linearDamping = damp * 0.5;
    this.rigidBody.angularDamping = damp;
  }

  _applyWind(tree) {
    if (this._leafCount <= 0 || !tree.windX) return;
    const mass = RigidBody.mass[this.index];
    const m = mass > 0 ? mass : 1;
    this.addAcceleration((tree.windX * this._leafCount) / m, 0);
  }

  _grow(dtSec, season, gene) {
    const decay = 1 + this._generation * gene.lengthDecay;
    this._maxLength = gene.segmentLength / decay;
    this._maxWidth = gene.segmentWidth / decay;
    let rate = gene.growth;
    if (season === SEASON_SUMMER) rate *= 0.35;
    else if (season === SEASON_AUTUMN) rate *= gene.matureGrowth;
    else if (season !== SEASON_SPRING) rate = 0;
    const past = this._length >= this._maxLength;
    if (past) rate *= gene.matureGrowth;
    if (rate <= 0) return;
    this._length += LENGTH_SPEED * rate * dtSec;
    const longEnough = this._length >= this._maxLength * 0.75;
    const widthMul = longEnough ? 1 : 0.15;
    this._width += WIDTH_SPEED * rate * widthMul * dtSec;
  }

  _paint() {
    const sx = this._width / WHITE_PX;
    const sy = this._length / WHITE_PX;
    if (sx !== this._drawnSx || sy !== this._drawnSy) {
      this._drawnSx = sx;
      this._drawnSy = sy;
      this.setScale(sx, sy);
    }
    const wood = this._woodTint();
    if (wood !== this._tintApplied) {
      this._tintApplied = wood;
      this.setTint(wood);
    }
    this._syncCollider();
  }

  _woodTint() {
    if (this._dead) return DEAD_WOOD;
    const u = this._maxWidth > 0 ? this._width / this._maxWidth : 1;
    const t = u < 0 ? 0 : u > 1 ? 1 : u;
    const r = (0x7c + (0x6b - 0x7c) * t) | 0;
    const g = (0xb3 + (0x44 - 0xb3) * t) | 0;
    const b = (0x42 + (0x23 - 0x42) * t) | 0;
    return (r << 16) | (g << 8) | b;
  }

  _syncCollider() {
    if (
      this._colLength >= 0 &&
      Math.abs(this._length - this._colLength) < 4 &&
      Math.abs(this._width - this._colWidth) < 1.5
    ) {
      return;
    }
    this._colLength = this._length;
    this._colWidth = this._width;
    this.collider.width = Math.max(1, this._width);
    this.collider.height = Math.max(1, this._length);
    this.collider.offsetY = -this._length * 0.5;
    this.angularVelocity = 0;
  }

  _sproutLeaves(gene) {
    const sides = (gene.leafLayout | 0) === LEAF_SIDES;
    for (let n = 0; n < 2; n++) {
      const side = n === 0 ? -1 : 1;
      if (sides) this._addLeaf(side, 0.42 + n * 0.28, side * 1.15, gene.leafScale, true);
      else this._addLeaf(side * 4, 0.72 + n * 0.16, side * 0.55, gene.leafScale, false);
    }
  }

  _maybeChild(dtSec, tree, gene) {
    const maxGen = gene.maxGeneration | 0;
    const maxKids = Math.min(CHILD_SLOTS, Math.max(1, gene.maxChildren | 0));
    this._maxKids = maxKids;
    if (this._generation >= maxGen) return;
    if (this._childCount >= maxKids) return;
    if (this._length < this._maxLength * 0.35) return;
    const age = (tree._yearIndex | 0) - this._bornYear;
    const ageFactor = Math.max(0.15, 1 - age * 0.12);
    if (tree.rand() > 0.4 * dtSec * ageFactor) return;

    const slot = this._openChildSlot(tree, gene, maxKids);
    if (!slot) return;

    const dist = this._length;
    const c = Transform.rotC[this.index];
    const s = Transform.rotS[this.index];
    const child = Branch.spawn({
      x: this.x + s * dist,
      y: this.y - c * dist,
      generation: this._generation + 1,
      parentIndex: this.index,
      treeIndex: this._treeIndex,
      localAngle: slot.angle,
      birthParentLength: this._length,
    });
    if (!child) return;

    this._regionMask |= 1 << slot.which;
    this._childIndices[this._childCount++] = child.index;
  }

  _openChildSlot(tree, gene, maxKids) {
    const open = maxKids - this._childCount;
    if (open <= 0) return null;
    if (maxKids <= 1) {
      return { which: 0, angle: (tree.rand() - 0.5) * 0.22 };
    }
    const pick = (tree.rand() * open) | 0;
    let seen = 0;
    let which = 0;
    for (let i = 0; i < maxKids; i++) {
      if (this._regionMask & (1 << i)) continue;
      if (seen === pick) {
        which = i;
        break;
      }
      seen++;
    }
    const spread = (gene.spreadDeg * Math.PI) / 180;
    const span = spread / maxKids;
    return {
      which,
      angle: which * span + tree.rand() * span - spread * 0.5,
    };
  }

  _maybeSideLeaves(gene) {
    const cap = Math.min(2, gene.leavesPerSegment | 0);
    if (cap <= 0 || this._leafCount >= cap) return;
    if (this._length < this._maxLength * 0.35) return;
    for (let n = this._leafCount; n < cap; n++) {
      const side = n === 0 ? -1 : 1;
      this._addLeaf(side, 0.62, side * 1.15, gene.leafScale, true);
    }
  }

  _maybeLeaf(dtSec, season, tree, gene) {
    if (this._childCount > 0) return;
    const maxGen = gene.maxGeneration | 0;
    if (this._generation < maxGen && season === SEASON_SPRING) return;
    const cap = Math.min(LEAF_SLOTS, Math.max(0, gene.leavesPerSegment | 0));
    if (cap <= 0 || this._leafCount >= cap) return;
    if (this._length < this._maxLength * 0.3) return;
    if (tree.rand() > 0.9 * dtSec) return;

    const along = 0.55 + tree.rand() * 0.4;
    const side = (tree.rand() * 2 - 1) * this._width * 0.9;
    this._addLeaf(side, along, (tree.rand() - 0.5) * 1.6, gene.leafScale, false);
  }

  _leafScaleFor(full) {
    const grown = this._maxLength > 0 ? this._length / this._maxLength : 1;
    let u = grown;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    return full * (0.22 + 0.78 * u);
  }

  _addLeaf(side, along, rotation, leafScale, lateral) {
    const full = (lateral ? 0.07 : 0.055) * leafScale;
    const scale = this._leafScaleFor(full);
    const localX = lateral ? side * (this._width * 0.5 + 6) : side;
    const id = this.addDecoration(
      'leaf',
      localX,
      -this._length * along,
      scale,
      scale,
      8,
      {
        sway: true,
        swayAmplitude: 0.16 + Math.abs(rotation) * 0.05,
        swayFrequency: 0.85 + (this._leafCount + 1) * 0.15,
        rotation,
        anchorX: 0.5,
        anchorY: 1,
        tint: 0xffffff,
      },
    );
    if (id < 0) return;
    const slot = this._leafCount++;
    this._leafIds[slot] = id;
    this._leafAlong[slot] = along;
    this._leafSide[slot] = lateral ? side : localX;
    this._leafTarget[slot] = full;
    this._placedLength = -1;
  }

  _updateLeaves(tree, gene) {
    if (this._leafCount === 0) return;

    const season = tree.season | 0;
    const tint = season === SEASON_AUTUMN
      ? autumnTint(tree.seasonT)
      : this._width / this._maxWidth < 0.55
        ? 0x9fe06a
        : 0xffffff;
    const move = this._placedLength !== this._length;
    if (move) this._placedLength = this._length;

    const sides = gene && (gene.leafLayout | 0) === LEAF_SIDES;
    for (let i = 0; i < this._leafCount; i++) {
      const deco = Decoration.get(this._leafIds[i]);
      if (!deco || !deco.active) continue;
      if (move || sides) {
        deco.localX = sides
          ? this._leafSide[i] * (this._width * 0.5 + 6)
          : this._leafSide[i];
        deco.localY = -this._length * this._leafAlong[i];
      }
      const scale = this._leafScaleFor(this._leafTarget[i]);
      if (scale !== deco.scaleX) {
        deco.scaleX = scale;
        deco.scaleY = scale;
      }
      if (deco.tint !== tint) deco.tint = tint;
    }
  }

  _discardLeaves() {
    for (let i = 0; i < this._leafCount; i++) {
      const id = this._leafIds[i];
      this._leafIds[i] = -1;
      if (id >= 0) Decoration.despawn(id);
    }
    this._leafCount = 0;
    this._placedLength = -1;
  }

  _shedLeaves(tree) {
    const pc = Transform.rotC[this.index];
    const ps = Transform.rotS[this.index];
    for (let i = 0; i < this._leafCount; i++) {
      const id = this._leafIds[i];
      this._leafIds[i] = -1;
      if (id < 0) continue;
      const deco = Decoration.get(id);
      if (!deco || !deco.active) continue;

      const lx = deco.localX;
      const ly = deco.localY;
      const bc = DecorationComponent.baseRotC[id];
      const bs = DecorationComponent.baseRotS[id];
      const falling = {
        x: this.x + pc * lx - ps * ly,
        y: this.y + ps * lx + pc * ly,
        scale: deco.scaleX,
        tint: deco.tint,
        rotation: Math.atan2(ps * bc + pc * bs, pc * bc - ps * bs),
        swayAmplitude: deco.swayAmplitude,
        swayFrequency: deco.swayFrequency,
      };
      Decoration.despawn(id);
      tree.dropLeaf(falling);
    }
    this._leafCount = 0;
    this._placedLength = -1;
  }
}
