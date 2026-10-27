// palette.js — the editor's palette (VISUAL_EDITOR_PLAN.md ED-11, ED-65, ED-66): the running scene's entity classes,
// each with a picture of what it looks like (classThumbs.js), how many the open scene file places against its pool,
// and a + that places new ones (each click on the view puts one there, until Esc or + again). A class dragged from
// here onto the view is placed where it drops (dropPlace.js). With more than 8 classes, a field above them filters
// them by name. Above the classes, the level row (ED-38): the scene files of the running one's folder, Open, New and
// Save As; then the scene's layers with hide and lock (editorLayers.js, ED-24), and its Tiled tilemaps with a button
// that loads one again in place (tilemapList.js, ED-26). Shown while edit mode is on. In the editor page (D9) it is
// the Assets dock, shown whether or not edit mode is on: its + and a drop on the view enter edit mode.
//
// Cost: nothing per frame. The class rows are made once per scene and kept: a refresh (a change to the document, a
// swap, the file list, what is being placed) writes only the counts and marks that changed, and draws again only the
// pictures of classes that had none and now have one. The layers and tilemaps are built when the scene changes.

import { TilemapList } from './tilemapList.js';
import { FloatingPanel } from '../ui/floatingPanel.js';
import { ShipRow } from './shipRow.js';
import { ClassThumbs, CLASS_THUMB_SIZE } from './classThumbs.js';
import { DropPlacer, CLASS_DRAG_TYPE } from './dropPlace.js';

/** Classes the editor does not offer: the engine's own helpers. */
const UNPLACEABLE = new Set(['Flash']);

/** From this many classes on, a field filters them. */
const FILTER_FROM = 9;

/**
 * After a scene's rows are made, the classes still without a picture are tried again this long after (ms), one after
 * the other, until each has one: what spawns after the first frames (a refresh and a pointer over the list try too).
 */
const RETRY_MS = Object.freeze([500, 1000, 2000, 4000, 8000]);

/** The layers' and tilemaps' sections, ruled off as the level row above them is. */
const SECTION_STYLE = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1)';
const HEAD_STYLE = 'font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px';

const SELECT_STYLE =
  'flex:1;min-width:0;font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;cursor:pointer';
const FILTER_STYLE =
  'display:block;width:100%;box-sizing:border-box;margin:0 0 4px;font-size:11px;padding:3px 6px;' +
  'background:rgba(0,0,0,0.5);color:white;border:1px solid rgba(255,255,255,0.3);border-radius:3px';
const ROW_STYLE =
  'display:flex;align-items:center;gap:6px;margin:1px 0;padding:2px 4px 2px 2px;border-radius:4px;' +
  'cursor:grab;user-select:none;-webkit-user-select:none';

/**
 * Rules the inline styles cannot hold (a row's hover), in an element that goes with the palette's body into whichever
 * document shows it: the game page's, or the editor page's.
 */
const PALETTE_CSS =
  '.weed-palette-class:hover{background:rgba(255,255,255,0.06)}' +
  '.weed-palette-class:active{cursor:grabbing}' +
  '.weed-palette-class button{flex:none;cursor:pointer}';

/** The scene's classes the palette offers, in the order it registered them. */
export function placeableClasses(scene) {
  const classes = [];
  for (const { class: EntityClass } of scene?.registeredClasses || []) {
    if (!UNPLACEABLE.has(EntityClass.name)) classes.push(EntityClass);
  }
  return classes;
}

/** The running scene's class of that name that the palette offers, or null. */
export function placeableClassOf(scene, name) {
  if (UNPLACEABLE.has(name)) return null;
  for (const { class: EntityClass } of scene?.registeredClasses || []) if (EntityClass.name === name) return EntityClass;
  return null;
}

