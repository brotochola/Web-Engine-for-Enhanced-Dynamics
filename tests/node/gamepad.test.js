import test from 'node:test';
import assert from 'node:assert/strict';

import { Gamepad } from '../../src/core/gamepad.js';

function makeFakePad({ axes = [0, 0, 0, 0], buttons = [] } = {}) {
  const btn = (pressed, value = pressed ? 1 : 0) => ({ pressed: !!pressed, value });
  const list = [];
  for (let i = 0; i < Gamepad.BUTTONS_PER_PAD; i++) {
    const entry = buttons[i];
    if (entry == null) {
      list.push(btn(false));
    } else if (typeof entry === 'number') {
      list.push(btn(entry >= 0.5, entry));
    } else {
      list.push(entry);
    }
  }
  return { axes, buttons: list, connected: true };
}

function withGamepads(pads, fn) {
  const nav = globalThis.navigator;
  const prevDesc = Object.getOwnPropertyDescriptor(nav, 'getGamepads');
  Object.defineProperty(nav, 'getGamepads', {
    configurable: true,
    writable: true,
    value: () => pads,
  });
  try {
    return fn();
  } finally {
    if (prevDesc) {
      Object.defineProperty(nav, 'getGamepads', prevDesc);
    } else {
      delete nav.getGamepads;
    }
  }
}

test('BUFFER_SIZE matches MAX_PADS * STRIDE * 4', () => {
  assert.equal(Gamepad.BUFFER_SIZE, Gamepad.MAX_PADS * Gamepad.STRIDE * 4);
  assert.equal(Gamepad.STRIDE, 1 + Gamepad.AXES_PER_PAD + Gamepad.BUTTONS_PER_PAD * 2);
});

test('held state and pad-0 ergonomics after poll', () => {
  const buffer = new Float32Array(Gamepad.MAX_PADS * Gamepad.STRIDE);
  Gamepad.initialize(buffer);

  withGamepads(
    [
      makeFakePad({
        axes: [0.8, -0.9, 0.02, 0.5],
        buttons: { 0: 1, 6: 0.75 },
      }),
    ],
    () => {
      Gamepad.poll();
    }
  );

  assert.equal(Gamepad.isConnected(0), true);
  assert.equal(Gamepad.isConnected(1), false);
  assert.ok(Math.abs(Gamepad.getAxis(0, 0) - 0.8) < 1e-6);
  assert.ok(Math.abs(Gamepad.leftY - -0.9) < 1e-6);
  // Deadzone zeros tiny rightX
  assert.equal(Gamepad.rightX, 0);
  assert.ok(Math.abs(Gamepad.rightY - 0.5) < 1e-6);
  assert.equal(Gamepad.isADown, true);
  assert.equal(Gamepad.isBDown, false);
  assert.ok(Math.abs(Gamepad.getButton(0, Gamepad.LT) - 0.75) < 1e-6);
  assert.equal(Gamepad.isLTDown, true);

  Gamepad.initialize(null);
});

test('rising edge bumps press counter and updateEdgeFlags', () => {
  const buffer = new Float32Array(Gamepad.MAX_PADS * Gamepad.STRIDE);
  Gamepad.initialize(buffer);

  withGamepads([makeFakePad()], () => Gamepad.poll());
  Gamepad.updateEdgeFlags();
  assert.equal(Gamepad.isAPressed, false);

  withGamepads([makeFakePad({ buttons: { 0: 1 } })], () => Gamepad.poll());
  Gamepad.updateEdgeFlags();
  assert.equal(Gamepad.isAPressed, true);
  assert.equal(Gamepad.isButtonPressed(0, Gamepad.A), true);

  // Held another frame — no new edge
  withGamepads([makeFakePad({ buttons: { 0: 1 } })], () => Gamepad.poll());
  Gamepad.updateEdgeFlags();
  assert.equal(Gamepad.isAPressed, false);
  assert.equal(Gamepad.isADown, true);

  Gamepad.initialize(null);
});

test('multipad: pad 1 independent of pad 0', () => {
  const buffer = new Float32Array(Gamepad.MAX_PADS * Gamepad.STRIDE);
  Gamepad.initialize(buffer);

  withGamepads(
    [
      makeFakePad({ buttons: { 0: 1 } }),
      makeFakePad({ axes: [0.6, 0, 0, 0], buttons: { 1: 1 } }),
    ],
    () => Gamepad.poll()
  );
  Gamepad.updateEdgeFlags();

  assert.equal(Gamepad.isConnected(0), true);
  assert.equal(Gamepad.isConnected(1), true);
  assert.equal(Gamepad.isButtonDown(0, Gamepad.A), true);
  assert.equal(Gamepad.isButtonDown(1, Gamepad.A), false);
  assert.equal(Gamepad.isButtonDown(1, Gamepad.B), true);
  assert.equal(Gamepad.isButtonPressed(1, Gamepad.B), true);
  assert.ok(Math.abs(Gamepad.getAxis(1, 0) - 0.6) < 1e-6);

  Gamepad.initialize(null);
});

test('disconnect clears axes/buttons but leaves press counters', () => {
  const buffer = new Float32Array(Gamepad.MAX_PADS * Gamepad.STRIDE);
  Gamepad.initialize(buffer);

  withGamepads([makeFakePad({ buttons: { 0: 1 }, axes: [0.7, 0, 0, 0] })], () => Gamepad.poll());
  Gamepad.updateEdgeFlags();
  const pressBefore = buffer[Gamepad._PRESS0];

  withGamepads([null], () => Gamepad.poll());
  assert.equal(Gamepad.isConnected(0), false);
  assert.equal(Gamepad.leftX, 0);
  assert.equal(Gamepad.isADown, false);
  assert.equal(buffer[Gamepad._PRESS0], pressBefore);

  Gamepad.initialize(null);
});

test('poll is no-op without navigator.getGamepads', () => {
  const buffer = new Float32Array(Gamepad.MAX_PADS * Gamepad.STRIDE);
  Gamepad.initialize(buffer);
  const prev = globalThis.navigator;
  delete globalThis.navigator;

  Gamepad.poll();
  assert.equal(Gamepad.isConnected(0), false);

  if (prev !== undefined) globalThis.navigator = prev;
  Gamepad.initialize(null);
});
