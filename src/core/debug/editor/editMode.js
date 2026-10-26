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
// Cost: nothing before the first Shift+E. Its listeners are on the document only while it is on.

import { Time } from '../../timeScale.js';
import { Camera } from '../../camera.js';
import { Mouse } from '../../mouse.js';

/** The buttons that pan (Pointer Events `buttons`: 2 secondary, 4 auxiliary). */
const PAN_BUTTONS = 2 | 4;

export class EditMode {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.active = false;

    // What entering found, put back on leaving.
    this._savedTimeScale = NaN;
    this._savedFree = false;
    this._savedFreeSmoothing = NaN;
    /** A full load left edit mode: enter it again when the new scene is attached. */
    this._resumeOnAttach = false;

    // A drag that pans: its pointer, where it started on screen, and the free camera's target then.
    this._panPointer = -1;
    this._panX = NaN;
    this._panY = NaN;
    this._panFromX = NaN;
    this._panFromY = NaN;

    this._onPointerDown = (e) => {
      if ((e.buttons & PAN_BUTTONS) === 0 || e.target !== this.debugUI.gameEngine?.canvas) return;
      e.preventDefault(); // no autoscroll on a middle press
      this._panPointer = e.pointerId;
      this._panX = e.clientX;
      this._panY = e.clientY;
      this._panFromX = Camera._freeFollowX;
      this._panFromY = Camera._freeFollowY;
    };
    this._onPointerMove = (e) => {
      if (e.pointerId !== this._panPointer) return;
      if ((e.buttons & PAN_BUTTONS) === 0) {
        this._panPointer = -1;
        return;
      }
      const zoom = Camera.zoom || 1;
      Camera.setFreeTarget(this._panFromX - (e.clientX - this._panX) / zoom, this._panFromY - (e.clientY - this._panY) / zoom);
    };
    this._onPointerUp = (e) => {
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
      this.exit();
      return true;
    }
    return false;
  }

  /** A fast swap put the time scale and the camera back to the level's start: hold them again. */
  onContentSwapped() {
    if (!this.active) return;
    this._savedTimeScale = Time.scale;
    this._savedFree = Camera._free;
    this._panPointer = -1;
    this._hold();
  }

  /** The debug UI is leaving its scene (a full load): leave edit mode, and come back to it in the next scene. */
  onDetach() {
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
