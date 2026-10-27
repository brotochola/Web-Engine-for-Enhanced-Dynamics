// editMode.js — the editor's edit mode (VISUAL_EDITOR_PLAN.md D5, ED-6; the Stage 2 version). Shift+E, or the Edit
// button of the debug UI's Scene panel, toggles it.
//
// While it is on, the world holds still and the view and the input are the editor's:
// - Time.scale is 0: every worker steps with a zero delta, so physics takes no step (a step of 0 s moves no body)
//   and ticks see dt 0, while drawing goes on;
// - the camera is held (Camera.held: a game's follows return at once) and free for the editor: the wheel zooms
//   around the pointer, a right or middle drag pans;
// - no button press reaches the game (Mouse.isEditModeActive), and no key: GameEngine hands them to onKey.
// Leaving puts the time scale, the camera and the input back. A fast swap (another level of the scene, a hot reload
// of its file) puts the time scale and the camera back to the level's start: onContentSwapped holds them again
// before the workers resume. A full load (another scene) leaves edit mode and enters it again once the new scene is
// attached.
//
// Known limit of this version: tick() still runs, with a zero delta, so code that counts frames keeps counting.
// ED-19 pauses the simulation workers instead.
//
// A left click selects (selection.js, ED-8), and a drag moves the selection (moveTool.js, ED-10), as do the arrow
// keys (Shift: ten steps); G cycles the grid step. Other tools (Stage 4: handles, brushes, pickers) are added with
// addTool(): one may take a press before the move tool does, and has the pointer until it is let go. Esc clears the selection, and with none leaves edit mode. Ctrl+S
// saves the running scene file through the dev server (sceneFileStore.js, ED-13). Every change to the document goes
// through editSelected and is kept for Ctrl+Z / Ctrl+Y (history.js, ED-12).
//
// Play and Stop (D8, ED-16): Play leaves edit mode and remembers what it started from; Stop goes back to the level as
// the document has it (a fast swap) in edit mode. What happened while playing is thrown away, the document's edits
// are not; a game that went to another file while playing is taken back to the one Play started from.
//
// In the editor page (D9) the game page reloads under a running editor: handover() gives what a reload keeps, as
// plain data, and resume() takes it up in the next page.
//
// Cost: nothing before the first Shift+E. Its listeners are on the document only while it is on.

import { Time, sanitizeTimeScale } from '../../timeScale.js';
import { Camera } from '../../camera.js';
import { Mouse } from '../../mouse.js';
import { Transform } from '../../../components/transform.js';
import { saveSceneFile, listSceneFiles } from './sceneFileStore.js';
import { Selection } from './selection.js';
import { EditorLayers } from './editorLayers.js';
import { MoveTool, SNAP_STEPS, snapTo } from './moveTool.js';
import { History } from './history.js';
import { Palette } from './palette.js';
import { MultiSelect, groupsOf, writeGroups } from './multiSelect.js';
import { EntityPickTool } from './entityPicker.js';
import { HandlesTool } from './handles.js';
import {
  editPlaced,
  restorePlaced,
  recordOf,
  classNamed,
  indexOfName,
  editorIdOf,
  withEditorId,
  nameOfEditorId,
  nextEditorIdToGive,
  reserveEditorIds,
  uniqueName,
  addPlaced,
  removePlaced,
  renamePlaced,
  writePosition,
} from './sceneDocument.js';
import { jointsBeforeDelete, replaceJoints } from './sceneJoints.js';
import { applyJointsChange } from './jointsPanel.js';
import { ScatterBrush } from './scatterBrush.js';
import { JointTool } from './jointTool.js';

/** The buttons that pan (Pointer Events `buttons`: 2 secondary, 4 auxiliary). */
const PAN_BUTTONS = 2 | 4;
/** The button that selects (primary). */
const SELECT_BUTTON = 1;

/** How long a status line (saved, could not save) stays on the indicator. */
const STATUS_MS = 3000;

/**
 * Leave the field that has the focus, so its change event commits what was typed into it.
 * @param {Document} [doc] - the document the key was typed in: the editor page's, for a docked panel's field
 */
function commitFocusedField(doc = typeof document !== 'undefined' ? document : null) {
  const field = doc ? doc.activeElement : null;
  if (field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA' || field.tagName === 'SELECT')) field.blur();
}

/**
 * A name typed for New or Save As, as a file of the same folder: `.scene.json` added when missing; null when it is
 * empty or holds a folder (/, \) or a colon.
 * @param {unknown} name
 * @returns {string|null}
 */
export function sceneFileNameOf(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '' || /[\\/:]/.test(trimmed)) return null;
  const fileName = trimmed.endsWith('.scene.json') ? trimmed : `${trimmed}.scene.json`;
  return fileName === '.scene.json' ? null : fileName;
}

