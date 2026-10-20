import test from 'node:test';
import assert from 'node:assert/strict';

import { Mouse } from '../../src/core/mouse.js';

// Pointer Events fire pointerdown for the first button pressed and pointerup for the
// last one released. Every other press or release in a chord arrives as a pointermove
// whose `button` names the changed button and whose `buttons` mask is the new state
// (spec: "chorded button interactions"). Masks: 1 primary, 2 secondary, 4 auxiliary.

function boot() {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  Mouse.reset();
  Mouse.isDebugToolActive = false;
}

function ev(button, buttons) {
  return { pointerId: 1, pointerType: 'mouse', button, buttons, clientX: 10, clientY: 20, currentTarget: null };
}

test('left, then right, release left, release right: nothing stays held', () => {
  boot();
  Mouse.pointerDown(ev(0, 1));
  Mouse.pointerMove(ev(2, 3));
  assert.equal(Mouse.isButton0Down, true);
  assert.equal(Mouse.isButton2Down, true, 'the chorded right press arrives as a move');
  Mouse.pointerMove(ev(0, 2));
  assert.equal(Mouse.isButton0Down, false, 'the first release arrives as a move');
  assert.equal(Mouse.isButton2Down, true);
  Mouse.pointerUp(ev(2, 0));
  assert.equal(Mouse.isButton0Down, false);
  assert.equal(Mouse.isButton2Down, false);
  assert.equal(Mouse.count, 0);
});

test('right, then left, release right, release left: the cursor can leave', () => {
  boot();
  Mouse.pointerDown(ev(2, 2));
  Mouse.pointerMove(ev(0, 3));
  assert.equal(Mouse.isButton0Down, true);
  Mouse.pointerMove(ev(2, 1));
  assert.equal(Mouse.isButton2Down, false);
  Mouse.pointerUp(ev(0, 0));
  assert.equal(Mouse.isButton0Down, false);
  assert.equal(Mouse.isButton2Down, false);
  Mouse.pointerLeave(ev(-1, 0));
  assert.equal(Mouse.isPresent, false, 'no button is held, so leaving clears presence');
});

test('a chorded press and release each produce one edge', () => {
  boot();
  Mouse.updateEdgeFlags();
  Mouse.pointerDown(ev(0, 1));
  Mouse.pointerMove(ev(1, 5));
  Mouse.updateEdgeFlags();
  assert.equal(Mouse.isButton0Pressed, true);
  assert.equal(Mouse.isButton1Pressed, true, 'middle press inside a chord');
  Mouse.pointerMove(ev(-1, 5));
  Mouse.updateEdgeFlags();
  assert.equal(Mouse.isButton1Pressed, false, 'a plain move with the same mask adds no edge');
  Mouse.pointerMove(ev(1, 1));
  Mouse.updateEdgeFlags();
  assert.equal(Mouse.isButton1Released, true);
  assert.equal(Mouse.isButton1Down, false);
  assert.equal(Mouse.isButton0Down, true);
});

test('a drag that started outside the canvas does not start a press', () => {
  boot();
  // Button already held when the pointer enters (a DOM slider drag): no pointerdown here.
  Mouse.pointerMove(ev(-1, 1));
  Mouse.updateEdgeFlags();
  assert.equal(Mouse.isButton0Down, false);
  assert.equal(Mouse.isButton0Pressed, false);
});

test('the debug tool still consumes the primary button in a chord', () => {
  boot();
  Mouse.isDebugToolActive = true;
  Mouse.pointerDown(ev(0, 1));
  assert.equal(Mouse.isButton0Down, false);
  Mouse.pointerUp(ev(0, 0));
  assert.equal(Mouse.isButton0Down, false);
  Mouse.isDebugToolActive = false;
});

test('an event without a buttons mask still uses button', () => {
  boot();
  Mouse.pointerDown({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, currentTarget: null });
  assert.equal(Mouse.isButton0Down, true);
  Mouse.pointerMove({ pointerId: 1, pointerType: 'mouse', button: -1, clientX: 1, clientY: 1, currentTarget: null });
  assert.equal(Mouse.isButton0Down, true, 'no mask on the move: keep the held state');
  Mouse.pointerUp({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 1, clientY: 1, currentTarget: null });
  assert.equal(Mouse.isButton0Down, false);
});
