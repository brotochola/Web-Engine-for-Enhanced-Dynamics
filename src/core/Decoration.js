// Decoration.js - Lazy facade over one decoration pool slot (logic worker / main thread)

import { DecorationComponent } from '../components/DecorationComponent.js';
import { ensureDecorationFacade, evictDecorationFacade } from './decorationFacades.js';
import { DECORATION_INNER_Z_MIN, DECORATION_INNER_Z_MAX } from './ConfigDefaults.js';

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

  _isCurrent() {
    return (
      DecorationComponent.active[this.index] !== 0 &&
      (DecorationComponent.generation?.[this.index] ?? 0) === this._generation
    );
  }

  get active() {
    return this._isCurrent();
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

  get baseRotation() {
    return this._isCurrent() ? DecorationComponent.baseRotation[this.index] : 0;
  }
  set baseRotation(v) {
    if (this._isCurrent()) DecorationComponent.baseRotation[this.index] = v;
  }
}