/** A row of the class list: its picture, its name, the file's count against its pool, and its +. */
class ClassRow {
  /**
   * @param {Palette} palette
   * @param {Function} EntityClass
   * @param {import('./classThumbs.js').ClassThumb} thumb
   */
  constructor(palette, EntityClass, thumb) {
    const name = EntityClass.name;
    this.name = name;
    /** The name in lower case, for the filter. */
    this.lower = name.toLowerCase();
    this.EntityClass = EntityClass;
    this.pool = EntityClass.poolSize | 0;
    this.thumb = thumb;
    /** What the row shows now: -1 until its first update. */
    this.placed = -1;
    this.active = false;
    this.shown = true;

    const el = document.createElement('div');
    el.className = 'weed-palette-class';
    el.dataset.className = name;
    el.style.cssText = ROW_STYLE;
    // Dragged onto the view, it places one there (ED-66).
    el.draggable = true;
    el.title = `${name}: drag it onto the view to place one there`;
    el.ondragstart = (e) => palette._dragStart(this, e);
    el.ondragend = () => palette._dragEnd(this);
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0;font-size:11px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = name;
    const count = document.createElement('span');
    count.dataset.count = '';
    count.style.cssText = 'flex:none;font-size:10px;color:#888';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.dataset.place = '';
    button.textContent = '+';
    button.title = `Place ${name}: each click on the view puts one there (Esc stops)`;
    button.onclick = () => palette.editMode.startPlacing(name);
    el.append(thumb.canvas, label, count, button);
    this.el = el;
    this.count = count;
    this.button = button;
  }

  /** The file's count and whether + is on: written only when they changed. */
  update(placed, active) {
    if (placed !== this.placed) {
      this.placed = placed;
      const count = this.count;
      count.textContent = `${placed} / ${this.pool}`;
      count.style.color = placed >= this.pool ? '#f87171' : '#888';
      count.title = `${placed} placed by this file; the scene's pool holds ${this.pool}`;
    }
    if (active !== this.active) {
      this.active = active;
      if (active) this.button.classList.add('active');
      else this.button.classList.remove('active');
    }
  }

  /** Shown or filtered out. */
  show(shown) {
    if (shown === this.shown) return;
    this.shown = shown;
    this.el.style.display = shown ? 'flex' : 'none';
  }
}

export class Palette {
  /** @param {object} editMode - the EditMode it places through */
  constructor(editMode) {
    this.editMode = editMode;
    this._panel = null;
    /** The palette's content: in the floating panel, or in the editor page's Assets dock. */
    this._body = null;
    this._files = null;
    /** The Layers section: hide and lock per layer (editorLayers.js, ED-24), built when the scene changes. */
    this._layers = null;
    /** The Tilemaps section (ED-26), built when the scene changes; hidden without tilemaps. */
    this._tilemaps = null;
    this._tilemapList = new TilemapList(editMode);
    /** Above the class rows: their heading and, with more than 8 classes, the filter. */
    this._classesTop = null;
    /** The class rows' element. */
    this._list = null;
    /** Said under the rows when the filter hides every one. */
    this._noMatch = null;
    /** The Bake atlas and Export row (shipRow.js), made with the body. */
    this.ship = null;

    /** The class rows, in the scene's order, and the scene they were made for: kept across refreshes. */
    this._rows = [];
    this._rowsScene = null;
    /** The classes' pictures (ED-65): each drawn once per scene. */
    this.thumbs = new ClassThumbs(() => editMode.debugUI.scene ?? null);
    /** The filter's field (null with 8 classes or fewer) and its text, kept while the scene runs. */
    this._filter = null;
    this._filterText = '';
    /** The next try at the pictures still missing, and how many were made for this scene. */
    this._retryTimer = 0;
    this._retries = 0;
    this._onListEnter = () => this._retryPictures();
    /** A class dragged from a row and dropped on the view is placed there (ED-66): listening once shown. */
    this.drops = new DropPlacer(editMode, (name) => placeableClassOf(editMode.debugUI.scene, name));
  }

  show() {
    if (this._body === null) this._createBody();
    const dock = this.editMode.debugUI.hosted?.slot('assets') ?? null;
    if (dock !== null) {
      if (this._body.parentNode !== dock) dock.replaceChildren(this._body);
    } else if (this._panel === null) {
      this._createPanel();
    } else {
      this._panel.show();
    }
    // The game page's document: where its view is, whichever document shows the palette.
    if (typeof document !== 'undefined') this.drops.attach(document);
    this.refresh();
  }

  /** Leaving edit mode: the floating panel goes; the editor page's Assets dock stays. */
  hide() {
    if (this._panel !== null) this._panel.hide();
  }

  destroy() {
    this._stopRetry();
    this.drops.detach();
    if (this._panel === null) return;
    this._panel.onClose = null;
    this._panel.close();
    this._panel = null;
  }

