// editorHost.js — the game page's side of the editor page (VISUAL_EDITOR_PLAN.md D9, ED-15). In the editor page
// (shell/), the game's page runs in a same-origin iframe and its debug UI connects to the host there: it fills the
// docks (the toolbar, the scene's entities, the inspector, the assets, the console, its own debug bar), and before the
// page goes (a reload: hot reload, the Reload button) it hands over what the editor must keep (EditMode.handover).
// The next page gets it back from the host and takes it up once its scene is ready (EditMode.resume).
//
// What the host gets from here is let go of on pagehide (shell/editorShell.js says why); this side only puts nodes
// of its own into the docks and never listens on the host's.
//
// Two parts of the protocol came after its first form, and a page uses them only when its host has them: the dock
// keys (Ctrl+1, 2, 3 typed in this page fold the editor page's docks: host.dockKey) and the `status` dock (the line
// under the view, statusBar.js, ED-52), which then says what the indicator over the view and the overlay's pointer
// lines said.
//
// Cost: a page that is not in the editor page pays one property read, at construction.

import { isTypingTarget } from '../../../util/typingTarget.js';
import { loadDebugCss } from '../ui/debugDom.js';
import { EditorToolbar } from './toolbar.js';
import { EntityTree } from './entityTree.js';
import { ConsolePanel } from './consolePanel.js';
import { StatusBar } from './statusBar.js';
import { createConsoleForward } from '../../../util/consoleForward.js';

export { HOST_KEY, HOST_VERSION, findEditorHost, editorPageUrl } from '../editorPage.js';

/** The editor page's dock keys by KeyboardEvent.code, so a layout that shifts its digits has them too. */
const DOCK_DIGIT_CODES = Object.freeze({ Digit1: 1, Digit2: 2, Digit3: 3, Numpad1: 1, Numpad2: 2, Numpad3: 3 });

/**
 * The digit of Ctrl+1, Ctrl+2 or Ctrl+3 (Cmd on a Mac), or 0. The editor page reads its own keys the same way
 * (shell/editorLayout.js, dockKeyOf).
 * @param {KeyboardEvent} e
 */
export function dockDigitOf(e) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return 0;
  const byCode = DOCK_DIGIT_CODES[e.code];
  if (byCode !== undefined) return byCode;
  return e.key === '1' ? 1 : e.key === '2' ? 2 : e.key === '3' ? 3 : 0;
}

