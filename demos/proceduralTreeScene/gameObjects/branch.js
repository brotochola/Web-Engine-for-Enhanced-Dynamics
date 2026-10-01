import WEED from '/src/index.js';
import { readTune } from './proceduralTree.js';

const {
  GameObject,
  SpriteRenderer,
  RigidBody,
  Collider,
  Decoration,
  DecorationComponent,
  Transform,
  Joint,
  rng,
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
const SUMMER_GROWTH = 0.35;
const BRANCH_GROUP = -1;

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
    this._maxKids = Math.min(CHILD_SLOTS, Math.max(1, readTune('maxKids') | 0));

    const decay = this._generation * 0.5 + 1;
    const lengthScale = readTune('lengthScale');
    this._maxLength = (180 / decay) * lengthScale;
    this._maxWidth = (22 / decay) * lengthScale;
    this._length = 4;
    this._width = 2;

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
    this.collider.collisionGroupIndex = BRANCH_GROUP;
    this._applyDamping(readTune('damp'));

    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setTint(0x6b4423);
    this.setAlpha(1);
    this._paint();

    let worldAngle = this._localAngle;
    if (this._parentIndex >= 0 && Transform.active[this._parentIndex]) {
      const parent = GameObject.get(this._parentIndex);
      if (parent) worldAngle += parent.rotation;
    }
    this.rotation = worldAngle;
    this._attachJoint();
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

    const season = tree.season | 0;
    if (season === SEASON_WINTER || tree.shedPending) {
      if (!this._shed) {
        this._shed = 1;
        this._shedLeaves(tree);
      }
    } else if (this._shed) {
      this._shed = 0;
    }

    const dtSec = deltaTime * 0.001 * (tree.timeScale || 1);
    if (season === SEASON_SPRING || season === SEASON_SUMMER) {
      this._grow(dtSec, season);
    }
    this._paint();
    this._applyWind(tree);
    this._applyFlex(readTune('flex'));
    this._applyDamping(readTune('damp'));

    if (season === SEASON_SPRING) this._maybeChild(dtSec);
    if (this._childCount > 0) {
      if (this._leafCount > 0) this._discardLeaves();
    } else if (season === SEASON_SPRING || season === SEASON_SUMMER) {
      this._maybeLeaf(dtSec, season);
    }
    this._updateLeaves(dtSec, tree);
  }

  _attachJoint() {
    const flex = (readTune('flex') * Math.PI) / 180;
    this._flexApplied = readTune('flex');
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

  _grow(dtSec, season) {
    const mul = (season === SEASON_SUMMER ? SUMMER_GROWTH : 1) * readTune('grow');
    if (this._length < this._maxLength) {
      this._length += LENGTH_SPEED * mul * dtSec;
      if (this._length > this._maxLength) this._length = this._maxLength;
    }
    if (this._width < this._maxWidth) {
      this._width += WIDTH_SPEED * mul * dtSec;
      if (this._width > this._maxWidth) this._width = this._maxWidth;
    }
  }

  _paint() {
    const sx = this._width / WHITE_PX;
    const sy = this._length / WHITE_PX;
    if (sx === this._drawnSx && sy === this._drawnSy) return;
    this._drawnSx = sx;
    this._drawnSy = sy;
    this.setScale(sx, sy);
    this.collider.width = Math.max(1, this._width);
    this.collider.height = Math.max(1, this._length);
    this.collider.offsetY = -this._length * 0.5;
  }

  _maybeChild(dtSec) {
    const maxGen = readTune('maxGen') | 0;
    if (this._generation >= maxGen) return;
    if (this._childCount >= this._maxKids) return;
    if (this._length < this._maxLength * 0.35) return;
    if (rng() > 0.4 * dtSec) return;

    const slot = this._openChildSlot();
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

  _openChildSlot() {
    const open = this._maxKids - this._childCount;
    if (open <= 0) return null;
    const pick = (rng() * open) | 0;
    let seen = 0;
    let which = 0;
    for (let i = 0; i < this._maxKids; i++) {
      if (this._regionMask & (1 << i)) continue;
      if (seen === pick) {
        which = i;
        break;
      }
      seen++;
    }
    const spread = (readTune('spread') * Math.PI) / 180;
    const span = spread / this._maxKids;
    return {
      which,
      angle: which * span + rng() * span - spread * 0.5,
    };
  }

  _maybeLeaf(dtSec, season) {
    if (this._childCount > 0) return;
    const maxGen = readTune('maxGen') | 0;
    if (this._generation < maxGen && season === SEASON_SPRING) return;
    const cap = Math.min(LEAF_SLOTS, Math.max(0, readTune('maxLeaves') | 0));
    if (cap <= 0 || this._leafCount >= cap) return;
    if (this._length < this._maxLength * 0.3) return;
    if (rng() > 0.9 * dtSec) return;

    const along = 0.55 + rng() * 0.4;
    const side = (rng() * 2 - 1) * this._width * 0.9;
    const target = (0.05 + rng() * 0.025) * readTune('leafScale');
    const id = this.addDecoration(
      'leaf',
      side,
      -this._length * along,
      0.001,
      0.001,
      8,
      {
        sway: true,
        swayAmplitude: 0.16 + rng() * 0.12,
        swayFrequency: 0.85 + rng() * 0.8,
        rotation: (rng() - 0.5) * 1.6,
        anchorX: 0.5,
        anchorY: 1,
        tint: 0xffffff,
      },
    );
    if (id < 0) return;

    const slot = this._leafCount++;
    this._leafIds[slot] = id;
    this._leafAlong[slot] = along;
    this._leafSide[slot] = side;
    this._leafTarget[slot] = target;
    this._placedLength = -1;
  }

  _updateLeaves(dtSec, tree) {
    if (this._leafCount === 0) return;

    const season = tree.season | 0;
    const grow = season === SEASON_SPRING || season === SEASON_SUMMER;
    const tint = season === SEASON_AUTUMN ? autumnTint(tree.seasonT) : 0xffffff;
    const move = this._placedLength !== this._length;
    if (move) this._placedLength = this._length;

    for (let i = 0; i < this._leafCount; i++) {
      const deco = Decoration.get(this._leafIds[i]);
      if (!deco || !deco.active) continue;
      if (move) {
        deco.localX = this._leafSide[i];
        deco.localY = -this._length * this._leafAlong[i];
      }
      if (grow) {
        const target = this._leafTarget[i];
        let scale = deco.scaleX + target * 0.9 * dtSec;
        if (scale > target) scale = target;
        if (scale !== deco.scaleX) {
          deco.scaleX = scale;
          deco.scaleY = scale;
        }
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
      tree.adoptFallingLeaf(falling);
    }
    this._leafCount = 0;
    this._placedLength = -1;
  }
}
