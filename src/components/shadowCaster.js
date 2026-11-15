// ShadowCaster.js - How an entity casts its shadow, for the sun and for the lamps apart (DX-CASTER, DX_LIGHT3D_PLAN.md §5.5):
// its sprite's silhouette (the default), its height map, a volume or a wall. Shadow pixels are written to the double-buffered
// shadow render queue (not this SoA); the entity SoA says how each entity casts.
//
// A volume is an internal VolumeShadowCaster's (a mesh on the volumeShadows layer, with room in a scene whose
// config.lighting.maxVolumes is above 0), and a wall is LightOccluder's (raycasted lighting): the class lists that component
// too, and ShadowCaster's setters drive it. The last setter wins: the sprite rows, a volume or a wall an earlier setter gave the
// entity go when no light kind casts them any more.

import { Component } from '../core/component.js';
import { LightOccluder, LIGHT_OCCLUDER_MASK_COLLIDER, LIGHT_OCCLUDER_MASK_SPRITE } from './lightOccluder.js';
import { MESH_NO_TEXTURE, resolveMeshTextureId } from './meshRenderer.js';
import { VolumeShadowCaster, holdsVolume } from './volumeShadowCaster.js';


/**
 * DX-CASTER (plan §5.5, F9): how an entity casts, for the sun and for the lamps apart. AUTO is its sheet's default
 * (meta.shadowCast: a render with a height map casts its solid unless the sheet says 'sprite'). AUTO, SPRITE and HEIGHT_MAP
 * are the sprite rows'; BOX and HULL the volume's (setBox, addLevel, setHull); WALL the LightOccluder's (lamps and
 * headlights, under raycasted lighting).
 */
export const CAST_KIND = Object.freeze({ AUTO: 0, SPRITE: 1, HEIGHT_MAP: 2, BOX: 3, HULL: 4, WALL: 5, NONE: 6 });
const KIND_NAMES = ['sprite', 'sprite', 'heightMap', 'box', 'hull', 'wall', 'none'];

/** The selfShadow column: 0 the asset's way (on for a render with a footprint, off for one view), 1 on, 2 off. */
export const SELF_SHADOW = Object.freeze({ AUTO: 0, ON: 1, OFF: 2 });

/** The warnings given, by text: each mistake once. */
const _warned = new Set();

export function resetShadowCasterWarns() {
  _warned.clear();
  ShadowCaster._warnedTextures = false;
}

function warnOnce(text) {
  if (_warned.has(text)) return;
  _warned.add(text);
  console.warn(`WeedJS: ${text}`);
}

/** Kinds the sprite rows cast: its sheet's way, its card, its solid. */
function castsSprite(kind) {
  return kind <= CAST_KIND.HEIGHT_MAP;
}

function castsVolume(kind) {
  return kind === CAST_KIND.BOX || kind === CAST_KIND.HULL;
}

/** The entity, when its class lists `name` (ShadowCaster drives its LightOccluder); else null. */
function entityWith(caster, name) {
  const owner = caster.owner;
  return owner != null && owner._hasComponents != null && owner._hasComponents[name] === true ? owner : null;
}

/** The caster's volume, made on first use: its entity's MeshRenderer row draws it, its own when the class lists one. */
function casterVolume(caster) {
  const made = caster._volumeCaster;
  if (made !== null) return made;
  const owner = caster.owner;
  const ownMesh = owner != null && owner._hasComponents != null && owner._hasComponents.MeshRenderer === true;
  return (caster._volumeCaster = new VolumeShadowCaster(caster.index, ownMesh));
}

/**
 * Writes `kind` for the sun, the lamps or both, and keeps what casts in step with the kinds. The sprite rows (`active`: pre-render's
 * emit gives a caster at 0 no shadow height, so no row) and a volume go when no kind casts them any more, and the rows come back on
 * that change alone, so a setter on a despawned entity does not wake it. The wall goes whenever no kind is a wall: a class that
 * lists LightOccluder starts with it on, and its first other setter takes it off. setWall turns it on.
 */
