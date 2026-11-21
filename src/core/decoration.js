// Decoration.js - Lazy facade over one decoration pool slot (logic worker / main thread), and the same setters by pool id

import { DecorationComponent } from '../components/decorationComponent.js';
import { ensureDecorationFacade, evictDecorationFacade } from '../util/decorationFacades.js';
import { DECORATION_INNER_Z_MIN, DECORATION_INNER_Z_MAX } from '../util/configDefaults.js';
import { DecorationSpatial } from './decorationSpatial.js';
import { DecorationPool, decorationNoParent } from './decorationPool.js';
import { SETTER_ARGS, SETTER_ARGS64 } from './setterArgs.js';
import { decodeFaceHeight, decodeFaceNormal, encodeFaceHeight, encodeFaceNormal } from '../render/faceMap.js';
import { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE, skewMarkerC } from '../util/decorationSway.js';

export { SWAY_OFF, SWAY_LOOP, SWAY_LOOP_SKEW, SWAY_IMPULSE } from '../util/decorationSway.js';

/**
 * A decoration's setters come in two forms that do the same work (E-537): the facade's (Decoration.get(id).alpha = a)
 * and the statics by pool id (Decoration.setAlpha(id, a)), for code that holds ids and wants no object per
 * decoration. A facade remembers the generation of the decoration it was made for, so one kept past its decoration's
 * despawn writes nothing; a static checks only that the slot is active: an id is a raw slot, and once its decoration
 * despawns and the pool reuses the slot, the id names the new one.
 */
export class Decoration {
  /**
   * @param {number} index - Decoration pool index
   */
  constructor(index) {
    this.index = index;
    this._generation = DecorationComponent.generation?.[index] ?? 0;
  }

  /**
   * @param {number} id - Decoration pool index
   * @returns {Decoration}
   */
  static get(id) {
    return ensureDecorationFacade(Decoration, id);
  }

  static evictFacade(id) {
    evictDecorationFacade(id);
  }

  /**
   * Query world-owned decorations in a circle (parented decorations are never indexed).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {Uint16Array|Uint32Array} out - Preallocated pool-index buffer (a Uint32Array past 65 535 decorations,
   *   whose indices do not fit 16 bits: E-129)
   * @returns {number} Count written (capped by out.length)
   */
  static queryCircle(x, y, radius, out) {
    return DecorationSpatial.queryCircle(x, y, radius, out);
  }

  /** Spawn one decoration. Returns pool index, or -1 if the pool is full. */
  static spawn(config) {
    return DecorationPool.spawn(config);
  }

  /** Spawn `config.count` decorations (same fields as spawn). Returns how many spawned. */
  static spawnMany(config) {
    return DecorationPool.spawnMany(config);
  }

  /** Despawn by pool index. */
  static despawn(index) {
    return DecorationPool.despawn(index);
  }

