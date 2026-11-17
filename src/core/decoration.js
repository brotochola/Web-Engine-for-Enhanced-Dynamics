// Decoration.js - Lazy facade over one decoration pool slot (logic worker / main thread)

import { DecorationComponent } from '../components/decorationComponent.js';
import { ensureDecorationFacade, evictDecorationFacade } from '../util/decorationFacades.js';
import { DECORATION_INNER_Z_MIN, DECORATION_INNER_Z_MAX } from '../util/configDefaults.js';
import { DecorationSpatial } from './decorationSpatial.js';
import { DecorationPool, decorationNoParent } from './decorationPool.js';
import { decodeFaceHeight, decodeFaceNormal, encodeFaceHeight, encodeFaceNormal } from '../render/faceMap.js';
import { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE, skewMarkerC } from '../util/decorationSway.js';

export { SWAY_OFF, SWAY_LOOP, SWAY_LOOP_SKEW, SWAY_IMPULSE } from '../util/decorationSway.js';

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

  /** Create facade when a parented decoration is spawned (lazy map). */
  static ensureForParented(id) {
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
    this.setPosition(v, DecorationComponent.y[this.index]);
  }

  get y() {
    return this._isCurrent() ? DecorationComponent.y[this.index] : 0;
  }
  set y(v) {
    if (!this._isWorldOwned()) return;
    this.setPosition(DecorationComponent.x[this.index], v);
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
    if (this._isCurrent()) {
      DecorationComponent.scaleX[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
  }

  get scaleY() {
    return this._isCurrent() ? DecorationComponent.scaleY[this.index] : 0;
  }
  set scaleY(v) {
    if (this._isCurrent()) {
      DecorationComponent.scaleY[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
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
    if (this._isCurrent()) {
      DecorationComponent.anchorX[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
  }

  get innerZ() {
    return this._isCurrent() ? DecorationComponent.innerZ[this.index] : 0;
  }
  set innerZ(v) {
    if (!this._isCurrent()) return;
    const z = v | 0;
    const clamped = z < DECORATION_INNER_Z_MIN ? DECORATION_INNER_Z_MIN : z > DECORATION_INNER_Z_MAX ? DECORATION_INNER_Z_MAX : z;
    const i = this.index;
    DecorationComponent.innerZ[i] = clamped;
    // N-263: a face's innerZ is also its depth's tie on a shared plane (DX-FACEDEPTH), in its height's top bits.
    if (DecorationComponent.faceOct[i] !== 0) {
      DecorationComponent.faceZ[i] = encodeFaceHeight(decodeFaceHeight(DecorationComponent.faceZ[i]).height, clamped);
    }
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
    if (!this._isCurrent()) return;
    const i = this.index;
    const oct = encodeFaceNormal(x, y, z);
    DecorationComponent.faceOct[i] = oct;
    if (oct !== 0) DecorationPool._markFacesInUse();
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
    if (!this._isCurrent()) return;
    const i = this.index;
    DecorationComponent.faceZ[i] = encodeFaceHeight(+v || 0, DecorationComponent.innerZ[i]);
  }

  get textureId() {
    return this._isCurrent() ? DecorationComponent.textureId[this.index] : 0;
  }
  set textureId(v) {
    if (this._isCurrent()) {
      DecorationComponent.textureId[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
  }

  get offsetX() {
    return this._isCurrent() ? DecorationComponent.offsetX[this.index] : 0;
  }
  set offsetX(v) {
    if (this._isCurrent()) {
      DecorationComponent.offsetX[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
  }

  get offsetY() {
    return this._isCurrent() ? DecorationComponent.offsetY[this.index] : 0;
  }
  set offsetY(v) {
    if (this._isCurrent()) {
      DecorationComponent.offsetY[this.index] = v;
      DecorationPool.noteReach(this.index); // N-141
    }
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
    const i = this.index;
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

  /** Whether a shear stands for this decoration's facing (it then does not turn or sway). */
  _sheared() {
    const i = this.index;
    return DecorationComponent.skewX[i] !== 0 || DecorationComponent.skewY[i] !== 0;
  }

  get sway() {
    return this._isCurrent() ? DecorationComponent.sway[this.index] !== 0 : false;
  }
  set sway(v) {
    if (!this._isCurrent() || this._sheared()) return;
    DecorationComponent.sway[this.index] = v ? SWAY_LOOP : SWAY_OFF;
    if (!v) DecorationComponent.swayPhase[this.index] = 0;
    else DecorationPool._countSwayStart(); // E-506: the particle worker lists it among the swaying ones
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
    if (!this._isCurrent() || this._sheared()) return;
    const i = this.index;
    if (DecorationComponent.sway[i] !== SWAY_OFF) return;

    DecorationComponent.sway[i] = SWAY_IMPULSE;
    DecorationComponent.swayAmplitude[i] = amplitude;
    DecorationComponent.swayFrequency[i] = frequency < 0 ? -frequency : frequency;
    DecorationComponent.swayPhase[i] = 0;
    DecorationPool._countSwayStart(); // E-506
  }

  get rotation() {
    if (!this._isCurrent() || this._sheared()) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.rotS[i], DecorationComponent.rotC[i]);
  }
  set rotation(v) {
    if (!this._isCurrent() || this._sheared()) return;
    const i = this.index;
    DecorationComponent.rotC[i] = Math.cos(v);
    DecorationComponent.rotS[i] = Math.sin(v);
    DecorationComponent.baseRotC[i] = DecorationComponent.rotC[i];
    DecorationComponent.baseRotS[i] = DecorationComponent.rotS[i];
  }

  get baseRotation() {
    if (!this._isCurrent() || this._sheared()) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.baseRotS[i], DecorationComponent.baseRotC[i]);
  }
  set baseRotation(v) {
    if (!this._isCurrent() || this._sheared()) return;
    const i = this.index;
    DecorationComponent.baseRotC[i] = Math.cos(v);
    DecorationComponent.baseRotS[i] = Math.sin(v);
    DecorationComponent.rotC[i] = DecorationComponent.baseRotC[i];
    DecorationComponent.rotS[i] = DecorationComponent.baseRotS[i];
  }

  /** Facing as unit complex (no atan2/cos/sin). */
  setBaseRotCS(c, s) {
    if (!this._isCurrent() || this._sheared()) return;
    const i = this.index;
    DecorationComponent.baseRotC[i] = c;
    DecorationComponent.baseRotS[i] = s;
    DecorationComponent.rotC[i] = c;
    DecorationComponent.rotS[i] = s;
  }
}