function writeKinds(caster, sun, lamps, kind) {
  const i = caster.index;
  const wasSun = ShadowCaster.sunKind[i];
  const wasLamp = ShadowCaster.lampKind[i];
  const nowSun = sun ? kind : wasSun;
  const nowLamp = lamps ? kind : wasLamp;
  ShadowCaster.sunKind[i] = nowSun;
  ShadowCaster.lampKind[i] = nowLamp;
  const sprite = castsSprite(nowSun) || castsSprite(nowLamp);
  if (sprite !== (castsSprite(wasSun) || castsSprite(wasLamp))) ShadowCaster.active[i] = sprite ? 1 : 0;
  if ((castsVolume(wasSun) || castsVolume(wasLamp)) && !castsVolume(nowSun) && !castsVolume(nowLamp) && holdsVolume(i)) {
    casterVolume(caster).clear();
  }
  if (nowSun !== CAST_KIND.WALL && nowLamp !== CAST_KIND.WALL && entityWith(caster, 'LightOccluder') !== null) {
    LightOccluder.active[i] = 0;
  }
  return caster;
}

/** A frame of the atlas cast instead of the sprite (needs config.lighting.shadowTextures): setSprite({ frame }), setTexture. */
function writeFrame(i, name, anchorX, anchorY, scaleX, scaleY, method) {
  if (!ShadowCaster.texturesEnabled && !ShadowCaster._warnedTextures) {
    ShadowCaster._warnedTextures = true;
    console.warn(`WeedJS: ShadowCaster.${method} needs config.lighting.shadowTextures: true`);
  }
  const id = resolveMeshTextureId(name);
  ShadowCaster.textureId[i] = id === MESH_NO_TEXTURE ? 0 : id + 1;
  ShadowCaster.textureScaleX[i] = scaleX;
  ShadowCaster.textureScaleY[i] = scaleY;
  ShadowCaster.textureAnchorX[i] = anchorX;
  ShadowCaster.textureAnchorY[i] = anchorY;
}

/**
 * The silhouette's options: the entity's, for every light kind that casts its sprite. Each one left out is the default: the
 * sprite's own frame and scale, its foot at the sprite's anchor, its height, facing the light. A value that is not finite warns
 * and changes nothing (false).
 */
function writeSprite(i, { frame, anchorX = 0, anchorY = 0, scaleX = 0, scaleY = 0, heightScale = 1, orient = 'light' } = {}) {
  if (![anchorX, anchorY, scaleX, scaleY, heightScale].every(Number.isFinite) || heightScale < 0) {
    warnOnce('shadowCaster.setSprite needs finite anchors and scales, and a heightScale of 0 or more');
    return false;
  }
  if (orient !== 'light' && orient !== 'fixed') warnOnce(`shadowCaster.setSprite: orient is 'light' or 'fixed', not '${orient}'`);
  if (frame != null) writeFrame(i, frame, NaN, NaN, scaleX, scaleY, 'setSprite({ frame })');
  else ShadowCaster.textureId[i] = 0;
  ShadowCaster.anchorOffsetX[i] = anchorX;
  ShadowCaster.anchorOffsetY[i] = anchorY;
  ShadowCaster.heightMultiplier[i] = heightScale;
  ShadowCaster.orient[i] = orient === 'fixed' ? 1 : 0;
  return true;
}

/**
 * One light kind's setters (shadowCaster.sun, shadowCaster.lamps; the instance's own setters are both kinds'): they write that
 * kind alone, and return the ShadowCaster. The sun casts no wall, and the lamps have no volume of their own (shadowCaster.setBox
 * gives one to every light): those warn.
 */
class CastSide {
  constructor(caster, sun, lamps) {
    this._caster = caster;
    this._sun = sun;
    this._lamps = lamps;
  }

  /**
   * The silhouette: a card standing on its base, the frame the light sees (the default for one view).
   * @param {{ frame?: string, anchorX?: number, anchorY?: number, scaleX?: number, scaleY?: number, heightScale?: number,
   *   orient?: 'light'|'fixed' }} [options] frame: another frame of the atlas (was setTexture; needs
   *   config.lighting.shadowTextures), scaleX/scaleY its scale (0 the sprite's); anchorX/anchorY: the foot moved from the
   *   sprite's anchor, in fractions of the sprite (were anchorOffsetX/Y); heightScale: the shadow's length (was
   *   heightMultiplier); orient 'fixed': the card along the object (a fence, a wall)
   */
  setSprite(options) {
    if (!writeSprite(this._caster.index, options)) return this._caster;
    return writeKinds(this._caster, this._sun, this._lamps, CAST_KIND.SPRITE);
  }

