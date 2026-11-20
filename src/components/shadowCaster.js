// ShadowCaster.js - How an entity casts its shadow, for the sun and for the lamps apart (DX-CASTER, DX_LIGHT3D_PLAN.md §5.5):
// its sprite's silhouette (the default), its height map, a volume or a wall. Shadow pixels are written to the double-buffered
// shadow render queue (not this SoA); the entity SoA says how each entity casts.
//
// A class lists ShadowCaster alone. A volume is an internal VolumeShadowCaster's (a mesh on the volumeShadows layer, with room
// in a scene whose config.lighting.maxVolumes is above 0), and a wall is the internal LightOccluder's columns (the visibility
// sweep reads them, and a scene with config.lighting.walls pools them): ShadowCaster's setters drive both. The
// last setter wins: the sprite rows, a volume or a wall an earlier setter gave the entity go when no light kind casts them any
// more.
//
// E-533: each setter is a static that takes the entity's index (ShadowCaster.setBox(i, w, d, h), ShadowCaster.lamps.setWall(i)),
// and the instance's methods call them. Nothing is kept per instance but the two CastSide objects of shadowCaster.sun and
// .lamps: the volume's work takes the index (VolumeShadowCaster's statics), and whether the entity's class lists MeshRenderer
// comes from its type's component bits.

import { Component } from '../core/component.js';
import { HAS_MESH, typeBitsOf } from '../core/entityTypes.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { LightOccluder } from './lightOccluder.js';
import { MESH_NO_TEXTURE, resolveMeshTextureId } from './meshRenderer.js';
import { SpriteRenderer } from './spriteRenderer.js';
import { Transform } from './transform.js';
import { VolumeShadowCaster, holdsVolume } from './volumeShadowCaster.js';


/**
 * DX-CASTER (plan §5.5, F9): how an entity casts, for the sun and for the lamps apart. AUTO is its sheet's default
 * (meta.shadowCast: a render with a height map casts its solid unless the sheet says 'sprite'). AUTO, SPRITE and HEIGHT_MAP
 * are the sprite rows'; BOX and HULL the volume's (setBox, addLevel, setHull); WALL the LightOccluder's (lamps and
 * headlights, in a scene with config.lighting.walls).
 */
export const CAST_KIND = Object.freeze({ AUTO: 0, SPRITE: 1, HEIGHT_MAP: 2, BOX: 3, HULL: 4, WALL: 5, NONE: 6 });
const KIND_NAMES = ['sprite', 'sprite', 'heightMap', 'box', 'hull', 'wall', 'none'];

/** The selfShadow column: 0 the asset's way (on for a render with a footprint, off for one view), 1 on, 2 off. */
export const SELF_SHADOW = Object.freeze({ AUTO: 0, ON: 1, OFF: 2 });

/** The warnings given, by text: each mistake once. */
const _warned = new Set();

