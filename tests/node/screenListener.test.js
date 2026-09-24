import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../src/core/camera.js';
import { noteScreenVisibility } from '../../src/components/cameraInOutListener.js';

test('CameraInOutListener enter and exit follow the camera box', () => {
  const prevData = Camera._data;
  const prevW = Camera._canvasWidth;
  const prevH = Camera._canvasHeight;
  Camera._data = new Float32Array([1, 0, 0]);
  Camera._canvasWidth = 200;
  Camera._canvasHeight = 200;
  const events = [];
  const obj = {
    onScreenEnter() { events.push('enter'); },
    onScreenExit() { events.push('exit'); },
  };
  try {
    const on = Camera.isOnScreen(100, 80) ? 1 : 0;
    noteScreenVisibility(on, 0, obj);
    assert.equal(on, 1);
    assert.deepEqual(events, ['enter']);
    Camera._data[1] = 500;
    const off = Camera.isOnScreen(100, 80) ? 1 : 0;
    noteScreenVisibility(off, on, obj);
    assert.equal(off, 0);
    assert.deepEqual(events, ['enter', 'exit']);
    noteScreenVisibility(off, off, obj);
    assert.deepEqual(events, ['enter', 'exit']);
  } finally {
    Camera._data = prevData;
    Camera._canvasWidth = prevW;
    Camera._canvasHeight = prevH;
  }
});
