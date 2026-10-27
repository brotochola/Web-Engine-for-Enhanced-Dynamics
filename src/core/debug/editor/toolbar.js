// toolbar.js — the editor page's toolbar (VISUAL_EDITOR_PLAN.md D9, ED-15), made by the game page and put into the
// editor page's bar: Play or Edit, Stop (D8, ED-16), Save, Undo, Redo, the running scene file with its unsaved
// marker, and the editor's status line. refresh() writes only what changed; EditMode asks for it on each change of
// its own, never per frame.

const BUTTON_CLASS = 'weed-editor-button';

export class EditorToolbar {
  /** @param {object} editMode */
  constructor(editMode) {
    this.editMode = editMode;
    this.el = document.createElement('div');
    this.el.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
    this._mode = this._button('', () => editMode.toggle());
    this._stop = this._button('■ Stop', () => editMode.stop());
    this._save = this._button('Save', () => editMode.save(), 'Write the scene file (Ctrl+S)');
    this._undo = this._button('Undo', () => editMode.undo(), 'Undo (Ctrl+Z), while editing');
    this._redo = this._button('Redo', () => editMode.redo(), 'Redo (Ctrl+Y), while editing');
    this._file = document.createElement('span');
    this._file.style.cssText = 'color:#c8ccd8;white-space:nowrap;margin-left:6px';
    this._status = document.createElement('span');
    this._status.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0';
    this.el.append(this._mode, this._stop, this._save, this._undo, this._redo, this._file, this._status);
    /** What is shown, so a refresh that changes nothing writes nothing. */
    this._shown = { editing: null, playing: null, dirty: null, canUndo: null, canRedo: null, file: null, status: null, error: null };
    this.refresh();
  }

  refresh() {
    const editMode = this.editMode;
    const shown = this._shown;
    const editing = editMode.active;
    const playing = editMode.playing;
    if (shown.editing !== editing || shown.playing !== playing) {
      shown.editing = editing;
      shown.playing = playing;
      this._mode.textContent = editing ? '▶ Play' : '❚❚ Edit';
      this._mode.title = editing
        ? 'Play from here (Shift+E); Stop comes back'
        : 'Pause into edit mode: the world holds still, the view is yours (Shift+E)';
      this._mode.classList.toggle('active', editing);
      this._stop.classList.toggle('active', playing);
      this._stop.title = playing
        ? 'Stop: back to the level Play started from, as its document has it, in edit mode'
        : 'Back to the level’s start as its document has it, in edit mode (a fast swap)';
    }
    const canUndo = editing && editMode.history.canUndo;
    const canRedo = editing && editMode.history.canRedo;
    if (shown.canUndo !== canUndo) this._undo.disabled = !(shown.canUndo = canUndo);
    if (shown.canRedo !== canRedo) this._redo.disabled = !(shown.canRedo = canRedo);
    const dirty = editMode.dirty;
    const file = editMode.sceneFileName;
    if (shown.dirty !== dirty || shown.file !== file) {
      shown.dirty = dirty;
      shown.file = file;
      this._file.textContent = file === null ? 'no scene file' : dirty ? `${file} ●` : file;
      this._file.title = dirty ? 'Unsaved changes: Ctrl+S writes them' : '';
      this._save.disabled = file === null;
      this._stop.disabled = file === null;
    }
    const status = editMode.status || (playing ? 'Playing: Stop goes back to the level' : '');
    if (shown.status !== status || shown.error !== editMode.statusIsError) {
      shown.status = status;
      shown.error = editMode.statusIsError;
      this._status.textContent = status;
      this._status.style.color = editMode.statusIsError ? '#f87171' : '#8a90a0';
    }
  }

  _button(text, onclick, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = text;
    button.title = title;
    button.onclick = onclick;
    return button;
  }
}
