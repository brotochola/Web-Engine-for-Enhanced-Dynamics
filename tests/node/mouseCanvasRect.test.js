import test from 'node:test';
import assert from 'node:assert/strict';

import { Mouse } from '../../src/core/mouse.js';

// Review G7. pointerup read the canvas box twice, once for the position and
// once for the inside test. It reads it once now and uses it for both.

function canvas(rect) {
  return {
    reads: 0,
    getBoundingClientRect() {
      this.reads++;
      return rect;
    },
  };
}

test('positions are canvas-relative and pointerup reads the canvas box once', () => {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  Mouse.reset();
  Mouse.isDebugToolActive = false;
  const el = canvas({ left: 100, top: 50, right: 740, bottom: 530 });
  const ev = (clientX, clientY, buttons) => ({
    pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX, clientY, currentTarget: el,
  });

  Mouse.pointerDown(ev(130, 80, 1));
  assert.equal(Mouse.canvasXAt(0), 30);
  assert.equal(Mouse.canvasYAt(0), 30);

  el.reads = 0;
  Mouse.pointerUp(ev(140, 95, 0));
  assert.equal(el.reads, 1, 'one box read for the position and the inside test');
  assert.equal(Mouse.canvasXAt(0), 40);
  assert.equal(Mouse.canvasYAt(0), 45);
  assert.equal(Mouse.isPresent, true, 'released inside: the cursor stays');

  Mouse.pointerDown(ev(130, 80, 1));
  el.reads = 0;
  Mouse.pointerUp(ev(900, 80, 0));
  assert.equal(el.reads, 1);
  assert.equal(Mouse.isPresent, false, 'released outside: the cursor leaves');
});
