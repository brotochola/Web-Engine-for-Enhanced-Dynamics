// assetPicker.js — the editor's field for a `sprite` or `animation` spawn param (VISUAL_EDITOR_PLAN.md D4, ED-45): a
// text field whose suggestions are what the running scene loaded (a datalist: typing filters it, and any name can
// still be typed), with a thumbnail of the name's first frame beside it, drawn from the scene's atlas into a small
// canvas when the name changes, never per frame. A name the scene did not load is marked. The thumbnail is a button:
// it opens the scene's pictures as a grid to pick from (pictureGrid.js, ED-76).
//
// - sprite: a texture's name, for setSprite: the atlas's entries (the scene's images, each spritesheet's animations
//   as `sheet_animation`), the engine's own (`_white`, …) last.
// - animation: an animation's name, for setAnimation: the animations of the scene's spritesheets, each once, with the
//   sheets that have it. The param holds only the name; the sheet is the one the class sets in its code.
//
// The lists are made once per atlas (a full load registers another), and so is each kind's datalist, which every field
// of the kind names and the last one built holds: a selection change builds the field alone (littleCity's atlas has
// 1,158 names). A pick from the list or the grid commits at once; typing commits when the field is left, as the other
// text fields do. The palette's class pictures (classThumbs.js, ED-65) resolve a sprite param's default through the
// same catalog.

import { SpriteSheetRegistry, isBigAtlasChunk } from '../../spriteSheetRegistry.js';
import { KIND_ANIMATION } from '../../spawnParams.js';
import { drawAtlasFrame } from './atlasThumb.js';
import { togglePictureGrid } from './pictureGrid.js';

/** The thumbnail's size, px. */
export const THUMB_SIZE = 28;

const FIELD_STYLE =
  'font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;min-width:0;box-sizing:border-box';
const THUMB_STYLE =
  `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;display:block;border-radius:2px;` +
  'background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 8px 8px';
const PICK_STYLE =
  'flex:none;display:block;padding:0;margin:0;line-height:0;background:none;cursor:pointer;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
const PICK_HOVER = '#60a5fa';

/** A field with no options: no None in the grid, nothing shown to open on. */
const NO_OPTIONS = Object.freeze({});

/** What the running scene loaded, for the pickers: names, and the atlas frame each shows first. */
export class AssetCatalog {
  /** @param {() => object|null} sceneOf - the running scene (its atlas: bigAtlasCanvas, bigAtlasJson) */
  constructor(sceneOf) {
    this._sceneOf = sceneOf;
    /** The registry's atlas entry the lists were made from. */
    this._atlas = null;
    this._sprites = [];
    this._spriteSet = new Set();
    /** @type {[string, string][]} animation name, the sheets that have it */
    this._animations = [];
    /** Animation name → the atlas animation of its first sheet (`sheet_name`). */
    this._animationEntry = new Map();
    /** Per kind (sprite, animation): the fields' datalist, and the atlas its options are of. */
    this._lists = [null, null];
    this._listsOf = [null, null];
  }

  /** The lists again when another atlas was registered (a full load). */
  _sync() {
    const atlas = SpriteSheetRegistry.spritesheets.get('bigAtlas') ?? null;
    if (atlas === this._atlas) return;
    this._atlas = atlas;
    const names = atlas ? Object.keys(atlas.animations) : [];
    const own = names.filter((name) => !name.startsWith('_'));
    const engine = names.filter((name) => name.startsWith('_'));
    this._sprites = own.concat(engine);
    this._spriteSet = new Set(this._sprites);
    const sheetsOf = new Map();
    this._animationEntry = new Map();
    for (const [sheetName, sheet] of SpriteSheetRegistry.spritesheets) {
      // bigAtlas's chunks (ED-74) are proxy sheets too, but their names are the atlas's sprites.
      if (!sheet || !sheet.isProxy || isBigAtlasChunk(sheetName)) continue;
      for (const name of Object.keys(sheet.animations)) {
        if (!sheetsOf.has(name)) {
          sheetsOf.set(name, []);
          this._animationEntry.set(name, sheet.animations[name].prefixedName);
        }
        sheetsOf.get(name).push(sheetName);
      }
    }
    this._animations = [...sheetsOf].map(([name, sheets]) => [name, sheets.join(', ')]);
  }

  /**
   * The choices for a kind: [name, label] pairs (an animation's label names its sheets).
   * @param {number} kind - KIND_SPRITE or KIND_ANIMATION
   * @returns {[string, string][]}
   */
  options(kind) {
    this._sync();
    return kind === KIND_ANIMATION ? this._animations : this._sprites.map((name) => [name, '']);
  }

