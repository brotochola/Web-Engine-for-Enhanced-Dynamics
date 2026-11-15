// ShadowCaster.js - Entity marker for shadow casting
// Shadow pixels are written to the double-buffered shadow render queue (not this SoA).
// Entity SoA only stores which entities cast shadows and how tall/anchored they are.

import { Component } from '../core/component.js';
import { MESH_NO_TEXTURE, resolveMeshTextureId } from './meshRenderer.js';


/**
 * DX-CASTER (plan §5.5, F9): how an entity casts, for the sun and for the lamps apart. AUTO is its sheet's default
 * (meta.shadowCast: a render with a height map casts its solid unless the sheet says 'sprite').
 */
export const CAST_KIND = Object.freeze({ AUTO: 0, SPRITE: 1, HEIGHT_MAP: 2, BOX: 3, HULL: 4, WALL: 5, NONE: 6 });
const KIND_NAMES = ['sprite', 'sprite', 'heightMap', 'box', 'hull', 'wall', 'none'];

/** One light kind's setters (shadowCaster.sun, shadowCaster.lamps): they write that kind alone. */
class CastSide {
  constructor(caster, sun, lamps) {
    this._caster = caster;
    this._sun = sun;
    this._lamps = lamps;
  }

  _set(kind) {
    const i = this._caster.index;
    if (this._sun) ShadowCaster.sunKind[i] = kind;
    if (this._lamps) ShadowCaster.lampKind[i] = kind;
    if (kind !== CAST_KIND.NONE && ShadowCaster.heightMultiplier[i] === 0) ShadowCaster.heightMultiplier[i] = 1;
    return this._caster;
  }

  /** The silhouette: a card standing on its base, the frame the light sees (the default for one view). */
  setSprite({ orient } = {}) {
    if (orient === 'fixed') ShadowCaster.orient[this._caster.index] = 1;
    else if (orient === 'light') ShadowCaster.orient[this._caster.index] = 0;
    return this._set(CAST_KIND.SPRITE);
  }

  /** Each pixel where it is in 3D (needs the sheet's heightMap). */
  setHeightMap() {
    return this._set(CAST_KIND.HEIGHT_MAP);
  }

  /** No shadow from this light kind. */
  clear() {
    return this._set(CAST_KIND.NONE);
  }
}

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
    // DX-CASTER (F9): what it casts for the sun and for the lamps (CAST_KIND, 0 its sheet's default), a card's
    // orientation (0 facing the light, 1 along the object), how much light it takes out (1 by default).
    sunKind: Uint8Array,
    lampKind: Uint8Array,
    orient: Uint8Array,
    opacity: Float32Array,
  };

  constructor(index) {
    super(index);
    // DX-CASTER: shadowCaster.sun / .lamps, the setters for one light kind.
    this._sunSide = new CastSide(this, true, false);
    this._lampSide = new CastSide(this, false, true);
  }

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

/** The methods ShadowCaster's instances get (installed on the class below the component). */
export const CASTER_METHODS = {
  /** The silhouette, for every light: a card on its base (orient 'fixed': along the object, a fence or a wall). */
  setSprite(options = {}) {
    this.sun.setSprite(options);
    this.lamps.setSprite(options);
    return this;
  },

  /** Each pixel where it is in 3D, for every light (needs the sheet's heightMap). */
  setHeightMap() {
    this.sun.setHeightMap();
    this.lamps.setHeightMap();
    return this;
  },

  /** No shadow at all. */
  clear() {
    this.sun.clear();
    this.lamps.clear();
    return this;
  },

  get sun() {
    return this._sunSide;
  },

  get lamps() {
    return this._lampSide;
  },

  /** How much light it takes out, 0 to 1 (was LightOccluder.block). The sprite shadows' layer reads it. */
  get opacity() {
    return ShadowCaster.opacity[this.index];
  },
  set opacity(v) {
    ShadowCaster.opacity[this.index] = Math.max(0, Math.min(1, +v || 0));
  },

  /** What it casts for the sun: 'sprite' | 'heightMap' | 'box' | 'hull' | 'wall' | 'none' (read only). */
  get type() {
    return KIND_NAMES[ShadowCaster.sunKind[this.index]] || 'sprite';
  },
};

// Installed on the prototype: getters and setters as written (Object.assign would call the getters).
Object.defineProperties(ShadowCaster.prototype, Object.getOwnPropertyDescriptors(CASTER_METHODS));