  /** The rows again: after a change to the document, a swap, the file list, or what is being placed. */
  refresh() {
    const list = this._list;
    if (list === null) return;
    this._fillFiles();
    this._fillSections();
    this._fillClasses();
    this.editMode.brush?.refreshPalette(); // the decoration classes (scatterBrush.js, ED-25)
  }

  /**
   * The class rows: made when the scene (or its classes) changed, else only their counts and + marks brought up to
   * date. Pictures still missing are tried again.
   */
  _fillClasses() {
    const editMode = this.editMode;
    const scene = editMode.debugUI.scene ?? null;
    const classes = placeableClasses(scene);
    if (scene !== this._rowsScene || !this._sameClasses(classes)) this._buildRows(scene, classes);
    const placed = new Map();
    for (const record of scene?.sceneFile?.entities || []) placed.set(record.class, (placed.get(record.class) || 0) + 1);
    const placing = editMode.placing;
    for (const row of this._rows) row.update(placed.get(row.name) || 0, placing === row.name);
    this._retryPictures();
  }

  /** A row's drag starts: it carries the class's name, its picture under the pointer. */
  _dragStart(row, e) {
    const transfer = e.dataTransfer;
    if (!transfer) return;
    transfer.setData(CLASS_DRAG_TYPE, row.name);
    transfer.effectAllowed = 'copy';
    if (typeof transfer.setDragImage === 'function') transfer.setDragImage(row.thumb.canvas, CLASS_THUMB_SIZE / 2, CLASS_THUMB_SIZE / 2);
    row.el.style.opacity = '0.55';
    this.drops.begin(row.name);
  }

  _dragEnd(row) {
    row.el.style.opacity = '';
    this.drops.end();
  }

  _sameClasses(classes) {
    const rows = this._rows;
    if (rows.length !== classes.length) return false;
    for (let k = 0; k < rows.length; k++) if (rows[k].EntityClass !== classes[k]) return false;
    return true;
  }

  _buildRows(scene, classes) {
    if (scene !== this._rowsScene) {
      this._filterText = '';
      this._retries = 0;
      this._stopRetry();
    }
    this._rowsScene = scene;
    const list = this._list;
    list.textContent = '';
    this._rows = [];
    for (const EntityClass of classes) {
      const row = new ClassRow(this, EntityClass, this.thumbs.get(EntityClass));
      this._rows.push(row);
      list.appendChild(row.el);
    }
    this._fillClassesTop(classes.length);
  }

  /** The classes' heading, and the filter when there are more than 8 of them. */
  _fillClassesTop(count) {
    this._filter = null;
    const top = this._classesTop;
    if (top === null) return;
    top.textContent = '';
    if (count === 0) return;
    const head = document.createElement('div');
    head.textContent = 'Classes · drag one onto the view';
    head.style.cssText = HEAD_STYLE;
    head.title = 'Drag a class onto the view to place one where it drops, or press its + and click the view (Esc stops)';
    top.appendChild(head);
    if (count < FILTER_FROM) {
      this._applyFilter('');
      return;
    }
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = `Filter ${count} classes`;
    filter.title = 'Only the classes whose name has this text (Esc clears it)';
    filter.spellcheck = false;
    filter.autocomplete = 'off';
    filter.style.cssText = FILTER_STYLE;
    filter.value = this._filterText;
    filter.oninput = () => this._applyFilter(filter.value);
    filter.onkeydown = (e) => {
      if (e.key !== 'Escape' || filter.value === '') return;
      filter.value = '';
      this._applyFilter('');
      e.preventDefault();
      e.stopPropagation(); // Esc clears the field; it does not also reach the editor
    };
    top.appendChild(filter);
    this._filter = filter;
    this._applyFilter(this._filterText);
  }

  /** Show the rows whose class name has `text` (any case); all of them for an empty text. */
  _applyFilter(text) {
    this._filterText = text;
    const needle = text.trim().toLowerCase();
    let shown = 0;
    for (const row of this._rows) {
      const match = needle === '' || row.lower.includes(needle);
      row.show(match);
      if (match) shown++;
    }
    const none = this._noMatch;
    if (none === null) return;
    const display = shown === 0 && this._rows.length > 0 ? 'block' : 'none';
    if (none.style.display !== display) none.style.display = display;
  }