  /** Each pixel where it is in 3D (needs the sheet's heightMap). */
  setHeightMap() {
    const i = this._caster.index;
    if (ShadowCaster.heightMultiplier[i] === 0) ShadowCaster.heightMultiplier[i] = 1;
    return writeKinds(this._caster, this._sun, this._lamps, CAST_KIND.HEIGHT_MAP);
  }

  /** A box, which replaces the volume (ShadowCaster.setBox's arguments). */
  setBox(width, depth, height, options) {
    const volume = this._volume('setBox');
    if (volume !== null) volume.setBox(width, depth, height, options);
    return this._castVolume(volume, CAST_KIND.BOX);
  }

  /** One more level on what the volume has (ShadowCaster.addLevel's arguments). */
  addLevel(outline, bottom, top, topOutline, options) {
    const volume = this._volume('addLevel');
    if (volume !== null) volume.addLevel(outline, bottom, top, topOutline, options);
    return this._castVolume(volume, CAST_KIND.BOX);
  }

  /** The convex volume around points, which replaces the volume (ShadowCaster.setHull's arguments). */
  setHull(points, options) {
    const volume = this._volume('setHull');
    if (volume !== null) volume.setHull(points, options);
    return this._castVolume(volume, CAST_KIND.HULL);
  }

  /**
   * A wall that stops lamps and headlights (raycasted lighting): the entity's LightOccluder, cut by its Collider ('collider',
   * the fastest) or by the sprite's alpha ('sprite'), taking out the caster's opacity of the light.
   * @param {{ shape?: 'collider'|'sprite' }} [options]
   */
  setWall({ shape = 'collider' } = {}) {
    const caster = this._caster;
    if (!this._lamps) {
      warnOnce('shadowCaster.sun.setWall: the sun casts no wall (a wall stops lamps and headlights); shadowCaster.lamps.setWall');
      return caster;
    }
    if (entityWith(caster, 'LightOccluder') === null) {
      warnOnce("shadowCaster.setWall needs LightOccluder in the class's components: the wall is its occluder");
      return caster;
    }
    if (shape !== 'collider' && shape !== 'sprite') warnOnce(`shadowCaster.setWall: shape is 'collider' or 'sprite', not '${shape}'`);
    const i = caster.index;
    LightOccluder.maskMode[i] = shape === 'sprite' ? LIGHT_OCCLUDER_MASK_SPRITE : LIGHT_OCCLUDER_MASK_COLLIDER;
    LightOccluder.block[i] = ShadowCaster.opacity[i];
    writeKinds(caster, this._sun, this._lamps, CAST_KIND.WALL);
    LightOccluder.active[i] = 1;
    return caster;
  }

  /** No shadow from this light kind. */
  clear() {
    return writeKinds(this._caster, this._sun, this._lamps, CAST_KIND.NONE);
  }

  /**
   * The caster's volume, or null (warned once): the lamps have no volume of their own, or the scene keeps no room for volumes
   * (config.lighting.maxVolumes: the layer and the mesh arena's share are made at load).
   */
  _volume(method) {
    if (!this._sun) {
      warnOnce(`shadowCaster.lamps.${method}: the lamps have no volume of their own; shadowCaster.${method} gives one to every light`);
      return null;
    }
    if (VolumeShadowCaster.floorScaleY == null || VolumeShadowCaster.layerBit() === 0) {
      warnOnce(
        `shadowCaster.${method}: the scene keeps no room for volumes; set config.lighting.maxVolumes to the number of ` +
          'entities that hold one at once',
      );
      return null;
    }
    return casterVolume(this._caster);
  }