export function resetShadowCasterWarns() {
  _warned.clear();
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

/**
 * Whether the entity's sheet casts its solid for the sun by itself (sheetCastsSolid: a render with height maps whose json does
 * not say `shadowCast.sun: 'sprite'`): Scene marks `castsSolid` on the sheet's proxy at load, and every thread gets the
 * proxies. False with no sheet, or a texture.
 * @param {number} i
 */
function sheetCastsSolidAt(i) {
  const ids = SpriteRenderer.spritesheetId;
  if (ids == null) return false;
  const name = SpriteSheetRegistry.getSpritesheetName(ids[i]);
  const sheet = name !== null ? SpriteSheetRegistry.spritesheets.get(name) : undefined;
  return sheet != null && sheet.castsSolid === true;
}

/** Whether the scene has walls: config.lighting.walls pools LightOccluder's columns, which the visibility sweep reads. */
function wallsOn() {
  return LightOccluder.active != null;
}

/**
 * Whether entity i's class lists MeshRenderer: the row its volume draws with is then its own (VolumeShadowCaster's ownMesh).
 * From its type's component bits (entityTypes.js), so a static needs no instance.
 * @param {number} i
 */
function ownsMesh(i) {
  const types = Transform.entityType;
  return types != null && (typeBitsOf(types[i]) & HAS_MESH) !== 0;
}

/**
 * Writes `kind` for the sun, the lamps or both, and keeps what casts in step with the kinds. The sprite rows (`active`: pre-render's
 * emit gives a caster at 0 no shadow height, so no row) and a volume go when no kind casts them any more, and the rows come back on
 * that change alone, so a setter on a despawned entity does not wake it. The wall goes whenever no kind is a wall; setWall turns
 * it on.
 */
function writeKinds(i, sun, lamps, kind) {
  const wasSun = ShadowCaster.sunKind[i];
  const wasLamp = ShadowCaster.lampKind[i];
  const nowSun = sun ? kind : wasSun;
  const nowLamp = lamps ? kind : wasLamp;
  ShadowCaster.sunKind[i] = nowSun;
  ShadowCaster.lampKind[i] = nowLamp;
  const sprite = castsSprite(nowSun) || castsSprite(nowLamp);
  if (sprite !== (castsSprite(wasSun) || castsSprite(wasLamp))) ShadowCaster.active[i] = sprite ? 1 : 0;
  if ((castsVolume(wasSun) || castsVolume(wasLamp)) && !castsVolume(nowSun) && !castsVolume(nowLamp) && holdsVolume(i)) {
    VolumeShadowCaster.clear(i, ownsMesh(i));
  }
  if (nowSun !== CAST_KIND.WALL && nowLamp !== CAST_KIND.WALL && wallsOn()) LightOccluder.active[i] = 0;
}

/**
 * A spawn restored from a save (SaveGame writes the ShadowCaster's columns after onSpawned): the wall follows the kinds and the
 * opacity it brought back. The wall's shape (collider or sprite) is what onSpawned gave it.
 * @param {number} i
 */
export function restoreCasterWall(i) {
  if (!wallsOn() || ShadowCaster.sunKind == null) return;
  const wall = ShadowCaster.sunKind[i] === CAST_KIND.WALL || ShadowCaster.lampKind[i] === CAST_KIND.WALL;
  LightOccluder.active[i] = wall ? 1 : 0;
  if (wall) LightOccluder.block[i] = ShadowCaster.opacity[i];
}

/** A spawned slot: no wall, blocking all the light (setWall writes them again). */
export function resetCasterWall(i) {
  if (!wallsOn()) return;
  LightOccluder.active[i] = 0;
  LightOccluder.block[i] = 1;
}

/**
 * setSprite({ frame }): a frame of the atlas cast instead of the sprite, with its own anchor (NaN: the sprite's) and scale (0:
 * the sprite's). Pre-render swaps it into the caster rows the frames it finds one in use (N-188: its caster scan; those
 * frames take the full rows).
 */
function writeFrame(i, name, anchorX, anchorY, scaleX, scaleY) {
  const id = resolveMeshTextureId(name);
  ShadowCaster.textureId[i] = id === MESH_NO_TEXTURE ? 0 : id + 1;
  ShadowCaster.textureScaleX[i] = scaleX;
  ShadowCaster.textureScaleY[i] = scaleY;
  ShadowCaster.textureAnchorX[i] = anchorX;
  ShadowCaster.textureAnchorY[i] = anchorY;
}

/**
 * The silhouette's options: the entity's, for every light kind that casts its sprite. Each one left out is the default: the
 * sprite's own frame and scale, its foot at the sprite's anchor, its height, facing the light. With `frame`, `anchorX` and
 * `anchorY` are that frame's own anchor (0 to 1 of it), as setTexture took them; without one they move the foot from the
 * sprite's anchor, in fractions of the sprite (the anchorOffsetX/Y columns: the shadow shaders add them to the row's anchor).
 * A value that is not finite warns and changes nothing (false).
 */
function writeSprite(i, { frame, anchorX, anchorY, scaleX = 0, scaleY = 0, heightScale = 1, orient = 'light' } = {}) {
  const ownFrame = frame != null;
  const ax = anchorX === undefined ? (ownFrame ? NaN : 0) : anchorX;
  const ay = anchorY === undefined ? (ownFrame ? NaN : 0) : anchorY;
  const given = [anchorX ?? 0, anchorY ?? 0, scaleX, scaleY, heightScale];
  if (!given.every(Number.isFinite) || heightScale < 0) {
    warnOnce('shadowCaster.setSprite needs finite anchors and scales, and a heightScale of 0 or more');
    return false;
  }
  if (orient !== 'light' && orient !== 'fixed') warnOnce(`shadowCaster.setSprite: orient is 'light' or 'fixed', not '${orient}'`);
  if (ownFrame) {
    writeFrame(i, frame, ax, ay, scaleX, scaleY);
    ShadowCaster.anchorOffsetX[i] = 0;
    ShadowCaster.anchorOffsetY[i] = 0;
  } else {
    ShadowCaster.textureId[i] = 0;
    ShadowCaster.anchorOffsetX[i] = ax;
    ShadowCaster.anchorOffsetY[i] = ay;
  }
  ShadowCaster.heightMultiplier[i] = heightScale;
  ShadowCaster.orient[i] = orient === 'fixed' ? 1 : 0;
  return true;
}

/** The silhouette for the light kinds (CastSide.setSprite's options); options that warn leave everything as it was. */
function castSprite(i, sun, lamps, options) {
  if (writeSprite(i, options)) writeKinds(i, sun, lamps, CAST_KIND.SPRITE);
}

/** Each pixel where it is in 3D, for the light kinds (needs the sheet's heightMap). */
function castHeightMap(i, sun, lamps) {
  if (ShadowCaster.heightMultiplier[i] === 0) ShadowCaster.heightMultiplier[i] = 1;
  writeKinds(i, sun, lamps, CAST_KIND.HEIGHT_MAP);
}

/**
 * Whether a volume setter may give the entity a volume; false warned once: the lamps have no volume of their own, or the scene
 * keeps no room for volumes (config.lighting.maxVolumes: the layer and the mesh arena's share are made at load).
 */
function volumeAllowed(sun, method) {
  if (!sun) {
    warnOnce(`shadowCaster.lamps.${method}: the lamps have no volume of their own; shadowCaster.${method} gives one to every light`);
    return false;
  }
  if (VolumeShadowCaster.floorScaleY == null || VolumeShadowCaster.layerBit() === 0) {
    warnOnce(
      `shadowCaster.${method}: the scene keeps no room for volumes; set config.lighting.maxVolumes to the number of ` +
        'entities that hold one at once',
    );
    return false;
  }
  return true;
}

/** After a volume setter: the kind, once the entity holds a volume (a refused shape warned and left it as it was). */
function castVolume(i, sun, lamps, kind) {
  if (holdsVolume(i)) writeKinds(i, sun, lamps, kind);
}

function castBox(i, sun, lamps, width, depth, height, options) {
  if (!volumeAllowed(sun, 'setBox')) return;
  VolumeShadowCaster.setBox(i, ownsMesh(i), width, depth, height, options);
  castVolume(i, sun, lamps, CAST_KIND.BOX);
}

function castLevel(i, sun, lamps, outline, bottom, top, topOutline, options) {
  if (!volumeAllowed(sun, 'addLevel')) return;
  VolumeShadowCaster.addLevel(i, ownsMesh(i), outline, bottom, top, topOutline, options);
  castVolume(i, sun, lamps, CAST_KIND.BOX);
}

function castHull(i, sun, lamps, points, options) {
  if (!volumeAllowed(sun, 'setHull')) return;
  VolumeShadowCaster.setHull(i, ownsMesh(i), points, options);
  castVolume(i, sun, lamps, CAST_KIND.HULL);
}

/**
 * A wall that stops lamps and headlights (a scene with config.lighting.walls): the entity's occluder, its Collider's outline,
 * as tall as the world, taking out the caster's opacity of the light; the wall's own sprite stays lit where the light
 * reaches its edge. A scene without walls warns once and changes nothing.
 */
function castWall(i, sun, lamps) {
  if (!lamps) {
    warnOnce('shadowCaster.sun.setWall: the sun casts no wall (a wall stops lamps and headlights); shadowCaster.lamps.setWall');
    return;
  }
  if (!wallsOn()) {
    warnOnce(
      'shadowCaster.setWall: a wall stops lamps and headlights in a scene that asks for walls (config.lighting.walls: true, ' +
        'with lighting enabled), which this scene does not; the entity casts as it did',
    );
    return;
  }
  LightOccluder.block[i] = ShadowCaster.opacity[i];
  writeKinds(i, sun, lamps, CAST_KIND.WALL);
  LightOccluder.active[i] = 1;
}

/**
 * E-533: one light kind's setters by entity index, ShadowCaster.sun and ShadowCaster.lamps (ShadowCaster.lamps.setWall(i)):
 * they write that kind alone. The sun casts no wall, and the lamps have no volume of their own (ShadowCaster.setBox gives one
 * to every light): those warn. An instance's shadowCaster.sun and .lamps call them.
 */
class CastSideByIndex {
  constructor(sun, lamps) {
    this._sun = sun;
    this._lamps = lamps;
  }

  /** The silhouette for this light kind (CastSide.setSprite's options). */
  setSprite(i, options) {
    castSprite(i, this._sun, this._lamps, options);
  }

  /** Each pixel where it is in 3D, for this light kind (needs the sheet's heightMap). */
  setHeightMap(i) {
    castHeightMap(i, this._sun, this._lamps);
  }

  /** A box for this light kind, which replaces the volume (ShadowCaster.setBox's arguments after the index). */
  setBox(i, width, depth, height, options) {
    castBox(i, this._sun, this._lamps, width, depth, height, options);
  }

  /** One more level on what the volume has (ShadowCaster.addLevel's arguments after the index). */
  addLevel(i, outline, bottom, top, topOutline, options) {
    castLevel(i, this._sun, this._lamps, outline, bottom, top, topOutline, options);
  }

  /** The convex volume around points, which replaces the volume (ShadowCaster.setHull's arguments after the index). */
  setHull(i, points, options) {
    castHull(i, this._sun, this._lamps, points, options);
  }

  /** A wall for this light kind (lamps.setWall; the sun casts none). */
  setWall(i, options) {
    castWall(i, this._sun, this._lamps, options);
  }

  /** No shadow from this light kind. */
  clear(i) {
    writeKinds(i, this._sun, this._lamps, CAST_KIND.NONE);
  }
}

const SUN_BY_INDEX = new CastSideByIndex(true, false);
const LAMPS_BY_INDEX = new CastSideByIndex(false, true);

/**
 * One light kind's setters on an instance (shadowCaster.sun, shadowCaster.lamps; the instance's own setters are both kinds',
 * written without one of these): ShadowCaster.sun's or .lamps' with the caster's index, and they return the ShadowCaster.
 */
class CastSide {
  constructor(caster, side) {
    this._caster = caster;
    this._side = side;
  }

  /**
   * The silhouette: a card standing on its base, the frame the light sees (the default for one view).
   * @param {{ frame?: string, anchorX?: number, anchorY?: number, scaleX?: number, scaleY?: number, heightScale?: number,
   *   orient?: 'light'|'fixed' }} [options] frame: another frame of the atlas as the silhouette (the
   *   frames one is in use take pre-render's full caster rows), with scaleX/scaleY (0: the sprite's) and anchorX/anchorY its own anchor (0 to 1 of
   *   it; left out, the sprite's); without a frame, anchorX/anchorY move the foot from the sprite's anchor, in fractions of
   *   the sprite (rare: baseRadius corrects the measured base); heightScale: the card's height, times (0: no shadow);
   *   orient 'fixed': the card along the object (a fence, a wall)
   */
  setSprite(options) {
    this._side.setSprite(this._caster.index, options);
    return this._caster;
  }

  /** Each pixel where it is in 3D (needs the sheet's heightMap). */
  setHeightMap() {
    this._side.setHeightMap(this._caster.index);
    return this._caster;
  }

  /** A box, which replaces the volume (ShadowCaster.setBox's arguments). */
  setBox(width, depth, height, options) {
    this._side.setBox(this._caster.index, width, depth, height, options);
    return this._caster;
  }

  /** One more level on what the volume has (ShadowCaster.addLevel's arguments). */
  addLevel(outline, bottom, top, topOutline, options) {
    this._side.addLevel(this._caster.index, outline, bottom, top, topOutline, options);
    return this._caster;
  }

  /** The convex volume around points, which replaces the volume (ShadowCaster.setHull's arguments). */
  setHull(points, options) {
    this._side.setHull(this._caster.index, points, options);
    return this._caster;
  }

  /**
   * A wall for this light kind (lamps.setWall; the sun casts none): castWall.
   * @param {{ shape?: 'collider'|'sprite' }} [options]
   */
  setWall(options) {
    this._side.setWall(this._caster.index, options);
    return this._caster;
  }

  /** No shadow from this light kind. */
  clear() {
    this._side.clear(this._caster.index);
    return this._caster;
  }
}

export class ShadowCaster extends Component {
  // The silhouette's columns hold setSprite's options: the API is setSprite (pre-render and Pixi read the columns).
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 1 while a light kind casts its sprite (the setters keep it): 0 = no sprite rows
    heightMultiplier: Float32Array, // setSprite's heightScale: the card's height, times (0 = no shadow, 1 at spawn)
    anchorOffsetX: Float32Array, // setSprite's anchorX without a frame: the foot moved from the sprite's anchor (0-1 of it)
    anchorOffsetY: Float32Array, // setSprite's anchorY without a frame
    textureId: Uint16Array, // setSprite's frame + 1; 0 = the shadow is the sprite's
    textureScaleX: Float32Array, // setSprite's scaleX with a frame; 0 = the sprite's scale
    textureScaleY: Float32Array,
    textureAnchorX: Float32Array, // setSprite's anchorX with a frame: its own anchor; NaN = the sprite's
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
    // DX-CASTER: shadowCaster.sun / .lamps, the setters for one light kind, made on first use. The instance's own setters
    // (both kinds') write without such an object: a crowd of 38 000 that sets a heightScale at spawn makes none.
    this._sunSide = null;
    this._lampSide = null;
  }

  // Static pool tracking (set during initialization)
  static shadowCount = 0;

  /** E-533: the sun's setters by index (ShadowCaster.sun.setSprite(i)): shadowCaster.sun's. */
  static sun = SUN_BY_INDEX;

  /** E-533: the lamps' setters by index (ShadowCaster.lamps.setWall(i)): shadowCaster.lamps'. */
  static lamps = LAMPS_BY_INDEX;

  /**
   * E-533: entity i's silhouette, for every light (shadowCaster.setSprite, by index; CastSide.setSprite's options).
   * @param {number} i
   * @param {object} [options]
   */
  static setSprite(i, options) {
    castSprite(i, true, true, options);
  }

  /** E-533: entity i's solid, for every light (shadowCaster.setHeightMap, by index; needs the sheet's heightMap). */
  static setHeightMap(i) {
    castHeightMap(i, true, true);
  }

  /** E-533: a box for every light (shadowCaster.setBox, by index: its arguments after the index). */
  static setBox(i, width, depth, height, options) {
    castBox(i, true, true, width, depth, height, options);
  }

  /** E-533: one more level on entity i's volume (shadowCaster.addLevel, by index). */
  static addLevel(i, outline, bottom, top, topOutline, options) {
    castLevel(i, true, true, outline, bottom, top, topOutline, options);
  }

  /** E-533: the convex volume around points, for every light (shadowCaster.setHull, by index). */
  static setHull(i, points, options) {
    castHull(i, true, true, points, options);
  }

  /** E-533: entity i as a wall for the lamps, casting nothing for the sun (shadowCaster.setWall, by index). */
  static setWall(i, options) {
    castWall(i, true, true, options);
  }

  /** E-533: no shadow at all from entity i (shadowCaster.clear, by index). */
  static clear(i) {
    writeKinds(i, true, true, CAST_KIND.NONE);
  }

  /** E-533: entity i's opacity, 0 to 1 (shadowCaster.opacity, by index): its wall's block with it. */
  static setOpacity(i, value) {
    const o = Math.max(0, Math.min(1, +value || 0));
    ShadowCaster.opacity[i] = o;
    if (wallsOn()) LightOccluder.block[i] = o;
  }

  /** E-533: entity i's base radius in px (shadowCaster.baseRadius, by index); 0, or one that is not finite, the measured one. */
  static setBaseRadius(i, value) {
    const r = +value;
    ShadowCaster.baseRadius[i] = Number.isFinite(r) && r > 0 ? r : 0;
  }

  /** E-533: whether entity i shades itself: true, false or 'auto' (shadowCaster.selfShadow, by index). */
  static setSelfShadow(i, value) {
    ShadowCaster.selfShadow[i] =
      value === 'auto' || value == null ? SELF_SHADOW.AUTO : !value || value === 'off' ? SELF_SHADOW.OFF : SELF_SHADOW.ON;
  }
}