export class EditMode {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.active = false;
    this.selection = new Selection(debugUI);
    this.selection.editor = this;
    this.move = new MoveTool(this.selection);
    this.history = new History((change, forward) => this._apply(change, forward));
    this.palette = new Palette(this);
    /** Per-layer hide and lock (ED-24): the palette's Layers section, the click and the move tool ask it. */
    this.layers = new EditorLayers(this);
    /** The class each click on the view places (the palette's button), or null. */
    this.placing = null;
    /** The scene files in the running one's folder, for the palette's level list (ED-38). */
    this.sceneFiles = [];
    /**
     * The editor's other tools, in the order they were added (addTool, Stage 4). Each may take a primary press on the
     * view before the move tool (press returns true), then has the pointer until the button is let go (move,
     * release); it may follow the pointer with no button down (hover), draw on the overlay (drawOverlay, each frame
     * the overlay draws while editing), take a key first (onKey returns true), and drop what it was doing when edit
     * mode is left or the level swapped (cancel). Every method is optional.
     * @type {{ press?: (x: number, y: number, e: PointerEvent) => boolean, move?: Function, release?: Function,
     *   hover?: Function, drawOverlay?: (ctx: CanvasRenderingContext2D, camera: object, zoom: number) => void,
     *   onKey?: (e: KeyboardEvent) => boolean, cancel?: () => void }[]}
     */
    this.tools = [];
    /** An entity param filled by a click on the entity (entityPicker.js): while picking, it takes every press. */
    this.picker = this.addTool(new EntityPickTool(this));
    /** The selection's collider, light and points handles (handles.js: ED-20, ED-22, ED-27). */
    this.handles = this.addTool(new HandlesTool(this));
    /** The scatter brush for the file's decorations (scatterBrush.js, ED-25); the palette shows its section. */
    this.brush = this.addTool(new ScatterBrush(this));
    /** The selected entity's joints on the overlay, their anchors dragged (jointTool.js, ED-21). */
    this.addTool(new JointTool(this));
    /** The tool a press went to, until its button is let go. */
    this._toolWithPointer = null;

    // What entering found, put back on leaving.
    this._savedTimeScale = NaN;
    this._savedFree = false;
    this._savedFreeSmoothing = NaN;
    /** A full load left edit mode: enter it again when the new scene is attached. */
    this._resumeOnAttach = false;
    /** What Play started from (play()), for Stop: the file, its data and document, the undo stack, the view. */
    this._playStart = null;
    /** A swap the editor makes itself (Stop, resume): the document is the same, its undo stack stays. */
    this._ownSwap = false;

    /** What the indicator says instead of the help for a moment (a save's outcome), and whether it went wrong. */
    this.status = '';
    this.statusIsError = false;
    this._statusTimer = 0;
    /** The save under way, so that a second Ctrl+S waits for it instead of writing twice at once. */
    this._saving = null;

    // A drag that pans: its pointer, where it started on screen, and the free camera's target then.
    this._panPointer = -1;
    this._panX = NaN;
    this._panY = NaN;
    this._panFromX = NaN;
    this._panFromY = NaN;

    this._onPointerDown = (e) => {
      if (e.target !== this.debugUI.gameEngine?.canvas) return;
      if (e.buttons === SELECT_BUTTON) {
        // The engine's canvas listener ran first: Mouse holds this point in the world.
        if (this.placing !== null) this.place(this.placing, Mouse.x, Mouse.y);
        else if (!this._pressTool(e)) this.move.press(Mouse.x, Mouse.y, e.clientX, e.clientY);
        return;
      }
      if ((e.buttons & PAN_BUTTONS) === 0) return;
      e.preventDefault(); // no autoscroll on a middle press
      this._panPointer = e.pointerId;
      this._panX = e.clientX;
      this._panY = e.clientY;
      this._panFromX = Camera._freeFollowX;
      this._panFromY = Camera._freeFollowY;
    };
    this._onPointerMove = (e) => {
      if ((e.buttons & SELECT_BUTTON) !== 0) {
        if (this._toolWithPointer !== null) this._toolWithPointer.move?.(Mouse.x, Mouse.y, e);
        else this.move.move(Mouse.x, Mouse.y, e.clientX, e.clientY);
      } else if (e.buttons === 0) {
        for (const tool of this.tools) tool.hover?.(Mouse.x, Mouse.y, e);
      }
      if (e.pointerId !== this._panPointer) return;
      if ((e.buttons & PAN_BUTTONS) === 0) {
        this._panPointer = -1;
        return;
      }
      const zoom = Camera.zoom || 1;
      Camera.setFreeTarget(this._panFromX - (e.clientX - this._panX) / zoom, this._panFromY - (e.clientY - this._panY) / zoom);
    };
    this._onPointerUp = (e) => {
      if ((e.buttons & SELECT_BUTTON) === 0) {
        const tool = this._toolWithPointer;
        if (tool !== null) {
          this._toolWithPointer = null;
          tool.release?.(Mouse.x, Mouse.y, e);
        } else {
          this.move.release();
        }
      }
      if (e.pointerId === this._panPointer && (e.buttons & PAN_BUTTONS) === 0) this._panPointer = -1;
    };
    this._onContextMenu = (e) => {
      if (e.target === this.debugUI.gameEngine?.canvas) e.preventDefault(); // a right drag pans
    };