  static despawnAll() {
    return DecorationPool.despawnAll();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // E-537: the setters by pool id. Each does what the facade's setter of the same name does, on an active slot (a raw
  // slot: no generation is checked, see the class's comment), and returns nothing.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Whether pool slot `id` holds a live decoration (what the statics check). */
  static isActive(id) {
    return liveAt(id);
  }

  /**
   * Move world-owned decoration `id` and update the spatial hash (decoration.setPosition). An attached one stays.
   * @param {number} id
   * @param {number} x
   * @param {number} y
   */
  static setPosition(id, x, y) {
    if (worldOwnedAt(id)) DecorationSpatial.move(id, x, y);
  }

  /** decoration.x = x by pool id (world-owned only). */
  static setX(id, x) {
    if (worldOwnedAt(id)) DecorationSpatial.move(id, x, DecorationComponent.y[id]);
  }

  /** decoration.y = y by pool id (world-owned only). */
  static setY(id, y) {
    if (worldOwnedAt(id)) DecorationSpatial.move(id, DecorationComponent.x[id], y);
  }

  /** decoration.scaleX = v by pool id; the pool's largest reach follows (N-141). */
  static setScaleX(id, v) {
    if (liveAt(id)) scaleXAt(id, v);
  }

  /** decoration.scaleY = v by pool id; the pool's largest reach follows. */
  static setScaleY(id, v) {
    if (liveAt(id)) scaleYAt(id, v);
  }

  /**
   * Both scales at once by pool id (y = x when omitted); the reach follows once.
   * @param {number} id
   * @param {number} x
   * @param {number} [y]
   */
  static setScale(id, x, y) {
    if (!liveAt(id)) return;
    DecorationComponent.scaleX[id] = x;
    DecorationComponent.scaleY[id] = y !== undefined ? y : x;
    DecorationPool.noteReach(id);
  }

  /** decoration.alpha = a by pool id (0-1). */
  static setAlpha(id, a) {
    if (liveAt(id)) DecorationComponent.alpha[id] = a;
  }

  /** decoration.tint = 0xRRGGBB by pool id. */
  static setTint(id, tint) {
    if (liveAt(id)) DecorationComponent.tint[id] = tint;
  }

  /** decoration.localX = v by pool id: where an attached decoration hangs from its parent. */
  static setLocalX(id, v) {
    if (liveAt(id)) DecorationComponent.localX[id] = v;
  }

  /** decoration.localY = v by pool id. */
  static setLocalY(id, v) {
    if (liveAt(id)) DecorationComponent.localY[id] = v;
  }

  /** Both local coordinates at once by pool id. */
  static setLocalPosition(id, x, y) {
    if (!liveAt(id)) return;
    DecorationComponent.localX[id] = x;
    DecorationComponent.localY[id] = y;
  }

  /** decoration.anchorX = v by pool id (0-1); the reach follows. */
  static setAnchorX(id, v) {
    if (liveAt(id)) anchorXAt(id, v);
  }

  /** decoration.anchorY = v by pool id (0-1); the reach follows. */
  static setAnchorY(id, v) {
    if (liveAt(id)) anchorYAt(id, v);
  }

  /** decoration.innerZ = z by pool id: its order around its parent's sprite, clamped (a face's depth tie follows). */
  static setInnerZ(id, z) {
    if (liveAt(id)) innerZAt(id, z | 0);
  }

  /** decoration.setFaceNormal(x, y, z) by pool id (DX-FACES; 0, 0, 0 makes it a sprite again). */
  static setFaceNormal(id, x, y, z) {
    if (liveAt(id)) faceNormalAt(id, x, y, z);
  }

  /** decoration.faceHeight = px by pool id (DX-FACES). */
  static setFaceHeight(id, height) {
    if (liveAt(id)) faceHeightAt(id, height);
  }

  /** decoration.textureId = t by pool id (a bigAtlas animation index); the reach follows. */
  static setTextureId(id, textureId) {
    if (liveAt(id)) textureIdAt(id, textureId);
  }

  /** decoration.offsetX = v by pool id: the draw offset in world px; the reach follows. */
  static setOffsetX(id, v) {
    if (liveAt(id)) offsetXAt(id, v);
  }

  /** decoration.offsetY = v by pool id; the reach follows. */
  static setOffsetY(id, v) {
    if (liveAt(id)) offsetYAt(id, v);
  }

  /** decoration.sortOffsetY = v by pool id: world px added to the y it sorts at. */
  static setSortOffsetY(id, v) {
    if (liveAt(id)) DecorationComponent.sortOffsetY[id] = v;
  }

  /** decoration.setSkew(skewX, skewY) by pool id (DX-DECOSKEW): a shear stops its sway and its turning. */
  static setSkew(id, skewX, skewY) {
    if (!liveAt(id)) return;
    SETTER_ARGS64[0] = skewX;
    SETTER_ARGS64[1] = skewY;
    skewAt(id);
  }

  /** decoration.skewX = v by pool id. */
  static setSkewX(id, v) {
    if (!liveAt(id)) return;
    SETTER_ARGS64[0] = v;
    SETTER_ARGS64[1] = DecorationComponent.skewY[id];
    skewAt(id);
  }

  /** decoration.skewY = v by pool id. */
  static setSkewY(id, v) {
    if (!liveAt(id)) return;
    SETTER_ARGS64[0] = DecorationComponent.skewX[id];
    SETTER_ARGS64[1] = v;
    skewAt(id);
  }

  /** decoration.sway = on by pool id (a sheared one does not sway). */
  static setSway(id, on) {
    if (liveAt(id) && !shearedAt(id)) swayAt(id, !!on);
  }

  /** decoration.swayAmplitude = radians by pool id. */
  static setSwayAmplitude(id, v) {
    if (liveAt(id)) DecorationComponent.swayAmplitude[id] = v;
  }

  /** decoration.swayFrequency = v by pool id. */
  static setSwayFrequency(id, v) {
    if (liveAt(id)) DecorationComponent.swayFrequency[id] = v;
  }

  /** decoration.impulseSway(amplitude, frequency) by pool id: no-op while it sways already, or sheared. */
  static impulseSway(id, amplitude, frequency) {
    if (!liveAt(id) || shearedAt(id)) return;
    SETTER_ARGS[0] = amplitude;
    SETTER_ARGS[1] = frequency;
    impulseSwayAt(id);
  }

  /** decoration.rotation = radians by pool id: its facing and its base facing (not when sheared). */
  static setRotation(id, radians) {
    if (!liveAt(id) || shearedAt(id)) return;
    SETTER_ARGS64[0] = radians;
    rotationAt(id);
  }

  /** decoration.baseRotation = radians by pool id (not when sheared). */
  static setBaseRotation(id, radians) {
    if (!liveAt(id) || shearedAt(id)) return;
    SETTER_ARGS64[0] = radians;
    rotationAt(id);
  }

  /** decoration.setBaseRotCS(c, s) by pool id: its facing as a unit complex (not when sheared). */
  static setBaseRotCS(id, c, s) {
    if (!liveAt(id) || shearedAt(id)) return;
    SETTER_ARGS[0] = c;
    SETTER_ARGS[1] = s;
    baseRotCSAt(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The facade
  // ═══════════════════════════════════════════════════════════════════════════

  _isCurrent() {
    return (
      DecorationComponent.active[this.index] !== 0 &&
      (DecorationComponent.generation?.[this.index] ?? 0) === this._generation
    );
  }

  _isWorldOwned() {
    return (
      this._isCurrent() &&
      DecorationComponent.parentEntityIndex[this.index] === decorationNoParent()
    );
  }

  get active() {
    return this._isCurrent();
  }

  get x() {
    return this._isCurrent() ? DecorationComponent.x[this.index] : 0;
  }
  set x(v) {
    if (!this._isWorldOwned()) return;
    DecorationSpatial.move(this.index, v, DecorationComponent.y[this.index]);
  }

  get y() {
    return this._isCurrent() ? DecorationComponent.y[this.index] : 0;
  }
  set y(v) {
    if (!this._isWorldOwned()) return;
    DecorationSpatial.move(this.index, DecorationComponent.x[this.index], v);
  }

  /**
   * Move a world-owned decoration and update the spatial hash.
   * No-op for inactive or parented decorations.
   * @param {number} x
   * @param {number} y
   */
  setPosition(x, y) {
    if (!this._isWorldOwned()) return;
    DecorationSpatial.move(this.index, x, y);
  }

  get scaleX() {
    return this._isCurrent() ? DecorationComponent.scaleX[this.index] : 0;
  }
  set scaleX(v) {
    if (this._isCurrent()) scaleXAt(this.index, v);
  }

  get scaleY() {
    return this._isCurrent() ? DecorationComponent.scaleY[this.index] : 0;
  }
  set scaleY(v) {
    if (this._isCurrent()) scaleYAt(this.index, v);
  }

  get alpha() {
    return this._isCurrent() ? DecorationComponent.alpha[this.index] : 0;
  }
  set alpha(v) {
    if (this._isCurrent()) DecorationComponent.alpha[this.index] = v;
  }

  get tint() {
    return this._isCurrent() ? DecorationComponent.tint[this.index] : 0xffffff;
  }
  set tint(v) {
    if (this._isCurrent()) DecorationComponent.tint[this.index] = v;
  }

  get localX() {
    return this._isCurrent() ? DecorationComponent.localX[this.index] : 0;
  }
  set localX(v) {
    if (this._isCurrent()) DecorationComponent.localX[this.index] = v;
  }

  get localY() {
    return this._isCurrent() ? DecorationComponent.localY[this.index] : 0;
  }
  set localY(v) {
    if (this._isCurrent()) DecorationComponent.localY[this.index] = v;
  }

  get anchorX() {
    return this._isCurrent() ? DecorationComponent.anchorX[this.index] : 0.5;
  }
  set anchorX(v) {
    if (this._isCurrent()) anchorXAt(this.index, v);
  }

  get anchorY() {
    return this._isCurrent() ? DecorationComponent.anchorY[this.index] : 0.5;
  }
  set anchorY(v) {
    if (this._isCurrent()) anchorYAt(this.index, v);
  }

  get innerZ() {
    return this._isCurrent() ? DecorationComponent.innerZ[this.index] : 0;
  }
  set innerZ(v) {
    if (this._isCurrent()) innerZAt(this.index, v | 0);
  }

  /** DX-FACES: whether this decoration is a face (it carries a normal, set at spawn or with setFaceNormal). */
  get isFace() {
    return this._isCurrent() && DecorationComponent.faceOct[this.index] !== 0;
  }

  /**
   * DX-FACES: makes this decoration a flat face looking along (x, y, z), in the floor's space (x along the screen, y
   * towards the camera, z up), lit as a surface; (0, 0, 0) makes it a sprite again. The normal is stored octahedral (a
   * few thousandths off). The first face turns the G-buffer on.
   */
  setFaceNormal(x, y, z) {
    if (this._isCurrent()) faceNormalAt(this.index, x, y, z);
  }

  /**
   * DX-FACES: this face's normal into `out` (unit length; 0, 0, 0 when it is no face).
   * @param {number[]|Float32Array|Float64Array} [out]
   */
  getFaceNormal(out = [0, 0, 0]) {
    const code = this._isCurrent() ? DecorationComponent.faceOct[this.index] : 0;
    if (code === 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return out;
    }
    decodeFaceNormal(code, out);
    return out;
  }

  /** DX-FACES: px above the floor of the face at this decoration's position (0 to 1023.875, in steps of 1/8). */
  get faceHeight() {
    return this._isCurrent() ? decodeFaceHeight(DecorationComponent.faceZ[this.index]).height : 0;
  }
  set faceHeight(v) {
    if (this._isCurrent()) faceHeightAt(this.index, v);
  }

  get textureId() {
    return this._isCurrent() ? DecorationComponent.textureId[this.index] : 0;
  }
  set textureId(v) {
    if (this._isCurrent()) textureIdAt(this.index, v);
  }

  get offsetX() {
    return this._isCurrent() ? DecorationComponent.offsetX[this.index] : 0;
  }
  set offsetX(v) {
    if (this._isCurrent()) offsetXAt(this.index, v);
  }

  get offsetY() {
    return this._isCurrent() ? DecorationComponent.offsetY[this.index] : 0;
  }
  set offsetY(v) {
    if (this._isCurrent()) offsetYAt(this.index, v);
  }

  /** World px added to the y it sorts at (its own, or its parent's sort line when attached); not where it draws or culls. */
  get sortOffsetY() {
    return this._isCurrent() ? DecorationComponent.sortOffsetY[this.index] : 0;
  }
  set sortOffsetY(v) {
    if (this._isCurrent()) DecorationComponent.sortOffsetY[this.index] = v;
  }

  /** DX-DECOSKEW. Horizontal shear of the scaled sprite about its anchor: x += skewX·y. 0 = none. */
  get skewX() {
    return this._isCurrent() ? DecorationComponent.skewX[this.index] : 0;
  }
  set skewX(v) {
    if (this._isCurrent()) this.setSkew(v, DecorationComponent.skewY[this.index]);
  }

  /** DX-DECOSKEW. Vertical shear: y += skewY·x (a wall seen at an angle). A sheared decoration does not turn or sway. */
  get skewY() {
    return this._isCurrent() ? DecorationComponent.skewY[this.index] : 0;
  }
  set skewY(v) {
    if (this._isCurrent()) this.setSkew(DecorationComponent.skewX[this.index], v);
  }

  /**
   * Both shears at once (DX-DECOSKEW). A shear stops the decoration's sway and, attached, its turning with the parent
   * (inheritParentRotation off); (0, 0) draws it unturned (set its rotation again to turn it).
   * @param {number} skewX
   * @param {number} skewY
   */
  setSkew(skewX, skewY) {
    if (!this._isCurrent()) return;
    SETTER_ARGS64[0] = skewX;
    SETTER_ARGS64[1] = skewY;
    skewAt(this.index);
  }

  get sway() {
    return this._isCurrent() ? DecorationComponent.sway[this.index] !== 0 : false;
  }
  set sway(v) {
    if (!this._isCurrent() || shearedAt(this.index)) return;
    swayAt(this.index, !!v);
  }

  get swayAmplitude() {
    return this._isCurrent() ? DecorationComponent.swayAmplitude[this.index] : 0;
  }
  set swayAmplitude(v) {
    if (this._isCurrent()) DecorationComponent.swayAmplitude[this.index] = v;
  }

  get swayFrequency() {
    return this._isCurrent() ? DecorationComponent.swayFrequency[this.index] : 0;
  }
  set swayFrequency(v) {
    if (this._isCurrent()) DecorationComponent.swayFrequency[this.index] = v;
  }

  /**
   * One-shot half-sine sway (phase 0→π) then settle at baseRotation.
   * Same angular rate as continuous: dPhase/dt_ms = 0.002 * frequency.
   * No-op if already looping or mid-impulse.
   * @param {number} amplitude - Radians
   * @param {number} frequency - Speed multiplier (same as continuous swayFrequency)
   */
  impulseSway(amplitude, frequency) {
    if (!this._isCurrent() || shearedAt(this.index)) return;
    SETTER_ARGS[0] = amplitude;
    SETTER_ARGS[1] = frequency;
    impulseSwayAt(this.index);
  }

  get rotation() {
    if (!this._isCurrent() || shearedAt(this.index)) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.rotS[i], DecorationComponent.rotC[i]);
  }
  set rotation(v) {
    if (!this._isCurrent() || shearedAt(this.index)) return;
    SETTER_ARGS64[0] = v;
    rotationAt(this.index);
  }

  get baseRotation() {
    if (!this._isCurrent() || shearedAt(this.index)) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.baseRotS[i], DecorationComponent.baseRotC[i]);
  }
  set baseRotation(v) {
    if (!this._isCurrent() || shearedAt(this.index)) return;
    SETTER_ARGS64[0] = v;
    rotationAt(this.index);
  }

  /** Facing as unit complex (no atan2/cos/sin). */
  setBaseRotCS(c, s) {
    if (!this._isCurrent() || shearedAt(this.index)) return;
    SETTER_ARGS[0] = c;
    SETTER_ARGS[1] = s;
    baseRotCSAt(this.index);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// E-537: the setters' work, by pool id, for the facade (after its generation check) and the statics (after their active
// check). A double is passed only to work small enough that TurboFan always inlines it; larger work reads it from
// SETTER_ARGS (float32, what its column holds) or SETTER_ARGS64 (computed with before it is stored).
// ═══════════════════════════════════════════════════════════════════════════

/** A static's check: slot `id` holds a live decoration (false for an id outside the pool). */
function liveAt(id) {
  return DecorationComponent.active[id] > 0;
}

/** setPosition's check: live and world-owned (an attached one is placed by its parent). */
function worldOwnedAt(id) {
  return liveAt(id) && DecorationComponent.parentEntityIndex[id] === decorationNoParent();
}

/** Whether a shear stands for decoration i's facing (it then does not turn or sway). */
function shearedAt(i) {
  return DecorationComponent.skewX[i] !== 0 || DecorationComponent.skewY[i] !== 0;
}

function scaleXAt(i, v) {
  DecorationComponent.scaleX[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function scaleYAt(i, v) {
  DecorationComponent.scaleY[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function anchorXAt(i, v) {
  DecorationComponent.anchorX[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function anchorYAt(i, v) {
  DecorationComponent.anchorY[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function textureIdAt(i, v) {
  DecorationComponent.textureId[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function offsetXAt(i, v) {
  DecorationComponent.offsetX[i] = v;
  DecorationPool.noteReach(i); // N-141
}

function offsetYAt(i, v) {
  DecorationComponent.offsetY[i] = v;
  DecorationPool.noteReach(i); // N-141
}

/** innerZ: z an int, clamped; a face's depth tie (in its height's top bits) follows. */
function innerZAt(i, z) {
  const clamped = z < DECORATION_INNER_Z_MIN ? DECORATION_INNER_Z_MIN : z > DECORATION_INNER_Z_MAX ? DECORATION_INNER_Z_MAX : z;
  DecorationComponent.innerZ[i] = clamped;
  // N-263: a face's innerZ is also its depth's tie on a shared plane (DX-FACEDEPTH), in its height's top bits.
  if (DecorationComponent.faceOct[i] !== 0) {
    DecorationComponent.faceZ[i] = encodeFaceHeight(decodeFaceHeight(DecorationComponent.faceZ[i]).height, clamped);
  }
}

function faceNormalAt(i, x, y, z) {
  const oct = encodeFaceNormal(x, y, z);
  DecorationComponent.faceOct[i] = oct;
  if (oct !== 0) DecorationPool._markFacesInUse();
}

function faceHeightAt(i, v) {
  DecorationComponent.faceZ[i] = encodeFaceHeight(+v || 0, DecorationComponent.innerZ[i]);
}

/** setSkew: skewX and skewY in SETTER_ARGS64[0] and [1], exactly as given (the facing's marker is computed from them). */
function skewAt(i) {
  const skewX = SETTER_ARGS64[0];
  const skewY = SETTER_ARGS64[1];
  DecorationComponent.skewX[i] = skewX;
  DecorationComponent.skewY[i] = skewY;
  const sheared = skewX !== 0 || skewY !== 0;
  const c = sheared ? skewMarkerC(skewX, skewY) : 1;
  const s = sheared ? skewX : 0;
  DecorationComponent.baseRotC[i] = c;
  DecorationComponent.baseRotS[i] = s;
  DecorationComponent.rotC[i] = c;
  DecorationComponent.rotS[i] = s;
  if (sheared) {
    DecorationComponent.sway[i] = SWAY_OFF;
    DecorationComponent.swayPhase[i] = 0;
    DecorationComponent.inheritParentRotation[i] = 0;
  }
}

/** sway = on (a boolean), on a decoration that is not sheared. */
function swayAt(i, on) {
  DecorationComponent.sway[i] = on ? SWAY_LOOP : SWAY_OFF;
  if (!on) DecorationComponent.swayPhase[i] = 0;
  else DecorationPool._countSwayStart(); // E-506: the particle worker lists it among the swaying ones
}

/** impulseSway: amplitude and frequency in SETTER_ARGS[0] and [1] (float32, as their columns hold them). */
function impulseSwayAt(i) {
  const amplitude = SETTER_ARGS[0];
  const frequency = SETTER_ARGS[1];
  if (DecorationComponent.sway[i] !== SWAY_OFF) return;
  DecorationComponent.sway[i] = SWAY_IMPULSE;
  DecorationComponent.swayAmplitude[i] = amplitude;
  DecorationComponent.swayFrequency[i] = frequency < 0 ? -frequency : frequency;
  DecorationComponent.swayPhase[i] = 0;
  DecorationPool._countSwayStart(); // E-506
}

/** rotation and baseRotation (the same write): the radians in SETTER_ARGS64[0]. */
function rotationAt(i) {
  const v = SETTER_ARGS64[0];
  DecorationComponent.rotC[i] = Math.cos(v);
  DecorationComponent.rotS[i] = Math.sin(v);
  DecorationComponent.baseRotC[i] = DecorationComponent.rotC[i];
  DecorationComponent.baseRotS[i] = DecorationComponent.rotS[i];
}

/** setBaseRotCS: c and s in SETTER_ARGS[0] and [1]. */
function baseRotCSAt(i) {
  const c = SETTER_ARGS[0];
  const s = SETTER_ARGS[1];
  DecorationComponent.baseRotC[i] = c;
  DecorationComponent.baseRotS[i] = s;
  DecorationComponent.rotC[i] = c;
  DecorationComponent.rotS[i] = s;
}