/**
 * The members that left the API (DX-CASTER, plan §5.5's migration table; no back compat), each with what replaces it. On the
 * prototype, so the columns of the same names (which pre-render and Pixi read) get no accessor: reading or writing one warns
 * once and does nothing, and a call returns the ShadowCaster.
 */
const GONE_FIELDS = {
  heightMultiplier: 'setSprite({ heightScale })',
  anchorOffsetX: 'baseRadius (it corrects the measured base), or setSprite({ anchorX }) for a rare case',
  anchorOffsetY: 'baseRadius (it corrects the measured base), or setSprite({ anchorY }) for a rare case',
};
const GONE_METHODS = {
  setTexture: 'setSprite({ frame, anchorX, anchorY, scaleX, scaleY })',
  clearTexture: 'setSprite()',
};
for (const [name, instead] of Object.entries(GONE_FIELDS)) {
  const text = `shadowCaster.${name} is gone: ${instead}`;
  Object.defineProperty(ShadowCaster.prototype, name, {
    get() {
      warnOnce(text);
      return undefined;
    },
    set(_value) {
      warnOnce(text);
    },
    configurable: true,
  });
}
for (const [name, instead] of Object.entries(GONE_METHODS)) {
  const text = `shadowCaster.${name} is gone: ${instead}`;
  Object.defineProperty(ShadowCaster.prototype, name, {
    value() {
      warnOnce(text);
      return this;
    },
    writable: true,
    configurable: true,
  });
}

