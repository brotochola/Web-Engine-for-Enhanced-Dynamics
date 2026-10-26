// The editor's undo and redo (VISUAL_EDITOR_PLAN.md D6, ED-12): a stack of changes; the document is unsaved while
// the stack is not where the last save or load left it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { History } from '../../src/core/debug/editor/history.js';

function changes() {
  const log = [];
  const change = (label) => ({ id: 0, label, undo: () => log.push(`undo ${label}`), redo: () => log.push(`redo ${label}`) });
  return { log, change };
}

test('undo and redo walk the stack; a new change drops what was undone', () => {
  const history = new History();
  const { log, change } = changes();
  assert.equal(history.undo(), null);
  history.push(change('a'));
  history.push(change('b'));
  assert.equal(history.undo().label, 'b');
  assert.equal(history.undo().label, 'a');
  assert.equal(history.undo(), null);
  assert.equal(history.redo().label, 'a');
  history.push(change('c'));
  assert.equal(history.canRedo, false, 'b is gone');
  assert.equal(history.redo(), null);
  assert.deepEqual(log, ['undo b', 'undo a', 'redo a']);
});

test('unsaved means away from the last save or load, whichever way', () => {
  const history = new History();
  const { change } = changes();
  assert.equal(history.dirty, false, 'as loaded');
  history.push(change('a'));
  assert.equal(history.dirty, true);
  history.undo();
  assert.equal(history.dirty, false, 'undone back to the file');
  history.redo();
  history.push(change('b'));
  history.markSaved();
  assert.equal(history.dirty, false);
  history.undo();
  assert.equal(history.dirty, true, 'undone past the save');
  history.redo();
  assert.equal(history.dirty, false, 'and back');
  history.undo();
  history.push(change('c'));
  assert.equal(history.dirty, true, 'a new change after undoing past the save: unsaved until the next save');
  history.clear();
  assert.deepEqual([history.dirty, history.canUndo, history.canRedo], [false, false, false], 'another document');
});

test('a save marks the position it wrote, not a change made while it was written', () => {
  const history = new History();
  const { change } = changes();
  history.push(change('a'));
  const position = history.position;
  history.push(change('b')); // while the save was on its way
  history.markSaved(position);
  assert.equal(history.dirty, true);
  history.undo();
  assert.equal(history.dirty, false, 'the file holds a');
});
