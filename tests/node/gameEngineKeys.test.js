import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';

// GameEngine keeps arrows, space and Tab from scrolling the page (preventDefaultKeys). It did so for a key typed
// into a field too: a game's own HTML input took no space, no arrow and no Tab. A field's keys are the field's now;
// the game still gets them.

test('GameEngine: arrows, space and Tab keep their default in a field, and the game still gets them', () => {
  const windowListeners = new Map();
  globalThis.window = { addEventListener: (type, fn) => windowListeners.set(type, fn) };
  globalThis.document = { addEventListener: () => {} };
  try {
    const keys = [];
    const engine = { preventDefaultKeys: true, debugEnabled: false, currentScene: { onKeyDown: (key) => keys.push(key) } };
    GameEngine.prototype._setupWindowListeners.call(engine);
    const keydown = windowListeners.get('keydown');
    const press = (key, target = null) => {
      const e = { key, shiftKey: false, target, defaultPrevented: false };
      e.preventDefault = () => (e.defaultPrevented = true);
      keydown(e);
      return e.defaultPrevented;
    };

    assert.equal(press(' '), true, 'a space for the game does not scroll the page');
    assert.equal(press('ArrowDown'), true);
    assert.equal(press(' ', { tagName: 'INPUT' }), false, 'a space typed in a field is the field’s');
    assert.equal(press('ArrowLeft', { tagName: 'TEXTAREA' }), false);
    assert.equal(press('Tab', { tagName: 'SELECT' }), false, 'Tab moves to the next field');
    assert.equal(press('ArrowUp', { tagName: 'DIV', isContentEditable: true }), false);
    assert.equal(press('ArrowUp', { tagName: 'DIV' }), true, 'a plain element is not a field');
    assert.deepEqual(keys, [' ', 'arrowdown', ' ', 'arrowleft', 'tab', 'arrowup', 'arrowup']);

    engine.preventDefaultKeys = false;
    assert.equal(press(' '), false, 'nothing prevented when the game asks for nothing');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});
