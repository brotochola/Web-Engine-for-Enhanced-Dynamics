// classThumbs.js — the palette's picture of each entity class (VISUAL_EDITOR_PLAN.md ED-65), so that a class reads as
// what it looks like and not only by its name. The first frame of, in order:
// 1. what a live entity of the class shows: its SpriteRenderer's static sprite, or the animation of its spritesheet,
//    stretched as its scale stretches it and with its tint (the platformer's platforms are a tinted bar, littleCity's
//    houses one of their 63 houses: whichever is live first);
// 2. its spawnParams' sprite or animation default, resolved as the inspector's picker resolves it (assetPicker.js);
// 3. a plain mark: the class's initials on a color of its own.
//
// Cost: a class's picture is drawn once, into a canvas made once per class and scene. A class that shows its mark is
// tried again (retry) when the palette refreshes and a few times after the scene starts, until something of it shows:
// one pass over its pool's slots, a few array reads each, never per frame. A class with a picture is not drawn again.

import { Transform } from '../../../components/transform.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { describeSpawnParams, KIND_SPRITE, KIND_ANIMATION } from '../../spawnParams.js';
import { AssetCatalog } from './assetPicker.js';
import { spriteFrameOf, drawAtlasFrame, NO_TINT } from './atlasThumb.js';

/** The picture's size in CSS pixels. */
export const CLASS_THUMB_SIZE = 32;

/** Where a class's picture comes from: its mark (no picture yet), a param's default, a live entity. */
export const PICTURE_MARK = 0;
export const PICTURE_PARAM = 1;
export const PICTURE_LIVE = 2;

const THUMB_STYLE =
  `width:${CLASS_THUMB_SIZE}px;height:${CLASS_THUMB_SIZE}px;flex:none;border-radius:4px;` +
  'background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 8px 8px';

/**
 * What a class's picture shows: where it comes from, the atlas frame, and for a live entity its scale and tint.
 * @typedef {{ source: number, frame: string|null, scaleX: number, scaleY: number, tint: number, index: number }} ClassPicture
 */

/**
 * A live entity of the class that draws a frame the atlas has: active, its SpriteRenderer on and visible, with a sheet
 * (a static sprite, or a spritesheet's animation). Its picture, or null when none of the class's pool draws one.
 * @param {Function} EntityClass - a registered class: startIndex, poolSize (endIndex)
 * @returns {ClassPicture|null}
 */
export function livePictureOf(EntityClass) {
  const active = Transform.active;
  const on = SpriteRenderer.active;
  const sheets = SpriteRenderer.spritesheetId;
  if (!active || !on || !sheets) return null;
  const visible = SpriteRenderer.renderVisible;
  const animations = SpriteRenderer.animationState;
  const start = EntityClass.startIndex | 0;
  const end = Math.min(EntityClass.endIndex ?? start + (EntityClass.poolSize | 0), active.length);
  for (let i = start; i < end; i++) {
    if (active[i] !== 1 || on[i] !== 1 || sheets[i] === 0 || (visible && visible[i] === 0)) continue;
    const frame = spriteFrameOf(sheets[i], animations[i]);
    if (frame === null) continue;
    return {
      source: PICTURE_LIVE,
      frame,
      scaleX: SpriteRenderer.scaleX[i],
      scaleY: SpriteRenderer.scaleY[i],
      tint: SpriteRenderer.baseTint[i],
      index: i,
    };
  }
  return null;
}

/**
 * The first sprite or animation param of the class whose default the scene loaded: that default's first frame.
 * @param {Function} EntityClass
 * @param {AssetCatalog} catalog
 * @returns {string|null}
 */
export function paramFrameOf(EntityClass, catalog) {
  let description;
  try {
    description = describeSpawnParams(EntityClass);
  } catch {
    return null; // malformed: its registration said so
  }
  if (description === null) return null;
  const { kinds, defaults } = description;
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    if (kind !== KIND_SPRITE && kind !== KIND_ANIMATION) continue;
    const frame = catalog.frameOf(kind, defaults[k]);
    if (frame !== null) return frame;
  }
  return null;
}

/**
 * Where a class's picture comes from now: a live entity, else a param's default, else its mark.
 * @param {Function} EntityClass
 * @param {AssetCatalog} catalog
 * @returns {ClassPicture}
 */
export function classPicture(EntityClass, catalog) {
  const live = livePictureOf(EntityClass);
  if (live !== null) return live;
  const frame = paramFrameOf(EntityClass, catalog);
  return { source: frame === null ? PICTURE_MARK : PICTURE_PARAM, frame, scaleX: 1, scaleY: 1, tint: NO_TINT, index: -1 };
}