    /** Several placed entities selected (ED-28): a box, Shift+click, Ctrl+A, groups. Last: other tools come first. */
    this.multi = this.addTool(new MultiSelect(this));
    /** A batch of changes is being applied: the selection is shown once, after it. */
    this._quiet = false;
  }

  toggle() {
    if (this.active) this.play();
    else this.enter();
  }

  /**
   * Add a tool (see `tools`): handles, brushes, pickers.
   * @template T
   * @param {T} tool
   * @returns {T}
   */
  addTool(tool) {
    this.tools.push(tool);
    return tool;
  }

  /** A primary press: the first tool that takes it has the pointer. */
  _pressTool(e) {
    for (const tool of this.tools) {
      if (tool.press && tool.press(Mouse.x, Mouse.y, e) === true) {
        this._toolWithPointer = tool;
        return true;
      }
    }
    return false;
  }

  /** Every tool drops what it was doing (leaving edit mode, a swap). */
  _cancelTools() {
    this._toolWithPointer = null;
    for (const tool of this.tools) tool.cancel?.();
  }

  /** Whether a tool draws on the overlay with nothing selected (the brush's circle): the overlay runs while one does. */
  wantsOverlay() {
    if (!this.active) return false;
    const tools = this.tools; // each overlay frame: an index, no iterator
    for (let k = 0; k < tools.length; k++) if (tools[k].wantsOverlay?.() === true) return true;
    return false;
  }

  /** The overlay's frame while editing (debugCanvas.js): the move ghost, then each tool's drawing. */
  drawOverlay(ctx, camera, zoom) {
    this.move.drawOverlay(ctx, camera, zoom);
    for (const tool of this.tools) tool.drawOverlay?.(ctx, camera, zoom);
  }

  /** Whether the game is playing a session Play started, which Stop ends. */
  get playing() {
    return !this.active && this._playStart !== null;
  }

  /** Play (D8): leave edit mode, the game runs from here. Stop comes back to the level as it is now. */
  play() {
    if (!this.active) return;
    this._playStart = this._snapshot(true);
    this.exit();
  }

  /**
   * Stop (D8): the level as its document has it, by a fast swap, in edit mode. What happened while playing is thrown
   * away; edits made to the document are not. A game that went to another file while playing is taken back to the
   * one Play started from, with its document and undo stack as they were then.
   * @returns {Promise<boolean>} whether it went back
   */
  async stop() {
    const scene = this.debugUI.scene;
    if (!scene) return false;
    const start = this._playStart;
    const back = start !== null && start.sceneFileUrl !== scene.sceneFileUrl ? start : this._snapshot(true);
    if (back.sceneFileUrl === null) {
      this._setStatus('This scene was not loaded from a scene file: there is no level to go back to', true);
      return false;
    }
    if (back === start && !this._mayDiscard()) return false;
    back.active = true;
    if (start !== null) back.view = start.view;
    this._playStart = null;
    const ok = await this._restoreState(back, true, start === null ? scene.data : start.data);
    if (ok) this._setStatus(`Stopped: ${this.sceneFileName} as its document has it`, false);
    return ok;
  }

  /**
   * The running file, its document (a copy) and the records' editor ids, the undo stack (a copy), edit mode, the
   * selection, the grid and the view: what Stop and a resume put back.
   * @param {boolean} withDocument - the document even when the file has it (Stop swaps to it either way)
   */
  _snapshot(withDocument) {
    const scene = this.debugUI.scene;
    const editorIds = [];
    for (const record of scene.sceneFile?.entities || []) {
      if (Object.prototype.hasOwnProperty.call(record, '_editorId')) editorIds.push([record.name, record._editorId]);
    }
    return {
      version: 1,
      sceneScriptUrl: scene.sceneScriptUrl ?? null,
      sceneFileUrl: scene.sceneFileUrl ?? null,
      data: scene.data,
      document: scene.sceneFile && (withDocument || this.dirty) ? structuredClone(scene.sceneFile) : null,
      editorIds,
      nextEditorId: nextEditorIdToGive(),
      history: structuredClone(this.history.toData()),
      active: this.active,
      selection: this.selection.authored ? this.selection.name : null,
      snap: this.move.snap,
      view: this.active ? { x: Camera._freeFollowX, y: Camera._freeFollowY, zoom: Camera.zoom } : null,
      playSpeed: this.playSpeed,
    };
  }

  enter() {
    const debugUI = this.debugUI;
    if (this.active || !debugUI.scene) return;
    this.active = true;
    this._savedTimeScale = Time.scale;
    this._savedFree = Camera._free;
    this._savedFreeSmoothing = Camera._freeSmoothing;
    debugUI.tools.deactivateAll();
    this._hold();
    this.layers.apply();
    this._listen(true);
    this.palette.show();
    this.refreshSceneFiles();
    this._changed();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this._listen(false);
    this._panPointer = -1;
    this.placing = null;
    this.palette.hide();
    this.move.cancel();
    this._cancelTools();
    this.layers.restore(); // the game plays with the layers it had
    // The selection stays: the inspector shows its live values while the game plays (ED-17).
    this._setStatus('', false);
    Mouse.isEditModeActive = false;
    Camera.held = false;
    Camera.setFree(this._savedFree, { smoothing: this._savedFreeSmoothing });
    Time.scale = this._savedTimeScale;
    this.debugUI.tools._syncDebugToolFlag();
    this._changed();
    this.debugUI.hosted?.onPlay();
  }

  /**
   * A key pressed while editing: GameEngine hands every keydown here then, and none to the game.
   * @param {KeyboardEvent} e
   * @returns {boolean} whether it was the editor's
   */
  onKey(e) {
    for (const tool of this.tools) if (tool.onKey && tool.onKey(e) === true) return true;
    if (e.key === 'Escape') {
      if (this.placing !== null) this.startPlacing(this.placing);
      else if (this.selection.index >= 0) this.selection.clear();
      else this.exit();
      return true;
    }
    if (e.key === 'Delete' || (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey)) return this.deleteSelected();
    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 's':
        case 'S':
          // A value typed into a field and not yet committed (no change event: the field still has the focus) is
          // part of the document the author means to save: leaving the field commits it first.
          commitFocusedField(e.target?.ownerDocument);
          this.save();
          return true;
        case 'd':
        case 'D':
          this.duplicateSelected();
          return true;
        case 'z':
        case 'Z':
          if (e.shiftKey) this.redo();
          else this.undo();
          return true;
        case 'y':
        case 'Y':
          this.redo();
          return true;
        default:
          return false;
      }
    }
    if (e.altKey) return false;
    const steps = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowLeft':
        return this.move.nudge(-steps, 0);
      case 'ArrowRight':
        return this.move.nudge(steps, 0);
      case 'ArrowUp':
        return this.move.nudge(0, -steps);
      case 'ArrowDown':
        return this.move.nudge(0, steps);
      case 'g':
      case 'G': {
        const next = SNAP_STEPS[(SNAP_STEPS.indexOf(this.move.snap) + 1) % SNAP_STEPS.length];
        this.move.snap = next;
        this._setStatus(next > 1 ? `Grid ${next} px` : 'No grid', false);
        return true;
      }
      default:
        return false;
    }
  }

  /** The document has changes the file does not hold. */
  get dirty() {
    return this.history.dirty;
  }

  /** The speed the game plays at (ED-14): Time.scale, or while editing, the scale that leaving puts back. */
  get playSpeed() {
    return this.active ? this._savedTimeScale : Time.scale;
  }

  set playSpeed(value) {
    const scale = sanitizeTimeScale(value);
    if (this.active) this._savedTimeScale = scale;
    else Time.scale = scale;
  }

  /**
   * Change the selected placed entity's record with `write(record, description)` and respawn it; the change is
   * kept for undo, and the selection follows the respawned entity.
   * @param {string} label - what the change was, for the status line of an undo
   * @param {(record: object, description: object|null) => void} write
   * @returns {number} the respawned entity's index, or -1 (nothing selected from the file, or nothing changed)
   */
  editSelected(label, write) {
    const selection = this.selection;
    if (!selection.authored || this.move.dragging) return -1;
    const scene = this.debugUI.scene;
    const found = recordOf(scene, selection.name);
    if (found === null) return -1;
    // Undo finds the record by its editor id: it may be renamed, or removed and put back, by then.
    const id = editorIdOf(found.record);
    const result = editPlaced(scene, selection.name, write);
    if (result === null) return -1;
    this.history.push({ id: 0, label, kind: 'edit', editorId: id, before: result.before, after: result.after });
    this._showRestored(result.index);
    return result.index;
  }

  /**
   * Carry out a change of the history (history.js): forward for a redo, backward for an undo. A change is data, so
   * a change made by the game page before a reload applies here too (D9).
   */
  _apply(change, forward) {
    switch (change.kind) {
      case 'batch': {
        // Several changes as one (ED-28): in order forward, the other way back; the selection shown once after.
        const list = forward ? change.changes : change.changes.slice().reverse();
        this._quiet = true;
        try {
          for (const c of list) this._apply(c, forward);
        } finally {
          this._quiet = false;
        }
        this.multi.selectNames((forward ? change.selectAfter : change.selectBefore) || []);
        this.debugUI.hosted?.onDocumentChanged();
        this.palette.refresh();
        this._notify();
        break;
      }
      case 'groups':
        writeGroups(this.debugUI.scene.sceneFile, structuredClone(forward ? change.after : change.before));
        this._notify();
        break;
      case 'edit':
        this._restore(change.editorId, forward ? change.after : change.before);
        break;
      case 'add':
      case 'remove':
        if (forward === (change.kind === 'add')) this._putBack(change);
        else this._remove(change.editorId);
        break;
      case 'rename':
        this._renameTo(change.editorId, forward ? change.to : change.from);
        break;
      case 'joints':
        applyJointsChange(this, change, forward);
        break;
      case 'decorations':
        this.brush.apply(change, forward);
        break;
      default:
        throw new Error(`editor: no such change: ${change.kind}`);
    }
  }

  _restore(id, snapshot) {
    const scene = this.debugUI.scene;
    const name = nameOfEditorId(scene, id);
    this._showRestored(name === null ? -1 : restorePlaced(scene, name, snapshot));
  }

  /**
   * An added record again, or a removed one back: a copy of it at its place in the file, with its editor id; and the
   * joints its delete took out (ED-21), as they were.
   */
  _putBack({ editorId, at, copy, joints }) {
    const scene = this.debugUI.scene;
    const index = addPlaced(scene, withEditorId(structuredClone(copy), editorId), at);
    if (joints !== undefined) replaceJoints(scene, structuredClone(joints));
    this._showRestored(index);
  }

  // ---- scene files: the level list, Open, New, Save As (ED-38) ----

  /** The running scene file's name (`1-1.scene.json`), or null. */
  get sceneFileName() {
    const url = this.debugUI.scene?.sceneFileUrl;
    return url ? decodeURIComponent(new URL(url).pathname.split('/').pop()) : null;
  }

  /** The running scene file's folder, or null. */
  _folderUrl() {
    const url = this.debugUI.scene?.sceneFileUrl;
    return url ? new URL('.', url).href : null;
  }

  /** List the scene files beside the running one (the palette's level list). */
  async refreshSceneFiles() {
    const folder = this._folderUrl();
    let files = [];
    if (folder !== null) {
      try {
        files = await listSceneFiles(folder);
      } catch (error) {
        this._setStatus(error.message, true);
      }
    }
    this.sceneFiles = files;
    this.palette.refresh();
  }

  /** Whether the document's unsaved changes may go: asks when there are some. */
  _mayDiscard() {
    if (!this.dirty) return true;
    return typeof confirm === 'function' && confirm(`${this.sceneFileName} has unsaved changes. Discard them?`);
  }

  /**
   * Open a scene file of the running one's folder: a fast swap when it names the running scene class.
   * @returns {Promise<boolean>} whether it was loaded
   */
  async openSceneFile(name) {
    const scene = this.debugUI.scene;
    const folder = this._folderUrl();
    if (folder === null || name === this.sceneFileName || !this._mayDiscard()) return false;
    const ok = await this.debugUI.gameEngine.loadScene(new URL(name, folder).href, { data: scene.data });
    return ok !== false;
  }

  /**
   * New: an empty scene file in the running one's folder, naming the same scene module and class; written, then
   * opened.
   * @returns {Promise<boolean>}
   */
  async newSceneFile(name) {
    const scene = this.debugUI.scene;
    const folder = this._folderUrl();
    const fileName = sceneFileNameOf(name);
    if (folder === null || !scene.sceneFile || fileName === null) {
      this._setStatus(fileName === null ? `Not a scene file name: ${name}` : 'This scene has no scene file to start from', true);
      return false;
    }
    if (this.sceneFiles.includes(fileName)) {
      this._setStatus(`${fileName} is already there`, true);
      return false;
    }
    if (!this._mayDiscard()) return false;
    const doc = { format: 1, script: scene.sceneFile.script, export: scene.sceneFile.export, entities: [] };
    const url = new URL(fileName, folder).href;
    try {
      await saveSceneFile(url, doc);
    } catch (error) {
      this._setStatus(error.message, true);
      return false;
    }
    this.sceneFiles = [...this.sceneFiles, fileName].sort();
    const ok = await this.debugUI.gameEngine.loadScene(url, { data: scene.data });
    return ok !== false;
  }

  /**
   * Save As: the document written to another file of the running one's folder, which is then the running file
   * (Ctrl+S, hot reload and saves of the game go to it).
   * @returns {Promise<boolean>}
   */
  async saveSceneFileAs(name) {
    const scene = this.debugUI.scene;
    const folder = this._folderUrl();
    const fileName = sceneFileNameOf(name);
    if (folder === null || !scene.sceneFile || fileName === null) {
      this._setStatus(fileName === null ? `Not a scene file name: ${name}` : 'This scene has no scene file to save', true);
      return false;
    }
    if (this.sceneFiles.includes(fileName) && !(typeof confirm === 'function' && confirm(`Replace ${fileName}?`))) return false;
    const url = new URL(fileName, folder).href;
    const position = this.history.position;
    try {
      await saveSceneFile(url, scene.sceneFile);
    } catch (error) {
      this._setStatus(error.message, true);
      return false;
    }
    scene.sceneFileUrl = url;
    this.history.markSaved(position);
    this._setStatus(`Saved as ${fileName}`, false);
    await this.refreshSceneFiles();
    return true;
  }

  /** The palette's button: each click on the view places one of `className`, until Esc or the button again. */
  startPlacing(className) {
    // The editor page's Assets dock shows the palette while playing too: its + enters edit mode.
    if (!this.active && this.debugUI.hosted) {
      this.enter();
      if (!this.active) return;
    }
    this.placing = this.placing === className ? null : className;
    if (this.placing !== null) this.selection.clear();
    if (this.placing !== null && this.brush.className !== null) this.brush.select(null); // the brush goes down
    this.palette.refresh();
    this._notify();
  }

  /**
   * The editor page's scene list (ED-15): select an entity, entering edit mode; `center` (a double click) puts it
   * in the middle of the view.
   */
  selectFromList(index, center) {
    if (this.placing !== null) this.startPlacing(this.placing);
    // While playing it stays playing: the inspector shows the entity live (ED-17).
    this.selection.select(index);
    if (center && this.active) Camera.setFreeTarget(Transform.x[index], Transform.y[index]);
  }

  /**
   * Place a new entity of `className` at a world point, on the grid, under a name the file does not use.
   * @returns {number} its index, or -1
   */
  place(className, x, y) {
    const scene = this.debugUI.scene;
    if (!scene?.sceneFile) {
      this._setStatus('This scene was not loaded from a scene file: there is no file to place into', true);
      return -1;
    }
    const step = this.move.snap;
    const record = { name: uniqueName(scene, className), class: className, x: snapTo(x, step), y: snapTo(y, step) };
    return this._add(record, -1, `place ${record.name}`);
  }

  /** Ctrl+D: a copy of the selected placed entity, a grid step (at least 16 px) down and to the right, named anew. */
  duplicateSelected() {
    const selection = this.selection;
    if (this.multi.count > 0 && selection.authored) return this._duplicateMany();
    if (!selection.authored) return -1;
    const scene = this.debugUI.scene;
    const found = recordOf(scene, selection.name);
    if (found === null) return -1;
    const offset = Math.max(this.move.snap, 16);
    const record = structuredClone(found.record);
    record.name = uniqueName(scene, found.record.name);
    record.x = found.record.x + offset;
    record.y = found.record.y + offset;
    return this._add(record, found.position + 1, `duplicate ${selection.name}`);
  }

  /** Add a record at `position` and spawn it; kept for undo. A full pool says which count to raise. */
  _add(record, position, label) {
    const scene = this.debugUI.scene;
    const index = addPlaced(scene, record, position);
    if (index < 0) {
      const pool = classNamed(scene, record.class)?.poolSize | 0;
      this._setStatus(`${record.class}: its pool of ${pool} is full. Raise its count in ${scene.constructor.name}.entities`, true);
      return -1;
    }
    const at = scene.sceneFile.entities.indexOf(record);
    this.history.push({ id: 0, label, kind: 'add', editorId: editorIdOf(record), at, copy: structuredClone(record) });
    this._showRestored(index);
    return index;
  }

  // ---- several selected entities (ED-28) ----

  /**
   * Change the records of several placed entities with `write(record, description)` and respawn them, as one change
   * (undo takes all of them back).
   * @param {string} label
   * @param {string[]} names
   * @param {(record: object, description: object|null) => void} write
   * @returns {boolean} whether anything changed
   */
  editMany(label, names, write) {
    const scene = this.debugUI.scene;
    const changes = [];
    this._quiet = true;
    try {
      for (const name of names) {
        const found = recordOf(scene, name);
        if (found === null) continue;
        const id = editorIdOf(found.record);
        const result = editPlaced(scene, name, write);
        if (result !== null) changes.push({ kind: 'edit', editorId: id, before: result.before, after: result.after });
      }
    } finally {
      this._quiet = false;
    }
    if (changes.length === 0) return false;
    this.history.push({ id: 0, label, kind: 'batch', changes, selectBefore: names, selectAfter: names });
    this.multi.selectNames(names);
    this.debugUI.hosted?.onDocumentChanged();
    this.palette.refresh();
    this._notify();
    return true;
  }

  /** The move tool's release and nudge: the selection to (x, y), the others selected by the same step. */
  moveSelectedTo(x, y) {
    const selection = this.selection;
    if (this.multi.count === 0) return this.editSelected(`move ${selection.name}`, (record) => writePosition(record, x, y));
    const found = recordOf(this.debugUI.scene, selection.name);
    if (found === null) return -1;
    const dx = x - found.record.x;
    const dy = y - found.record.y;
    const names = this.multi.selectedNames();
    this.editMany(`move ${names.length} entities`, names, (record) => writePosition(record, record.x + dx, record.y + dy));
    return selection.index;
  }

  /** Ctrl+G: the selected placed entities become a group (a click on one selects them all); one undo. */
  groupSelected() {
    const names = this.multi.selectedNames();
    const doc = this.debugUI.scene?.sceneFile;
    if (!doc || names.length < 2) {
      this._setStatus('Select two or more placed entities to group them', true);
      return false;
    }
    const before = structuredClone(groupsOf(doc));
    const after = before.map((g) => g.filter((n) => !names.includes(n))).filter((g) => g.length > 1);
    after.push(names);
    writeGroups(doc, structuredClone(after));
    this.history.push({ id: 0, label: `group ${names.length} entities`, kind: 'groups', before, after });
    this._setStatus(`Grouped ${names.length}: a click on one selects them all`, false);
    return true;
  }

  /** Ctrl+Shift+G: the groups of the selected entities are undone; one undo. */
  ungroupSelected() {
    const names = this.multi.selectedNames();
    const doc = this.debugUI.scene?.sceneFile;
    if (!doc) return false;
    const before = structuredClone(groupsOf(doc));
    const after = before.filter((g) => !g.some((n) => names.includes(n)));
    if (after.length === before.length) return false;
    writeGroups(doc, structuredClone(after));
    this.history.push({ id: 0, label: 'ungroup', kind: 'groups', before, after });
    this._setStatus('Ungrouped', false);
    return true;
  }

  /** Del with several selected: all of them out of the file, as one change. */
  _deleteMany() {
    const scene = this.debugUI.scene;
    const names = this.multi.selectedNames();
    // The last in the file first, so each one's position is still its own, and undo puts them back in order.
    const found = names.map((name) => recordOf(scene, name)).filter((f) => f !== null);
    found.sort((a, b) => b.position - a.position);
    const changes = found.map((f) => ({
      kind: 'remove',
      editorId: editorIdOf(f.record),
      at: f.position,
      copy: structuredClone(f.record),
    }));
    this._quiet = true;
    try {
      for (const c of changes) this._remove(c.editorId);
    } finally {
      this._quiet = false;
    }
    this.history.push({ id: 0, label: `delete ${changes.length} entities`, kind: 'batch', changes, selectBefore: names, selectAfter: [] });
    this.multi.selectNames([]);
    this.debugUI.hosted?.onDocumentChanged();
    this.palette.refresh();
    this._notify();
    return true;
  }

  /** Ctrl+D with several selected: a copy of each, a grid step away, as one change; the copies selected. */
  _duplicateMany() {
    const scene = this.debugUI.scene;
    const names = this.multi.selectedNames();
    const offset = Math.max(this.move.snap, 16);
    const changes = [];
    const copies = [];
    this._quiet = true;
    try {
      for (const name of names) {
        const found = recordOf(scene, name);
        if (found === null) continue;
        const record = structuredClone(found.record);
        record.name = uniqueName(scene, found.record.name);
        record.x = found.record.x + offset;
        record.y = found.record.y + offset;
        const at = scene.sceneFile.entities.length;
        if (addPlaced(scene, record, at) < 0) continue;
        changes.push({ kind: 'add', editorId: editorIdOf(record), at, copy: structuredClone(record) });
        copies.push(record.name);
      }
    } finally {
      this._quiet = false;
    }
    if (changes.length === 0) return -1;
    this.history.push({ id: 0, label: `duplicate ${changes.length} entities`, kind: 'batch', changes, selectBefore: names, selectAfter: copies });
    this.multi.selectNames(copies);
    this.debugUI.hosted?.onDocumentChanged();
    this.palette.refresh();
    this._notify();
    return this.selection.index;
  }

  /** Del: take the selected placed entity out of the file; kept for undo. */
  deleteSelected() {
    const selection = this.selection;
    if (this.multi.count > 0 && selection.authored && !this.move.dragging) return this._deleteMany();
    if (!selection.authored || this.move.dragging) return false;
    const scene = this.debugUI.scene;
    const found = recordOf(scene, selection.name);
    if (found === null) return false;
    const id = editorIdOf(found.record);
    this.history.push({
      id: 0,
      label: `delete ${selection.name}`,
      kind: 'remove',
      editorId: id,
      at: found.position,
      copy: structuredClone(found.record),
      // The file's joints, when the delete takes some out with it: undo puts the list back.
      joints: jointsBeforeDelete(scene, selection.name),
    });
    this._remove(id);
    return true;
  }

  _remove(id) {
    const scene = this.debugUI.scene;
    const name = nameOfEditorId(scene, id);
    if (name !== null) removePlaced(scene, name);
    this._showRestored(-1);
  }

  /**
   * Rename the selected placed entity, and every entity param that names it; kept for undo.
   * @returns {boolean} false when the name is empty or taken
   */
  renameSelected(to) {
    const selection = this.selection;
    if (!selection.authored) return false;
    const scene = this.debugUI.scene;
    const from = selection.name;
    const found = recordOf(scene, from);
    if (found === null) return false;
    if (!renamePlaced(scene, from, to)) {
      this._setStatus(typeof to !== 'string' || to.trim() === '' ? 'A name cannot be empty' : `The file already has a ${to}`, true);
      return false;
    }
    const id = editorIdOf(found.record);
    this.history.push({ id: 0, label: `rename ${from} to ${to}`, kind: 'rename', editorId: id, from, to });
    this._showRestored(indexOfName(scene, to));
    return true;
  }

  _renameTo(id, name) {
    const scene = this.debugUI.scene;
    const current = nameOfEditorId(scene, id);
    if (current !== null && current !== name) renamePlaced(scene, current, name);
    this._showRestored(indexOfName(scene, name));
  }

  undo() {
    if (this.move.dragging) return;
    const change = this.history.undo();
    this._setStatus(change === null ? 'Nothing to undo' : `Undid: ${change.label}`, false);
  }

  redo() {
    if (this.move.dragging) return;
    const change = this.history.redo();
    this._setStatus(change === null ? 'Nothing to redo' : `Redid: ${change.label}`, false);
  }

  /** Select the entity a change respawned (or nothing: deleted, or its pool was full), and count the palette again. */
  _showRestored(index) {
    if (this._quiet) return;
    this.debugUI.hosted?.onDocumentChanged();
    if (index >= 0) this.selection.select(index);
    else this.selection.clear();
    this.palette.refresh();
    this._notify();
  }

  /**
   * Write the running scene file (its document as it is now) through the dev server.
   * @returns {Promise<boolean>} whether it was written
   */
  save() {
    if (this._saving === null) {
      this._saving = this._save().finally(() => {
        this._saving = null;
      });
    }
    return this._saving;
  }

  async _save() {
    const scene = this.debugUI.scene;
    if (!scene || !scene.sceneFile || !scene.sceneFileUrl) {
      this._setStatus('This scene was not loaded from a scene file: nothing to save', true);
      return false;
    }
    const name = new URL(scene.sceneFileUrl).pathname.split('/').pop();
    this._setStatus(`Saving ${name}…`, false);
    const position = this.history.position;
    try {
      await saveSceneFile(scene.sceneFileUrl, scene.sceneFile);
      this.history.markSaved(position);
      this._setStatus(`Saved ${name}`, false);
      return true;
    } catch (error) {
      console.error(`[WeedJS] editor: ${error.message}`);
      this._setStatus(error.message, true);
      return false;
    }
  }

  _setStatus(text, isError) {
    this.status = text;
    this.statusIsError = isError;
    clearTimeout(this._statusTimer);
    this._statusTimer = text === '' ? 0 : setTimeout(() => this._setStatus('', false), STATUS_MS);
    this._notify();
  }

  /** The debug UI's tick: the selection lets go of an entity that despawned, and its live values refresh. */
  update() {
    this.selection.update();
  }

  // ---- across a reload of the game page, in the editor page (D9) ----

  /**
   * What a reload of the game page keeps, as plain data the editor page copies: the file and its unsaved document,
   * the records' editor ids, the undo stack, edit mode, the selection, the grid and the view. A play session hands
   * over what Stop goes back to, so Stop works after a reload too.
   * @returns {object|null} null without a scene
   */
  handover() {
    if (!this.debugUI.scene) return null;
    const state = this._snapshot(false);
    state.data = undefined; // the page's own: the next page runs with its own data
    state.playStart = this._playStart === null ? null : { ...this._playStart, data: undefined };
    return state;
  }

  /**
   * Take up what the page before a reload handed over (handover), once the running scene is ready: the same scene
   * script, or nothing is done. The file it had open is opened again (a fast swap) when another one runs or its
   * document had unsaved changes, with that document; then its undo stack, edit mode, the view and the selection.
   * @param {object} kept - a copy of handover()'s data, made in this page
   * @returns {Promise<boolean>} whether it was taken up
   */
  async resume(kept) {
    const running = this.debugUI.scene;
    if (!running || !kept || kept.version !== 1 || kept.sceneScriptUrl !== running.sceneScriptUrl) return false;
    const reload = kept.sceneFileUrl !== null && (kept.document !== null || kept.sceneFileUrl !== running.sceneFileUrl);
    if (!(await this._restoreState(kept, reload, running.data))) return false;
    if (kept.playStart) this._playStart = { ...kept.playStart, data: running.data };
    return true;
  }

  /**
   * Put a snapshot back (Stop, resume): its file opened again with its document when `reload` (a swap the editor
   * makes itself: the undo stack stays), the records' editor ids by name, the undo stack, edit mode, the view, the
   * grid, the play speed and the selection.
   */
  async _restoreState(kept, reload, data) {
    const debugUI = this.debugUI;
    reserveEditorIds(kept.nextEditorId);
    if (reload) {
      const options = { data };
      if (kept.document !== null) options.sceneFile = kept.document;
      this.move.cancel();
      this._ownSwap = true;
      let ok;
      try {
        ok = await debugUI.gameEngine.loadScene(kept.sceneFileUrl, options);
      } finally {
        this._ownSwap = false;
      }
      if (ok === false) return false;
    }
    const scene = debugUI.scene;
    for (const [name, id] of kept.editorIds) {
      const found = recordOf(scene, name);
      if (found !== null) withEditorId(found.record, id);
    }
    this.history.load(kept.history);
    debugUI.hosted?.onDocumentChanged();
    this.move.snap = kept.snap;
    if (kept.active) {
      this.enter();
      if (kept.view !== null) {
        Camera.setFreeTarget(kept.view.x, kept.view.y);
        Camera.setZoom(kept.view.zoom);
      }
    }
    this.playSpeed = kept.playSpeed;
    const index = kept.selection === null ? -1 : indexOfName(scene, kept.selection);
    if (index >= 0 && this.active) this.selection.select(index);
    this.palette.refresh();
    this._changed();
    return true;
  }

  /** A fast swap put the time scale and the camera back to the level's start: hold them again. */
  onContentSwapped() {
    this.move.cancel();
    this._cancelTools();
    this.selection.clear();
    if (!this._ownSwap) this.history.clear(); // another document (Stop and resume put theirs back)
    this.layers.onSwapped(this.active); // the swap showed every layer as it booted: hide again while editing
    this.debugUI.hosted?.onDocumentChanged();
    this.palette.refresh();
    this._notify();
    if (!this.active) return;
    this._savedTimeScale = Time.scale;
    this._savedFree = Camera._free;
    this._panPointer = -1;
    this._hold();
  }

  /** The debug UI is leaving its scene (a full load): leave edit mode, and come back to it in the next scene. */
  onDetach() {
    this.history.clear();
    this._resumeOnAttach = this.active;
    this.exit();
    this.layers.reset(); // the next scene's layers are others
    this.selection.clear();
  }

  onAttach() {
    if (!this._resumeOnAttach) return;
    this._resumeOnAttach = false;
    this.enter();
  }

  _hold() {
    Time.scale = 0;
    Camera.setFree(true, { smoothing: 1 });
    Camera.held = true;
    Mouse.isEditModeActive = true;
    Mouse.isDebugToolActive = true;
  }

  _listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', this._onPointerDown);
    document[method]('pointermove', this._onPointerMove);
    document[method]('pointerup', this._onPointerUp);
    document[method]('contextmenu', this._onContextMenu);
  }

  /** The indicator, and in the editor page the toolbar, show the editor's state again. */
  _notify() {
    this.debugUI.tools.updateToolIndicator();
    this.debugUI.hosted?.onEditorChanged();
  }

  _changed() {
    const debugUI = this.debugUI;
    this._notify();
    debugUI.panels.scene.updateEditButton();
    debugUI._ensureTickLoop();
  }
}
