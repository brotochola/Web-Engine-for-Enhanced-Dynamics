// history.js — undo and redo for the editor (VISUAL_EDITOR_PLAN.md D6, ED-12): the changes made to the running scene
// file's document, newest last. The document has unsaved changes when the stack is not where the last save (or the
// load) left it, so undoing back to a save is clean again, and a new change made after undoing past one leaves it
// dirty until the next save.
//
// A change is data (its kind, the record's editor id, what it was before and after: EditMode makes them), and the
// `apply(change, forward)` given to the constructor carries one out, forward for a redo and backward for an undo. As
// data, the stack can be handed over (toData) and taken up again (load) by the next game page when the editor page
// keeps it across a reload (D9).

export class History {
  /** @param {(change: object, forward: boolean) => void} apply */
  constructor(apply) {
    this._apply = apply;
    this._done = [];
    this._undone = [];
    this._nextId = 1;
    /** The change on top of the stack at the last save or load (its id); 0 is the document as loaded. */
    this._savedId = 0;
  }

  /**
   * A change just made. It drops whatever was undone.
   * @param {{ label: string, kind: string }} change - plain data, as apply takes it
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
    this._apply(change, false);
    this._undone.push(change);
    return change;
  }

  /** Redo the change undone last: it is returned, or null when there is none. */
  redo() {
    const change = this._undone.pop();
    if (change === undefined) return null;
    this._apply(change, true);
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

  /** The stack as plain data (the changes themselves, not copies): what load takes. */
  toData() {
    return { done: this._done, undone: this._undone, nextId: this._nextId, savedId: this._savedId };
  }

  /** Take up a stack toData gave, where it was: its changes, its position and its save. */
  load(data) {
    this._done = data.done.slice();
    this._undone = data.undone.slice();
    this._nextId = data.nextId;
    this._savedId = data.savedId;
  }

  _topId() {
    const done = this._done;
    return done.length === 0 ? 0 : done[done.length - 1].id;
  }
}