/**
 * A class's initials: the first letters of the first two words of its name (CityHouse CH, Platform P, enemy_2 E2).
 * @param {string} name
 */
export function initialsOf(name) {
  const words = String(name).match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g);
  if (words === null) return '?';
  return (words[0][0] + (words.length > 1 ? words[1][0] : '')).toUpperCase();
}

/** A muted color of the name's own, the same in every scene. */
export function markColor(name) {
  let hash = 0;
  for (let k = 0; k < name.length; k++) hash = (Math.imul(hash, 31) + name.charCodeAt(k)) | 0;
  return `hsl(${(hash >>> 0) % 360}, 32%, 34%)`;
}

/**
 * The plain mark: the class's initials on its color, filling the canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {string} name
 */
export function drawClassMark(canvas, name) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = markColor(name);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `600 ${Math.round(h * 0.4)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initialsOf(name), w / 2, h / 2 + 1);
}

const SOURCE_TITLES = ['no picture yet: none of it is live, and no sprite param of it names one', 'its sprite param’s default', 'as a live one shows it'];

/** A class's picture in the palette: its canvas, and where what it shows came from. */
export class ClassThumb {
  /** @param {Function} EntityClass */
  constructor(EntityClass) {
    this.name = EntityClass.name;
    this.EntityClass = EntityClass;
    /** PICTURE_MARK until a picture is drawn. */
    this.source = PICTURE_MARK;
    /** The atlas frame it shows, or null. */
    this.frame = null;
    const ratio = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
    const px = Math.round(CLASS_THUMB_SIZE * Math.min(3, Math.max(1, ratio)));
    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.cssText = THUMB_STYLE;
    this.canvas.dataset.thumb = '';
  }
}

/** The pictures of the running scene's classes: each made and drawn once, the marks drawn again once they can show more. */
export class ClassThumbs {
  /** @param {() => object|null} sceneOf - the running scene (its atlas: bigAtlasCanvas, bigAtlasJson) */
  constructor(sceneOf) {
    this._sceneOf = sceneOf;
    this._catalog = new AssetCatalog(sceneOf);
    /** The scene the pictures are of: another one makes them anew. */
    this._scene = null;
    /** @type {Map<string, ClassThumb>} */
    this._byName = new Map();
  }

  /**
   * A class's picture: made and drawn the first time it is asked for in the running scene, the same canvas after.
   * @param {Function} EntityClass
   * @returns {ClassThumb}
   */
  get(EntityClass) {
    const scene = this._sceneOf();
    if (scene !== this._scene) {
      this._scene = scene;
      this._byName.clear();
    }
    let thumb = this._byName.get(EntityClass.name);
    if (thumb === undefined || thumb.EntityClass !== EntityClass) {
      thumb = new ClassThumb(EntityClass);
      this._byName.set(thumb.name, thumb);
      this._draw(thumb, scene, true);
      thumb.canvas.title = `${thumb.name}: ${SOURCE_TITLES[thumb.source]}`;
    }
    return thumb;
  }

  /**
   * Draw again each class that shows its mark and can show a picture now (one of it went live, the atlas came in).
   * The others are left as they are.
   * @returns {number} how many still show their mark
   */
  retry() {
    const scene = this._sceneOf();
    if (scene !== this._scene) return 0; // made anew on the next get
    let marks = 0;
    for (const thumb of this._byName.values()) {
      if (thumb.source !== PICTURE_MARK) continue;
      if (this._draw(thumb, scene, false)) thumb.canvas.title = `${thumb.name}: ${SOURCE_TITLES[thumb.source]}`;
      else marks++;
    }
    return marks;
  }

  /**
   * Draw the class's picture when it has one now. Else its mark: when `mark` (the first drawing), or when the atlas
   * lacked the frame (drawAtlasFrame cleared the canvas); a mark already drawn is left as it is.
   * @returns {boolean} whether a picture was drawn
   */
  _draw(thumb, scene, mark) {
    const picture = classPicture(thumb.EntityClass, this._catalog);
    if (picture.source !== PICTURE_MARK) {
      if (drawAtlasFrame(thumb.canvas, scene, picture.frame, picture.scaleX, picture.scaleY, picture.tint)) {
        thumb.source = picture.source;
        thumb.frame = picture.frame;
        return true;
      }
      mark = true;
    }
    if (mark) drawClassMark(thumb.canvas, thumb.name);
    return false;
  }
}
