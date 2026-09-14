// Decoration.js - Lazy facade over one decoration pool slot (logic worker / main thread)

import { DecorationComponent } from '../components/DecorationComponent.js';
import { ensureDecorationFacade, evictDecorationFacade } from './decorationFacades.js';
import { DECORATION_INNER_Z_MIN, DECORATION_INNER_Z_MAX } from './ConfigDefaults.js';
import { DecorationSpatial } from './DecorationSpatial.js';
import { DECORATION_NO_PARENT } from './DecorationPool.js';
import { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE } from './decorationSway.js';

export { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE } from './decorationSway.js';

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
   * @param {Uint16Array} out - Preallocated pool-index buffer
   * @returns {number} Count written (capped by out.length)
   */
  static queryCircle(x, y, radius, out) {
    return DecorationSpatial.queryCircle(x, y, radius, out);
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
      DecorationComponent.parentEntityIndex[this.index] === DECORATION_NO_PARENT
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
    if (this._isCurrent()) DecorationComponent.scaleX[this.index] = v;
  }

  get scaleY() {
    return this._isCurrent() ? DecorationComponent.scaleY[this.index] : 0;
  }
  set scaleY(v) {
    if (this._isCurrent()) DecorationComponent.scaleY[this.index] = v;
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
    if (this._isCurrent()) DecorationComponent.anchorX[this.index] = v;
  }

  get innerZ() {
    return this._isCurrent() ? DecorationComponent.innerZ[this.index] : 0;
  }
  set innerZ(v) {
    if (!this._isCurrent()) return;
    const z = v | 0;
    DecorationComponent.innerZ[this.index] =
      z < DECORATION_INNER_Z_MIN
        ? DECORATION_INNER_Z_MIN
        : z > DECORATION_INNER_Z_MAX
          ? DECORATION_INNER_Z_MAX
          : z;
  }

  get textureId() {
    return this._isCurrent() ? DecorationComponent.textureId[this.index] : 0;
  }
  set textureId(v) {
    if (this._isCurrent()) DecorationComponent.textureId[this.index] = v;
  }

  get offsetX() {
    return this._isCurrent() ? DecorationComponent.offsetX[this.index] : 0;
  }
  set offsetX(v) {
    if (this._isCurrent()) DecorationComponent.offsetX[this.index] = v;
  }

  get offsetY() {
    return this._isCurrent() ? DecorationComponent.offsetY[this.index] : 0;
  }
  set offsetY(v) {
    if (this._isCurrent()) DecorationComponent.offsetY[this.index] = v;
  }

  get sway() {
    return this._isCurrent() ? DecorationComponent.sway[this.index] !== 0 : false;
  }
  set sway(v) {
    if (!this._isCurrent()) return;
    DecorationComponent.sway[this.index] = v ? SWAY_LOOP : SWAY_OFF;
    if (!v) DecorationComponent.swayPhase[this.index] = 0;
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
    if (!this._isCurrent()) return;
    const i = this.index;
    if (DecorationComponent.sway[i] !== SWAY_OFF) return;

    DecorationComponent.sway[i] = SWAY_IMPULSE;
    DecorationComponent.swayAmplitude[i] = amplitude;
    DecorationComponent.swayFrequency[i] = frequency < 0 ? -frequency : frequency;
    DecorationComponent.swayPhase[i] = 0;
  }

  get rotation() {
    if (!this._isCurrent()) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.rotS[i], DecorationComponent.rotC[i]);
  }
  set rotation(v) {
    if (!this._isCurrent()) return;
    const i = this.index;
    DecorationComponent.rotC[i] = Math.cos(v);
    DecorationComponent.rotS[i] = Math.sin(v);
    DecorationComponent.baseRotC[i] = DecorationComponent.rotC[i];
    DecorationComponent.baseRotS[i] = DecorationComponent.rotS[i];
  }

  get baseRotation() {
    if (!this._isCurrent()) return 0;
    const i = this.index;
    return Math.atan2(DecorationComponent.baseRotS[i], DecorationComponent.baseRotC[i]);
  }
  set baseRotation(v) {
    if (!this._isCurrent()) return;
    const i = this.index;
    DecorationComponent.baseRotC[i] = Math.cos(v);
    DecorationComponent.baseRotS[i] = Math.sin(v);
    DecorationComponent.rotC[i] = DecorationComponent.baseRotC[i];
    DecorationComponent.rotS[i] = DecorationComponent.baseRotS[i];
  }

  /** Facing as unit complex (no atan2/cos/sin). */
  setBaseRotCS(c, s) {
    if (!this._isCurrent()) return;
    const i = this.index;
    DecorationComponent.baseRotC[i] = c;
    DecorationComponent.baseRotS[i] = s;
    DecorationComponent.rotC[i] = c;
    DecorationComponent.rotS[i] = s;
  }
}
