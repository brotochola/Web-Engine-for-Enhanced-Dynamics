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
// keys (Shift: ten steps); G cycles the grid step. Esc clears the selection, and with none leaves edit mode. Ctrl+S
// saves the running scene file through the dev server (sceneFileStore.js, ED-13). Every change to the document goes
// through editSelected and is kept for Ctrl+Z / Ctrl+Y (history.js, ED-12).
//
// Cost: nothing before the first Shift+E. Its listeners are on the document only while it is on.

import { Time } from '../../timeScale.js';
import { Camera } from '../../camera.js';
import { Mouse } from '../../mouse.js';
import { saveSceneFile } from './sceneFileStore.js';
import { Selection } from './selection.js';
import { MoveTool, SNAP_STEPS } from './moveTool.js';
import { History } from './history.js';
import { editPlaced, restorePlaced } from './sceneDocument.js';

/** The buttons that pan (Pointer Events `buttons`: 2 secondary, 4 auxiliary). */
const PAN_BUTTONS = 2 | 4;
/** The button that selects (primary). */
const SELECT_BUTTON = 1;

/** How long a status line (saved, could not save) stays on the indicator. */
const STATUS_MS = 3000;

export class EditMode {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.active = false;
    this.selection = new Selection(debugUI);
    this.selection.editor = this;
    this.move = new MoveTool(this.selection);
    this.history = new History();

    // What entering found, put back on leaving.
    this._savedTimeScale = NaN;
    this._savedFree = false;
    this._savedFreeSmoothing = NaN;
    /** A full load left edit mode: enter it again when the new scene is attached. */
    this._resumeOnAttach = false;

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
        this.move.press(Mouse.x, Mouse.y, e.clientX, e.clientY);
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
      if ((e.buttons & SELECT_BUTTON) !== 0) this.move.move(Mouse.x, Mouse.y, e.clientX, e.clientY);
      if (e.pointerId !== this._panPointer) return;
      if ((e.buttons & PAN_BUTTONS) === 0) {
        this._panPointer = -1;
        return;
      }
      const zoom = Camera.zoom || 1;
      Camera.setFreeTarget(this._panFromX - (e.clientX - this._panX) / zoom, this._panFromY - (e.clientY - this._panY) / zoom);
    };
    this._onPointerUp = (e) => {
      if ((e.buttons & SELECT_BUTTON) === 0) this.move.release();
      if (e.pointerId === this._panPointer && (e.buttons & PAN_BUTTONS) === 0) this._panPointer = -1;
    };
    this._onContextMenu = (e) => {
      if (e.target === this.debugUI.gameEngine?.canvas) e.preventDefault(); // a right drag pans
    };
  }

  toggle() {
    if (this.active) this.exit();
    else this.enter();
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
    this._listen(true);
    this._changed();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this._listen(false);
    this._panPointer = -1;
    this.move.cancel();
    this.selection.clear();
    this._setStatus('', false);
    Mouse.isEditModeActive = false;
    Camera.held = false;
    Camera.setFree(this._savedFree, { smoothing: this._savedFreeSmoothing });
    Time.scale = this._savedTimeScale;
    this.debugUI.tools._syncDebugToolFlag();
    this._changed();
  }

  /**
   * A key pressed while editing: GameEngine hands every keydown here then, and none to the game.
   * @param {KeyboardEvent} e
   * @returns {boolean} whether it was the editor's
   */
  onKey(e) {
    if (e.key === 'Escape') {
      if (this.selection.index >= 0) this.selection.clear();
      else this.exit();
      return true;
    }
    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 's':
        case 'S':
          this.save();
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
    const name = selection.name;
    const result = editPlaced(this.debugUI.scene, name, write);
    if (result === null) return -1;
    const { before, after } = result;
    this.history.push({
      id: 0,
      label,
      undo: () => this._showRestored(restorePlaced(this.debugUI.scene, name, before)),
      redo: () => this._showRestored(restorePlaced(this.debugUI.scene, name, after)),
    });
    this._showRestored(result.index);
    return result.index;
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

  /** Select the entity a change respawned (or nothing, when its pool was full). */
  _showRestored(index) {
    if (index >= 0) this.selection.select(index);
    else this.selection.clear();
    this.debugUI.tools.updateToolIndicator();
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
    this.debugUI.tools.updateToolIndicator();
  }

  /** The debug UI's tick, while edit mode is on. */
  update() {
    this.selection.update();
  }

  /** A fast swap put the time scale and the camera back to the level's start: hold them again. */
  onContentSwapped() {
    this.move.cancel();
    this.selection.clear();
    this.history.clear(); // another document
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

  _changed() {
    const debugUI = this.debugUI;
    debugUI.tools.updateToolIndicator();
    debugUI.panels.scene.updateEditButton();
    debugUI._ensureTickLoop();
  }
}
