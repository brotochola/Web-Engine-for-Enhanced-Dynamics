// The inspector's sections that fold (VISUAL_EDITOR_PLAN.md ED-54, inspectorSection.js, selection.js): Transform and
// Params open, Joints only for a class with a body (open when the entity has joints), Live folded until opened, and
// folded it builds no rows. A click on a header folds it, and the fold is remembered (guarded storage).
import test from 'node:test';
import assert from 'node:assert/strict';

import { InspectorSection, resetRememberedFolds } from '../../src/core/debug/editor/inspectorSection.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.title = '';
    this.className = '';
    this._text = '';
    this.parentNode = null;
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = String(text);
    this.children = [];
  }
  get ownerDocument() {
    return globalThis.document;
  }
  setPointerCapture() {}
  blur() {}
}

function withDom(storage, fn) {
  globalThis.document = { createElement: (tag) => new El(tag), activeElement: null };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
  resetRememberedFolds();
  try {
    return fn();
  } finally {
    delete globalThis.document;
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
    resetRememberedFolds();
  }
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test('a section: open or folded at first, a header click folds it and is remembered; storage that throws is fine', () => {
  for (const storage of [memoryStorage(), { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }]) {
    withDom(storage, () => {
      const toggles = [];
      const live = new InspectorSection('live', 'Live', { open: false, onToggle: (open) => toggles.push(open) });
      assert.equal(live.open, false);
      assert.equal(live.body.style.display, 'none');
      live.head.onclick({ target: live.head });
      assert.deepEqual([live.open, live.body.style.display, toggles], [true, '', [true]]);
      resetRememberedFolds();
      const again = new InspectorSection('live', 'Live', { open: false });
      const remembered = storage.getItem !== undefined && !String(storage.getItem).includes('throw');
      assert.equal(again.open, remembered, remembered ? 'remembered across inspectors' : 'blocked storage: the default');
      const button = new El('button');
      live.actions.appendChild(button);
      live.head.onclick({ target: button });
      assert.equal(live.open, true, 'a button on the header does not fold it');
    });
  }
});

test('the inspector: Transform and Params open; Joints only with a body; Live folded builds no rows until opened', () => {
  withDom(memoryStorage(), () => {
    const world = makeWorld();
    try {
      const selection = world.editMode.selection;
      delete selection._show; // the real one, over the fake DOM
      selection.debugUI.hosted = { slot: () => new El('div'), onSelectionChanged() {} };
      world.select('Block1');
      const { transform, params, joints, live } = selection._sections;
      assert.deepEqual([transform.el.style.display, transform.open, params.el.style.display, params.open], ['', true, '', true]);
      assert.equal(joints.el.style.display, 'none', 'a Block has no RigidBody');
      assert.deepEqual([live.open, selection.live._index], [false, -1], 'Live folded: nothing shown, nothing to tick');

      world.scene.registeredClasses.find((r) => r.class.name === 'Block').components = [RigidBody];
      world.scene.sceneFile.joints = [{ type: 'weld', a: 'Block1', b: 'Ball1' }];
      world.select('Block1');
      assert.deepEqual([joints.el.style.display, joints.open, joints.note.textContent], ['', true, '1'], 'with a body and a joint: open, counted');

      live.head.onclick({ target: live.head });
      assert.equal(selection.live._index, world.indexOf('Block1'), 'opened: the live rows');
      live.head.onclick({ target: live.head });
      assert.equal(selection.live._index, -1, 'folded again: cleared');
    } finally {
      world.done();
    }
  });
});