  /** The classes that show their mark, drawn again if they can show a picture now; tried again later while some miss one. */
  _retryPictures() {
    if (this._list === null) return;
    if (this.thumbs.retry() === 0) {
      this._stopRetry();
      return;
    }
    if (this._retryTimer !== 0 || this._retries >= RETRY_MS.length) return;
    const timer = setTimeout(() => {
      this._retryTimer = 0;
      this._retries++;
      this._retryPictures();
    }, RETRY_MS[this._retries]);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref(); // Node: no wait on it
    this._retryTimer = timer;
  }

  _stopRetry() {
    if (this._retryTimer === 0) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = 0;
  }

  /** The level row: the folder's scene files (the running one chosen), Open, New and Save As. */
  _fillFiles() {
    const box = this._files;
    if (box === null) return;
    box.textContent = '';
    const editMode = this.editMode;
    const current = editMode.sceneFileName;
    if (current === null) {
      const note = document.createElement('div');
      note.textContent = 'This scene was loaded from its class, not a scene file: nothing to open or save.';
      note.style.cssText = 'font-size:10px;color:#888;white-space:normal';
      box.appendChild(note);
      return;
    }
    const names = editMode.sceneFiles.includes(current) ? editMode.sceneFiles : [current, ...editMode.sceneFiles];
    const select = document.createElement('select');
    select.style.cssText = SELECT_STYLE;
    select.title = 'The scene files of this folder';
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.value = current;
    const open = this._button('Open', 'Open the chosen file (a fast swap for this scene class)', () => editMode.openSceneFile(select.value));
    const create = this._button('New', 'A new, empty scene file of this scene class, in this folder', () => {
      const name = prompt('A new scene file, in this folder:', 'level.scene.json');
      if (name !== null) editMode.newSceneFile(name);
    });
    const saveAs = this._button('Save As', 'Write this level to another file of this folder, and keep editing that one', () => {
      const name = prompt('Save this scene file as:', current);
      if (name !== null) editMode.saveSceneFileAs(name);
    });
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center';
    row.appendChild(select);
    row.appendChild(open);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;margin-top:4px';
    actions.appendChild(create);
    actions.appendChild(saveAs);
    box.appendChild(row);
    box.appendChild(actions);
  }

  /**
   * The Layers (ED-24) and Tilemaps (ED-26) sections: made on the first refresh, between the level row and the
   * classes, and filled when the scene changes (their builders keep the rows they made for a scene).
   */
  _fillSections() {
    if (this._layers === null) {
      if (this._body === null) return;
      this._layers = document.createElement('div');
      this._layers.style.cssText = SECTION_STYLE;
      this._tilemaps = document.createElement('div');
      this._tilemaps.style.cssText = SECTION_STYLE;
      this._body.insertBefore(this._layers, this._classesTop);
      this._body.insertBefore(this._tilemaps, this._classesTop);
    }
    this.editMode.layers?.fill(this._layers);
    if (this._tilemaps !== null) this._tilemapList.fill(this._tilemaps);
  }

  _button(text, title, onclick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = text;
    button.title = title;
    button.onclick = onclick;
    return button;
  }

  _createBody() {
    this._body = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = PALETTE_CSS;
    this._files = document.createElement('div');
    this._files.style.cssText = SECTION_STYLE;
    this._classesTop = document.createElement('div');
    this._list = document.createElement('div');
    this._list.addEventListener('pointerenter', this._onListEnter);
    this._noMatch = document.createElement('div');
    this._noMatch.textContent = 'No class has that in its name.';
    this._noMatch.style.cssText = 'display:none;font-size:10px;color:#888;margin:2px 0';
    this._body.append(style, this._files, this._classesTop, this._list, this._noMatch);
    this.editMode.brush?.mountPalette(this._body);
    // Stage 5: Bake atlas and Export, below the classes.
    this.ship = new ShipRow(this.editMode);
    this._body.append(this.ship.el);
  }

  _createPanel() {
    const left = typeof window !== 'undefined' ? Math.max(12, window.innerWidth - 252) : 12;
    const panel = new FloatingPanel({
      title: 'Palette',
      left,
      top: 78,
      width: 240,
      onClose: () => {
        this._panel = null;
      },
    });
    panel.body.appendChild(this._body);
    panel.mount();
    this._panel = panel;
  }
}