  /** After a volume setter: the kind, once the entity holds a volume (a refused shape warned and left it as it was). */
  _castVolume(volume, kind) {
    if (volume === null || !holdsVolume(this._caster.index)) return this._caster;
    return writeKinds(this._caster, this._sun, this._lamps, kind);
  }
}

export class ShadowCaster extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 1 while a light kind casts its sprite (the setters keep it): 0 = no sprite rows
    heightMultiplier: Float32Array, // Shadow length multiplier (0=no shadow, 1=normal): setSprite's heightScale
    anchorOffsetX: Float32Array, // Shadow anchor offset X (0-1, relative to sprite size): setSprite's anchorX
    anchorOffsetY: Float32Array, // Shadow anchor offset Y (0-1, relative to sprite size): setSprite's anchorY
    textureId: Uint16Array, // setSprite's frame + 1; 0 = the shadow is the sprite's
    textureScaleX: Float32Array, // 0 = the sprite's scale
    textureScaleY: Float32Array,
    textureAnchorX: Float32Array, // NaN = the sprite's anchor (setTexture's anchors)
    textureAnchorY: Float32Array,
    // DX-CASTER (F9): what it casts for the sun and for the lamps (CAST_KIND, 0 its sheet's default), a card's
    // orientation (0 facing the light, 1 along the object), how much light it takes out (1 by default).
    sunKind: Uint8Array,
    lampKind: Uint8Array,
    orient: Uint8Array,
    opacity: Float32Array,
    // DX-CASTER: the base's radius in px (0 = the measured one, plan §6.2) and whether the object shades itself (SELF_SHADOW,
    // 0 the asset's way). Kept for the 3D shadows; nothing draws them yet.
    baseRadius: Float32Array,
    selfShadow: Uint8Array,
  };

  constructor(index) {
    super(index);
    // DX-CASTER: shadowCaster.sun / .lamps, the setters for one light kind, and the instance's own (both kinds'). Made on first
    // use: most casters never call one (Predator makes 38 000 of these through heightMultiplier).
    this._sunSide = null;
    this._lampSide = null;
    this._bothSides = null;
    // DX-CASTER: the internal VolumeShadowCaster that setBox, addLevel and setHull write through, made on first use.
    this._volumeCaster = null;
  }

  // Static pool tracking (set during initialization)
  static shadowCount = 0;

  /** config.lighting.shadowTextures, for setTexture's and setSprite({ frame })'s warning. */
  static texturesEnabled = false;
  static _warnedTextures = false;

  /**
   * The old setSprite({ frame }): cast this frame's shadow instead of the sprite's, and leave the kinds as they are. A tree whose
   * branches are decorations casts its whole silhouette while its trunk stays the sprite that sorts with people. Needs
   * config.lighting.shadowTextures.
   * @param {string} name a frame of the atlas
   * @param {{ anchorX?: number, anchorY?: number, scaleX?: number, scaleY?: number }} [options] each defaults to the sprite's;
   *   the anchors are the frame's own (setSprite's anchorX/anchorY move the foot from the sprite's anchor instead)
   * @returns {this}
   */
  setTexture(name, { anchorX = NaN, anchorY = NaN, scaleX = 0, scaleY = 0 } = {}) {
    writeFrame(this.index, name, anchorX, anchorY, scaleX, scaleY, 'setTexture');
    return this;
  }

  /** The old setSprite(): back to the sprite's shadow, the kinds as they are. */
  clearTexture() {
    ShadowCaster.textureId[this.index] = 0;
    return this;
  }
}

/** The caster's setters for both light kinds, made on first use. */
function bothSides(caster) {
  const side = caster._bothSides;
  return side != null ? side : (caster._bothSides = new CastSide(caster, true, true));
}