export class HostedEditor {
  /**
   * @param {object} debugUI
   * @param {object} host - the editor page's host (findEditorHost)
   */
  constructor(debugUI, host) {
    this.debugUI = debugUI;
    this.host = host;
    /** The docks, while connected; null after the page hid. */
    this.slots = null;
    /** What the page before this one handed over, until this page's scene takes it up. */
    this._kept = null;
    /** Nothing was handed over: the page opens editing, at the level's start, once a scene is attached (ED-80). */
    this._startEditing = false;
    this.toolbar = null;
    this.tree = null;
    /** The Console dock (ED-18), and this page's console passed on to it. */
    this.console = null;
    this._pageConsole = null;
    /** The status bar under the view (ED-52), when the editor page has a `status` dock. */
    this.status = null;
    this._onPageHide = () => this.disconnect();
    // Ctrl+1, 2, 3 typed in this page fold the editor page's docks: neither the game nor the browser (a tab switch)
    // gets them. A capture listener, so it sees them before the engine hands keys to the game or the editor.
    this._onDockKey = (e) => {
      const digit = dockDigitOf(e);
      if (digit === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.host.dockKey(digit);
    };
  }

  /** Connect to the host and fill its docks (the debug UI's constructor, once its own DOM is built). */
  connect() {
    const { slots, kept } = this.host.connect(this);
    this.slots = slots;
    // The host's copy is of its realm: this page works on a copy of its own.
    this._kept = kept === null || kept === undefined ? null : structuredClone(kept);
    this._startEditing = this._kept === null;
    window.addEventListener('pagehide', this._onPageHide);
    loadDebugCss().then((css) => {
      if (css && this.slots !== null) this.host.addStyles('debug-ui-styles', css);
    });
    const debugUI = this.debugUI;
    this.toolbar = new EditorToolbar(debugUI.editMode);
    this.tree = new EntityTree(debugUI);
    slots.toolbar.appendChild(this.toolbar.el);
    slots.tree.appendChild(this.tree.el);
    slots.debug.appendChild(debugUI.container);
    this._nameDebugTabs();
    // The console: this page's calls from now on, the workers' from each scene's attach.
    const panel = new ConsolePanel(debugUI);
    this.console = panel;
    slots.console.appendChild(panel.el);
    this._pageConsole = createConsoleForward(console, (entry) => panel.add('page', entry.level, entry.text));
    this._pageConsole.set(true);
    if (typeof this.host.dockKey === 'function') window.addEventListener('keydown', this._onDockKey, true);
    if (slots.status) this.mountStatus(slots.status);
  }

  /**
   * The status bar into the editor page's `status` dock: from now on it says what the tool indicator over the view
   * and the overlay's pointer and camera lines said, so those are not shown.
   * @param {Element} slot
   */
  mountStatus(slot) {
    const debugUI = this.debugUI;
    const status = new StatusBar(debugUI);
    this.status = status;
    slot.appendChild(status.el);
    debugUI.tools.showIndicator = false;
    debugUI.tools.updateToolIndicator();
    debugUI.canvas.showHud = false;
    status.update();
  }

  /** Whether the docks are there (connected, and the page has not hidden). */
  get connected() {
    return this.slots !== null;
  }

  /** A dock to put a panel's body into, or null once the page has hidden. */
  slot(name) {
    return this.slots === null ? null : this.slots[name] || null;
  }

  /** The page goes: hand over the editor's state (or the state it was handed and has not taken up yet). */
  disconnect() {
    if (this.slots === null) return;
    let state = this._kept;
    if (state === null) {
      try {
        state = this.debugUI.editMode.handover();
      } catch (error) {
        console.error('[WeedJS] editor: could not hand over its state', error);
      }
    }
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('keydown', this._onDockKey, true);
    this.slots = null;
    this.status = null;
    this._pageConsole?.set(false);
    this.tree?.destroy();
    this.console?.destroy(); // its observer of the docks goes now, not once it sees itself detached
    this.host.disconnect(this, state);
  }

  /** A scene is attached: the assets show its classes and files, the tree its entities. The first opens editing. */
  onAttach(scene) {
    const editMode = this.debugUI.editMode;
    editMode.palette.show();
    editMode.refreshSceneFiles();
    this.tree?.attach(scene);
    this.toolbar?.refresh();
    this.console?.newScene();
    this._nameDebugTabs(); // the Nav tab's own title goes when the scene has navigation
    if (this._startEditing) {
      this._startEditing = false;
      editMode.editFromStart();
    }
  }

  /** A narrow editor page shows the debug bar's tabs by their icons (editorShell.css): each names itself on hover. */
  _nameDebugTabs() {
    for (const tab of this.debugUI.container.querySelectorAll('.debug-ui-tab')) {
      if (!tab.title) tab.title = tab.children[1]?.textContent || '';
    }
  }

  onDetach() {
    this.tree?.detach();
  }

  /** The running scene is ready for loads: take up what the page before this one handed over, if it is its scene. */
  onSceneReady() {
    // The editor page shows this page's address (a demo page sets its ?scene= when one is chosen).
    this.host.sceneReady?.(this);
    const kept = this._kept;
    const scene = this.debugUI.scene;
    if (kept === null || !scene || kept.sceneScriptUrl !== scene.sceneScriptUrl) {
      this.debugUI.editMode.onSceneReady();
      return;
    }
    this._kept = null;
    this.debugUI.editMode.resume(kept).catch((error) => {
      console.error('[WeedJS] editor: could not take up the editor state from before the reload', error);
    });
  }

  /**
   * A key typed in the editor page: Shift+E toggles edit mode, Ctrl+S saves, and while editing the editor takes
   * its keys. A field keeps its keys, except Ctrl+S.
   * @param {KeyboardEvent} e
   */
  onHostKey(e) {
    // A key a panel already took (the scene list's arrows, a filter's Esc) is not the editor's too.
    if (e.defaultPrevented) return;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const typing = isTypingTarget(e.target);
    const debugUI = this.debugUI;
    if (e.shiftKey && key === 'e' && !e.repeat && !typing) {
      debugUI.toggleEditMode();
      e.preventDefault();
      return;
    }
    const save = (e.ctrlKey || e.metaKey) && key === 's';
    if (save) {
      e.preventDefault(); // never the browser's Save Page
      if (!debugUI.editing) {
        debugUI.editMode.save();
        return;
      }
    }
    if (debugUI.editing && (save || !typing) && debugUI.onEditKey(e)) e.preventDefault();
  }

  /** Whether the document has changes its file does not hold: the editor page asks before it unloads. */
  hasUnsavedChanges() {
    return this.debugUI.editMode.dirty;
  }

  /** Edit mode, the document, the status or the file changed: the toolbar shows it. */
  onEditorChanged() {
    this.toolbar?.refresh();
  }

  /** The document changed (an edit, undo, a swap): the tree lists it again. */
  onDocumentChanged() {
    this.tree?.invalidate();
  }

  /** The selection changed: the tree marks it, and shows it. */
  onSelectionChanged() {
    this.tree?.onSelectionChanged();
  }

  /** Leaving edit mode (Play): the game gets the keys. */
  onPlay() {
    this.host.focusGame?.();
  }

  /** The debug UI's tick. */
  update() {
    this.tree?.update();
    this.console?.update();
    this.status?.update();
  }

  destroy() {
    this.disconnect();
  }
}
