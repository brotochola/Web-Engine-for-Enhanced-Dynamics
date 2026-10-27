// editorHost.js — the game page's side of the editor page (VISUAL_EDITOR_PLAN.md D9, ED-15). In the editor page
// (shell/), the game's page runs in a same-origin iframe and its debug UI connects to the host there: it fills the
// docks (the toolbar, the scene's entities, the inspector, the assets, the console, its own debug bar), and before the
// page goes (a reload: hot reload, the Reload button) it hands over what the editor must keep (EditMode.handover).
// The next page gets it back from the host and takes it up once its scene is ready (EditMode.resume).
//
// What the host gets from here is let go of on pagehide (shell/editorShell.js says why); this side only puts nodes
// of its own into the docks and never listens on the host's.
//
// Cost: a page that is not in the editor page pays one property read, at construction.

import { isTypingTarget } from '../../../util/typingTarget.js';
import { loadDebugCss } from '../ui/debugDom.js';
import { EditorToolbar } from './toolbar.js';
import { EntityTree } from './entityTree.js';
import { ConsolePanel } from './consolePanel.js';
import { createConsoleForward } from '../../../util/consoleForward.js';

export { HOST_KEY, HOST_VERSION, findEditorHost, editorPageUrl } from '../editorPage.js';

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
    this.toolbar = null;
    this.tree = null;
    /** The Console dock (ED-18), and this page's console passed on to it. */
    this.console = null;
    this._pageConsole = null;
    this._onPageHide = () => this.disconnect();
  }

  /** Connect to the host and fill its docks (the debug UI's constructor, once its own DOM is built). */
  connect() {
    const { slots, kept } = this.host.connect(this);
    this.slots = slots;
    // The host's copy is of its realm: this page works on a copy of its own.
    this._kept = kept === null || kept === undefined ? null : structuredClone(kept);
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
    // The console: this page's calls from now on, the workers' from each scene's attach.
    const panel = new ConsolePanel(debugUI);
    this.console = panel;
    slots.console.appendChild(panel.el);
    this._pageConsole = createConsoleForward(console, (entry) => panel.add('page', entry.level, entry.text));
    this._pageConsole.set(true);
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
    this.slots = null;
    this._pageConsole?.set(false);
    this.tree?.destroy();
    this.host.disconnect(this, state);
  }

  /** A scene is attached: the assets show its classes and files, the tree its entities. */
  onAttach(scene) {
    const editMode = this.debugUI.editMode;
    editMode.palette.show();
    editMode.refreshSceneFiles();
    this.tree?.attach(scene);
    this.toolbar?.refresh();
    this.console?.newScene();
  }

  onDetach() {
    this.tree?.detach();
  }

  /** The running scene is ready for loads: take up what the page before this one handed over, if it is its scene. */
  onSceneReady() {
    const kept = this._kept;
    const scene = this.debugUI.scene;
    if (kept === null || !scene || kept.sceneScriptUrl !== scene.sceneScriptUrl) return;
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
  }

  destroy() {
    this.disconnect();
  }
}
