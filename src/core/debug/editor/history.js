// history.js — undo and redo for the editor (VISUAL_EDITOR_PLAN.md D6, ED-12): the changes made to the running scene
// file's document, newest last, each with how to undo and redo it. The document has unsaved changes when the stack
// is not where the last save (or the load) left it, so undoing back to a save is clean again, and a new change made
// after undoing past one leaves it dirty until the next save.

export class History {
  constructor() {
    this._done = [];
    this._undone = [];
    this._nextId = 1;
    /** The change on top of the stack at the last save or load (its id); 0 is the document as loaded. */
    this._savedId = 0;
  }

  /**
   * A change just made. It drops whatever was undone.
   * @param {{ label: string, undo: () => void, redo: () => void }} change
   */
  push(change) {
    change.id = this._nextId++;
    this._done.push(change);
    this._undone.length = 0;
  }

  /** Undo the newest change: it is returned, or null when there is none. */
  undo() {
    const change = this._done.pop();
    if (change === undefined) return null;
    change.undo();
    this._undone.push(change);
    return change;
  }

  /** Redo the change undone last: it is returned, or null when there is none. */
  redo() {
    const change = this._undone.pop();
    if (change === undefined) return null;
    change.redo();
    this._done.push(change);
    return change;
  }

  get canUndo() {
    return this._done.length > 0;
  }

  get canRedo() {
    return this._undone.length > 0;
  }

  /** The document differs from the file as last saved or loaded. */
  get dirty() {
    return this._topId() !== this._savedId;
  }

  /** Where the stack is now, for markSaved once a save of the document as it is now has been written. */
  get position() {
    return this._topId();
  }

  /**
   * The file now holds the document as it was at `position` (a save started then; changes made while it was
   * written stay unsaved).
   * @param {number} [position]
   */
  markSaved(position = this._topId()) {
    this._savedId = position;
  }

  /** Another document: nothing to undo, nothing unsaved. */
  clear() {
    this._done.length = 0;
    this._undone.length = 0;
    this._savedId = 0;
  }

  _topId() {
    const done = this._done;
    return done.length === 0 ? 0 : done[done.length - 1].id;
  }
}