/** The methods ShadowCaster's instances get (installed on the class below the component). */
export const CASTER_METHODS = {
  /** The silhouette, for every light: a card on its base (CastSide.setSprite's options). */
  setSprite(options) {
    ShadowCaster.setSprite(this.index, options);
    return this;
  },

  /** Each pixel where it is in 3D, for every light (needs the sheet's heightMap). */
  setHeightMap() {
    ShadowCaster.setHeightMap(this.index);
    return this;
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
    ShadowCaster.setBox(this.index, width, depth, height, options);
    return this;
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
    ShadowCaster.addLevel(this.index, outline, bottom, top, topOutline, options);
    return this;
  },

  /**
   * The convex volume around points, for every light: a house from an editor. It runs once, when called. Replaces the
   * volume.
   * @param {ArrayLike<number>|Array<{x:number,y:number,z:number}>} points flat x, y, z (z: height, screen px) or objects
   * @param {{ floorScaleY?: number }} [options]
   */
  setHull(points, options) {
    ShadowCaster.setHull(this.index, points, options);
    return this;
  },

  /**
   * With config.lighting.walls: it stops lamps and headlights as a wall, and the sun casts nothing from it. `lamps.setWall`
   * keeps the sun's shadow. Its light finds the wall through the spatial grid, so the entity has a Collider.
   * @param {{ shape?: 'collider'|'sprite' }} [options] what cuts the light: the Collider (default) or the sprite's alpha
   */
  setWall(options) {
    ShadowCaster.setWall(this.index, options);
    return this;
  },

  /** No shadow at all. */
  clear() {
    ShadowCaster.clear(this.index);
    return this;
  },

  get sun() {
    const side = this._sunSide;
    return side != null ? side : (this._sunSide = new CastSide(this, SUN_BY_INDEX));
  },

  get lamps() {
    const side = this._lampSide;
    return side != null ? side : (this._lampSide = new CastSide(this, LAMPS_BY_INDEX));
  },

  /** How much light it takes out, 0 to 1: the layer shadows read it, and a wall (setWall) takes that much out of a lamp. */
  get opacity() {
    return ShadowCaster.opacity[this.index];
  },
  set opacity(v) {
    ShadowCaster.setOpacity(this.index, v);
  },

  /** The base's radius in px, correcting the measured one; 0 keeps the measured base. Stored: the 3D shadows will read it. */
  get baseRadius() {
    return ShadowCaster.baseRadius[this.index];
  },
  set baseRadius(v) {
    ShadowCaster.setBaseRadius(this.index, v);
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
    ShadowCaster.setSelfShadow(this.index, v);
  },

  /**
   * What it casts for the sun: 'sprite' | 'heightMap' | 'box' | 'hull' | 'wall' | 'none' (read only). With nothing set
   * (CAST_KIND.AUTO) it is what its sheet casts: 'heightMap' for a render that casts its solid, else 'sprite'.
   */
  get type() {
    const i = this.index;
    const kind = ShadowCaster.sunKind[i];
    if (kind === CAST_KIND.AUTO) return sheetCastsSolidAt(i) ? 'heightMap' : 'sprite';
    return KIND_NAMES[kind] || 'sprite';
  },
};

// Installed on the prototype: getters and setters as written (Object.assign would call the getters).
Object.defineProperties(ShadowCaster.prototype, Object.getOwnPropertyDescriptors(CASTER_METHODS));