/** The methods ShadowCaster's instances get (installed on the class below the component). */
export const CASTER_METHODS = {
  /** The silhouette, for every light: a card on its base (CastSide.setSprite's options). */
  setSprite(options) {
    return bothSides(this).setSprite(options);
  },

  /** Each pixel where it is in 3D, for every light (needs the sheet's heightMap). */
  setHeightMap() {
    return bothSides(this).setHeightMap();
  },

  /**
   * A box, for every light: a volume on the volumeShadows layer, in the entity's frame (it moves and turns with the entity).
   * Replaces the volume. The scene keeps room for volumes with config.lighting.maxVolumes.
   * @param {number} width along x, the way the entity looks
   * @param {number} depth across it, on the floor
   * @param {number} height screen px
   * @param {{ offsetX?: number, offsetY?: number, topScale?: number, floorScaleY?: number }} [options] the box's centre on
   *   the entity's frame; how much smaller its roof is about it (0: a pyramid); the floor's scale (config.camera's)
   */
  setBox(width, depth, height, options) {
    return bothSides(this).setBox(width, depth, height, options);
  },

  /**
   * One more level on top of what the volume has: a body, a cabin on it, a tank on a roof. Its outline need not be convex.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} outline on the entity's frame
   * @param {number} bottom height of the outline, screen px
   * @param {number} top height of the level's top
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} [topOutline] the top, as many corners; left out, the outline
   * @param {{ floorScaleY?: number }} [options]
   */
  addLevel(outline, bottom, top, topOutline, options) {
    return bothSides(this).addLevel(outline, bottom, top, topOutline, options);
  },

  /**
   * The convex volume around points, for every light: a house from an editor. It runs once, when called. Replaces the
   * volume.
   * @param {ArrayLike<number>|Array<{x:number,y:number,z:number}>} points flat x, y, z (z: height, screen px) or objects
   * @param {{ floorScaleY?: number }} [options]
   */
  setHull(points, options) {
    return bothSides(this).setHull(points, options);
  },

  /**
   * Flat view: it stops the light as a wall (its LightOccluder, so the class lists LightOccluder), and the sun casts nothing
   * from it. `lamps.setWall` keeps the sun's shadow.
   * @param {{ shape?: 'collider'|'sprite' }} [options] what cuts the light: the Collider (default) or the sprite's alpha
   */
  setWall(options) {
    return bothSides(this).setWall(options);
  },

  /** No shadow at all. */
  clear() {
    return bothSides(this).clear();
  },

  get sun() {
    const side = this._sunSide;
    return side != null ? side : (this._sunSide = new CastSide(this, true, false));
  },

  get lamps() {
    const side = this._lampSide;
    return side != null ? side : (this._lampSide = new CastSide(this, false, true));
  },

  /** How much light it takes out, 0 to 1 (was LightOccluder.block, which follows it). The sprite shadows' layer reads it. */
  get opacity() {
    return ShadowCaster.opacity[this.index];
  },
  set opacity(v) {
    const i = this.index;
    const o = Math.max(0, Math.min(1, +v || 0));
    ShadowCaster.opacity[i] = o;
    if (entityWith(this, 'LightOccluder') !== null) LightOccluder.block[i] = o;
  },

  /** The base's radius in px, correcting the measured one; 0 keeps the measured base. Stored: the 3D shadows will read it. */
  get baseRadius() {
    return ShadowCaster.baseRadius[this.index];
  },
  set baseRadius(v) {
    const r = +v;
    ShadowCaster.baseRadius[this.index] = Number.isFinite(r) && r > 0 ? r : 0;
  },

  /**
   * Whether the object shades itself: true, false or 'auto' (the asset's way: a render with a footprint does, one view does
   * not). Stored: DX-SELFSHADOW will read it.
   */
  get selfShadow() {
    const s = ShadowCaster.selfShadow[this.index];
    return s === SELF_SHADOW.ON ? true : s === SELF_SHADOW.OFF ? false : 'auto';
  },
  set selfShadow(v) {
    ShadowCaster.selfShadow[this.index] =
      v === 'auto' || v == null ? SELF_SHADOW.AUTO : !v || v === 'off' ? SELF_SHADOW.OFF : SELF_SHADOW.ON;
  },

  /** What it casts for the sun: 'sprite' | 'heightMap' | 'box' | 'hull' | 'wall' | 'none' (read only). */
  get type() {
    return KIND_NAMES[ShadowCaster.sunKind[this.index]] || 'sprite';
  },
};

// Installed on the prototype: getters and setters as written (Object.assign would call the getters).
Object.defineProperties(ShadowCaster.prototype, Object.getOwnPropertyDescriptors(CASTER_METHODS));
