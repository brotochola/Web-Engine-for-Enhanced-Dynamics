// statusBar.js — the editor page's status bar (VISUAL_EDITOR_PLAN.md ED-52): one line under the view, made by the game
// page's editor and put into the editor page's `status` dock (editorHost.js). From the left:
//   - the mode: EDIT or PLAY;
//   - the hint for what is going on: placing, painting decorations, moving, dragging a handle, the selection, or what
//     was just done (EditMode.status: saved, undone, an error in red); a debug tool's hint while one is on;
//   - the world point under the pointer, and the zoom;
//   - how many entities are selected;
//   - the grid step a move snaps to (EditMode.move, the MoveTool).
// In the editor page it takes the place of the tool indicator over the view (toolManager.js) and of the overlay's
// pointer and camera lines (debugCanvas.js); a game page on its own keeps those.
//
// Cost: update() runs at the debug UI's tick (100 ms by default), never per frame. It compares numbers, and strings
// the editor already holds, with what is shown; a part's text is built and written only when it changed. A tick that
// changes nothing allocates nothing and writes nothing.

import { Mouse } from '../../mouse.js';
import { Camera } from '../../camera.js';

// What the hint says.
const HINT_UNSET = -1;
const HINT_NONE = 0;
const HINT_TOOL = 1;
const HINT_STATUS = 2;
const HINT_PLAYING = 3;
const HINT_SESSION = 4;
const HINT_PLACING = 5;
const HINT_BRUSH = 6;
const HINT_MOVING = 7;
const HINT_HANDLE = 8;
const HINT_DRAGGING = 9;
const HINT_MANY = 10;
const HINT_SELECTED = 11;
const HINT_RUNTIME = 12;
const HINT_IDLE = 13;

const MODE_UNSET = -1;
const MODE_NONE = 0;
const MODE_EDIT = 1;
const MODE_PLAY = 2;

/** A pointer that is not over the view, as a shown coordinate (a small integer, as the others). */
const OFF_VIEW = 0x3fffffff;

/** A whole world coordinate, with a true minus sign. */
const coordText = (n) => (n < 0 ? `−${-n}` : `${n}`);

export class StatusBar {
  /**
   * @param {object} debugUI - its scene, editMode and tools (ToolManager) are read
   * @param {{ doc?: Document, mouse?: object, camera?: object }} [sources] - a test's stand-ins
   */
  constructor(debugUI, { doc = document, mouse = Mouse, camera = Camera } = {}) {
    this.debugUI = debugUI;
    this.mouse = mouse;
    this.camera = camera;
    const tools = debugUI.tools;
    /** Whether the debug tools say what they do (toolManager.js's activeToolKind and toolHint). */
    this._toolHints = !!tools && typeof tools.activeToolKind === 'function' && typeof tools.toolHint === 'function';

    this.el = doc.createElement('div');
    this.el.className = 'weed-editor-status-line';
    this._mode = this._part(doc, 'mode', 'Edit mode holds the world still; Play runs it (Shift+E)');
    this._hint = this._part(doc, 'hint', '');
    this._pointer = this._part(doc, 'pointer', 'The world point under the pointer');
    this._zoom = this._part(doc, 'zoom', 'The view’s zoom: the wheel zooms while editing');
    this._count = this._part(doc, 'selection', 'How many entities are selected: Shift+click adds one, a box on empty ground several, Ctrl+A all');
    this._grid = this._part(doc, 'grid', 'The grid a move and the arrow keys snap to: G changes it');

    // What is shown, so that an update that changes nothing builds no text and writes nothing.
    this._shownMode = MODE_UNSET;
    this._shownHint = HINT_UNSET;
    this._shownArgS = null;
    this._shownArgN = -1;
    this._shownX = NaN;
    this._shownY = NaN;
    this._shownZoom = -1;
    this._shownCount = -1;
    this._shownSnap = -1;
    // What the hint names, worked out by _hintCode: a string the editor holds, and a number.
    this._argS = null;
    this._argN = 0;
  }

  _part(doc, name, title) {
    const span = doc.createElement('span');
    span.dataset.status = name;
    if (title) span.title = title;
    this.el.appendChild(span);
    return span;
  }