  /**
   * The suggestions of a kind's fields: one datalist per kind, its options made once per atlas and moved into each
   * field as it is built, so a selection change makes none. Every field of the kind names it by its id.
   * @param {number} kind - KIND_SPRITE or KIND_ANIMATION
   * @returns {HTMLDataListElement}
   */
  listFor(kind) {
    this._sync();
    const k = kind === KIND_ANIMATION ? 1 : 0;
    let list = this._lists[k];
    if (list === null) {
      list = document.createElement('datalist');
      list.id = `weed-editor-${k === 1 ? 'animation' : 'sprite'}s-${++lists}`;
      this._lists[k] = list;
    }
    if (this._listsOf[k] !== this._atlas) {
      this._listsOf[k] = this._atlas;
      list.textContent = '';
      for (const [name, label] of this.options(kind)) {
        const option = document.createElement('option');
        option.value = name;
        if (label !== '') option.textContent = label;
        list.appendChild(option);
      }
    }
    return list;
  }

  /** Whether the scene loaded `name` as a sprite (or an animation). */
  has(kind, name) {
    this._sync();
    return kind === KIND_ANIMATION ? this._animationEntry.has(name) : this._spriteSet.has(name);
  }

  /** The atlas frame `name` shows first, or null. */
  frameOf(kind, name) {
    this._sync();
    const atlas = this._atlas;
    if (atlas === null || typeof name !== 'string') return null;
    const entry = kind === KIND_ANIMATION ? this._animationEntry.get(name) : this._spriteSet.has(name) ? name : undefined;
    const animation = entry === undefined ? undefined : atlas.animations[entry];
    return animation && animation.frames && animation.frames.length > 0 ? animation.frames[0] : null;
  }

  /**
   * Draw `name`'s first frame into `canvas`, scaled to fit and centered; clear it when there is none.
   * @returns {boolean} whether a frame was drawn
   */
  drawThumbnail(canvas, kind, name) {
    return drawAtlasFrame(canvas, this._sceneOf(), this.frameOf(kind, name));
  }
}

/** Datalists made so far in this page: each catalog's get ids of their own. */
let lists = 0;

/**
 * The field of a sprite or animation param.
 * @param {number} kind - KIND_SPRITE or KIND_ANIMATION
 * @param {string} value - the record's value, or the default
 * @param {(value: string) => void} commit
 * @param {AssetCatalog|null} catalog - null: a plain text field
 * @param {{ none?: boolean, shown?: (kind: number) => string }} [options] - none: the param's default is empty, so
 *   the grid offers None; shown: what the selected entity shows now, which the grid opens on when the value is empty
 * @returns {HTMLElement}
 */
export function assetPickerWidget(kind, value, commit, catalog, options = NO_OPTIONS) {
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:4px;align-items:center;min-width:0';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.spellcheck = false;
  input.style.cssText = `${FIELD_STYLE};flex:1;width:100%`;
  input.onchange = () => commit(input.value);
  if (!catalog) {
    box.appendChild(input);
    return box;
  }
  const what = kind === KIND_ANIMATION ? 'animation' : 'sprite';
  const list = catalog.listFor(kind);
  input.setAttribute('list', list.id);
  if (options.none === true) input.placeholder = '(none: the class picks)';
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_SIZE;
  thumb.height = THUMB_SIZE;
  thumb.style.cssText = THUMB_STYLE;
  // The thumbnail opens the scene's pictures (ED-76).
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.dataset.pictures = '';
  pick.style.cssText = PICK_STYLE;
  pick.appendChild(thumb);
  pick.onmouseenter = () => {
    pick.style.borderColor = PICK_HOVER;
  };
  pick.onmouseleave = () => {
    pick.style.borderColor = '';
  };
  pick.onclick = () =>
    togglePictureGrid({
      anchor: pick,
      kind,
      catalog,
      value: input.value,
      shown: typeof options.shown === 'function' ? options.shown(kind) : '',
      none: options.none === true,
      commit,
    });
  const show = () => {
    const name = input.value;
    const known = name === '' || catalog.has(kind, name);
    input.style.borderColor = known ? '' : '#f87171';
    input.title = known ? `A ${what} the scene loaded: pick one, or type to search` : `${name}: no ${what} of that name in this scene`;
    pick.title = `${name === '' ? `No ${what}` : name}: click to pick from the scene's ${what}s by their pictures`;
    catalog.drawThumbnail(thumb, kind, name);
  };
  input.oninput = (e) => {
    show();
    // A pick from the list replaces the text in one go: an input event of type insertReplacementText (a plain Event
    // in older Chrome), where typing sends insertText and the like. One user action: commit it. Typing commits when
    // the field is left (onchange).
    const replaced = e && (e.inputType === 'insertReplacementText' || e.inputType === undefined);
    if (replaced && catalog.has(kind, input.value)) commit(input.value);
  };
  show();
  box.append(pick, input, list);
  return box;
}
