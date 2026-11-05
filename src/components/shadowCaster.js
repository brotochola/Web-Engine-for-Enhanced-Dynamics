// ShadowCaster.js - Entity marker for shadow casting
// Shadow pixels are written to the double-buffered shadow render queue (not this SoA).
// Entity SoA only stores which entities cast shadows and how tall/anchored they are.

import { Component } from '../core/component.js';
import { MESH_NO_TEXTURE, resolveMeshTextureId } from './meshRenderer.js';

export class ShadowCaster extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = inactive, 1 = entity casts shadow
    heightMultiplier: Float32Array, // Shadow length multiplier (0=no shadow, 1=normal)
    anchorOffsetX: Float32Array, // Shadow anchor offset X (0-1, relative to sprite size)
    anchorOffsetY: Float32Array, // Shadow anchor offset Y (0-1, relative to sprite size)
    textureId: Uint16Array, // setTexture's frame + 1; 0 = the shadow is the sprite's
    textureScaleX: Float32Array, // 0 = the sprite's scale
    textureScaleY: Float32Array,
    textureAnchorX: Float32Array, // NaN = the sprite's anchor
    textureAnchorY: Float32Array,
  };

  // Static pool tracking (set during initialization)
  static shadowCount = 0;

  /** config.lighting.shadowTextures, for setTexture's warning. */
  static texturesEnabled = false;
  static _warnedTextures = false;

  /**
   * Cast this frame's shadow instead of the sprite's: a tree whose branches are decorations casts its whole silhouette
   * while its trunk stays the sprite that sorts with people. Needs config.lighting.shadowTextures.
   * @param {string} name a frame of the atlas
   * @param {{ anchorX?: number, anchorY?: number, scaleX?: number, scaleY?: number }} [options] each defaults to the sprite's
   * @returns {this}
   */
  setTexture(name, { anchorX = NaN, anchorY = NaN, scaleX = 0, scaleY = 0 } = {}) {
    if (!ShadowCaster.texturesEnabled && !ShadowCaster._warnedTextures) {
      ShadowCaster._warnedTextures = true;
      console.warn('WeedJS: ShadowCaster.setTexture needs config.lighting.shadowTextures: true');
    }
    const id = resolveMeshTextureId(name);
    const i = this.index;
    ShadowCaster.textureId[i] = id === MESH_NO_TEXTURE ? 0 : id + 1;
    ShadowCaster.textureScaleX[i] = scaleX;
    ShadowCaster.textureScaleY[i] = scaleY;
    ShadowCaster.textureAnchorX[i] = anchorX;
    ShadowCaster.textureAnchorY[i] = anchorY;
    return this;
  }

  /** Back to the sprite's shadow. */
  clearTexture() {
    ShadowCaster.textureId[this.index] = 0;
    return this;
  }
}