  /** Show what changed since the last update (the debug UI's tick). */
  update() {
    const debugUI = this.debugUI;
    const editMode = debugUI.editMode;
    const scene = debugUI.scene;

    const mode = !scene ? MODE_NONE : editMode !== null && editMode.active ? MODE_EDIT : MODE_PLAY;
    if (mode !== this._shownMode) {
      this._shownMode = mode;
      this._mode.textContent = mode === MODE_EDIT ? 'EDIT' : mode === MODE_PLAY ? 'PLAY' : '';
      this._mode.dataset.mode = mode === MODE_EDIT ? 'edit' : mode === MODE_PLAY ? 'play' : '';
    }

    const hint = this._hintCode(editMode, scene);
    if (hint !== this._shownHint || this._argS !== this._shownArgS || this._argN !== this._shownArgN) {
      this._shownHint = hint;
      this._shownArgS = this._argS;
      this._shownArgN = this._argN;
      const text = this._hintText(hint);
      this._hint.textContent = text;
      this._hint.title = text;
      this._hint.classList.toggle('error', hint === HINT_STATUS && this._argN === 1);
    }

    const mouse = this.mouse;
    const present = !!scene && mouse.isPresent;
    const x = present ? Math.round(mouse.x) : OFF_VIEW;
    const y = present ? Math.round(mouse.y) : OFF_VIEW;
    if (x !== this._shownX || y !== this._shownY) {
      this._shownX = x;
      this._shownY = y;
      this._pointer.textContent = present ? `x ${coordText(x)}\u2002y ${coordText(y)}` : 'x –\u2002y –';
    }

    const zoom = scene ? Math.round(this.camera.zoom * 100) : 0;
    if (zoom !== this._shownZoom) {
      this._shownZoom = zoom;
      this._zoom.textContent = scene ? `${zoom}%` : '';
    }

    const selection = editMode === null ? null : editMode.selection;
    const count = selection === null || selection.index < 0 ? 0 : 1 + (editMode.multi ? editMode.multi.count : 0);
    if (count !== this._shownCount) {
      this._shownCount = count;
      this._count.textContent = count === 0 ? 'Nothing selected' : `${count} selected`;
    }

    const snap = editMode === null ? 1 : editMode.move.snap;
    if (snap !== this._shownSnap) {
      this._shownSnap = snap;
      this._grid.textContent = snap > 1 ? `Grid ${snap} px` : 'No grid';
    }
  }

  /** What the hint says now (HINT_*), with what it names in _argS and _argN: nothing is made here. */
  _hintCode(editMode, scene) {
    this._argS = null;
    this._argN = 0;
    if (!scene) return HINT_NONE;
    const tools = this.debugUI.tools;
    const toolKind = this._toolHints ? tools.activeToolKind() : 0;
    if (toolKind !== 0) {
      this._argS = tools.toolHintArg();
      this._argN = toolKind * 2 + (tools.bulkSpawnEnabled ? 1 : 0);
      return HINT_TOOL;
    }
    if (editMode === null) return HINT_PLAYING;
    if (editMode.status) {
      this._argS = editMode.status;
      this._argN = editMode.statusIsError ? 1 : 0;
      return HINT_STATUS;
    }
    if (!editMode.active) return editMode.playing ? HINT_SESSION : HINT_PLAYING;
    if (editMode.placing !== null) {
      this._argS = editMode.placing;
      return HINT_PLACING;
    }
    const brush = editMode.brush;
    if (brush && brush.className !== null) {
      this._argS = brush.className;
      return HINT_BRUSH;
    }
    const selection = editMode.selection;
    const count = selection.index < 0 ? 0 : 1 + (editMode.multi ? editMode.multi.count : 0);
    if (editMode.move.dragging) {
      this._argS = selection.name;
      this._argN = count;
      return HINT_MOVING;
    }
    if (editMode.handles && editMode.handles.dragging) {
      this._argS = selection.name;
      return HINT_HANDLE;
    }
    const editTools = editMode.tools;
    for (let k = 0; k < editTools.length; k++) if (editTools[k].dragging === true) return HINT_DRAGGING;
    if (count > 1) {
      this._argN = count;
      return HINT_MANY;
    }
    if (count === 1) {
      if (selection.name !== null) {
        this._argS = selection.name;
        return HINT_SELECTED;
      }
      this._argS = selection.className;
      this._argN = selection.index;
      return HINT_RUNTIME;
    }
    return HINT_IDLE;
  }

  _hintText(hint) {
    const name = this._argS;
    const n = this._argN;
    switch (hint) {
      case HINT_NONE:
        return '';
      case HINT_TOOL:
        return this.debugUI.tools.toolHint();
      case HINT_STATUS:
        return name;
      case HINT_PLAYING:
        return 'Playing · Shift+E pauses into edit mode';
      case HINT_SESSION:
        return 'Playing from edit mode · Stop goes back to the level · Shift+E pauses here';
      case HINT_PLACING:
        return `Placing ${name}: each click on the view puts one there · Esc stops`;
      case HINT_BRUSH:
        return `Painting ${name}: drag to scatter, Shift+drag to erase · [ and ] size the brush · Esc puts it down`;
      case HINT_MOVING:
        return n > 1 ? `Moving ${n} entities: release to drop them` : `Moving ${name}: release to drop it`;
      case HINT_HANDLE:
        return `Dragging a handle of ${name}: release to apply it · Alt sizes a box from its center`;
      case HINT_DRAGGING:
        return 'Dragging: release to apply it';
      case HINT_MANY:
        return `${n} selected: drag or the arrows move them · Del deletes · Ctrl+D duplicates · Ctrl+G groups`;
      case HINT_SELECTED:
        return `${name}: drag or the arrows move it (Shift: ten steps) · Del deletes · Ctrl+D duplicates · Esc deselects`;
      case HINT_RUNTIME:
        return `${name} #${n}: spawned by code, not by the scene file, so read-only`;
      default:
        return 'Click selects · a drag on empty ground boxes several · right drag pans · wheel zooms · Ctrl+S saves · Shift+E plays';
    }
  }
}
