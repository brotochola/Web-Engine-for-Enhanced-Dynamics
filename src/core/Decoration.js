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

  get active() {
    return DecorationComponent.active[this.index] !== 0;
  }

  get scaleX() {
    return DecorationComponent.scaleX[this.index];
  }
  set scaleX(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.scaleX[this.index] = v;
  }

  get scaleY() {
    return DecorationComponent.scaleY[this.index];
  }
  set scaleY(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.scaleY[this.index] = v;
  }

  get alpha() {
    return DecorationComponent.alpha[this.index];
  }
  set alpha(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.alpha[this.index] = v;
  }

  get tint() {
    return DecorationComponent.tint[this.index];
  }
  set tint(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.tint[this.index] = v;
  }

  get localX() {
    return DecorationComponent.localX[this.index];
  }
  set localX(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.localX[this.index] = v;
  }

  get localY() {
    return DecorationComponent.localY[this.index];
  }
  set localY(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.localY[this.index] = v;
  }

  get anchorX() {
    return DecorationComponent.anchorX[this.index];
  }
  set anchorX(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.anchorX[this.index] = v;
  }

  get innerZ() {
    return DecorationComponent.innerZ[this.index];
  }
  set innerZ(v) {
    if (!DecorationComponent.active[this.index]) return;
    const z = v | 0;
    DecorationComponent.innerZ[this.index] =
      z < DECORATION_INNER_Z_MIN
        ? DECORATION_INNER_Z_MIN
        : z > DECORATION_INNER_Z_MAX
          ? DECORATION_INNER_Z_MAX
          : z;
  }

  get textureId() {
    return DecorationComponent.textureId[this.index];
  }
  set textureId(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.textureId[this.index] = v;
  }

  get offsetX() {
    return DecorationComponent.offsetX[this.index];
  }
  set offsetX(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.offsetX[this.index] = v;
  }

  get offsetY() {
    return DecorationComponent.offsetY[this.index];
  }
  set offsetY(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.offsetY[this.index] = v;
  }

  get baseRotation() {
    return DecorationComponent.baseRotation[this.index];
  }
  set baseRotation(v) {
    if (DecorationComponent.active[this.index]) DecorationComponent.baseRotation[this.index] = v;
  }
}
