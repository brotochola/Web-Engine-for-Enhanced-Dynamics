// SST-0: the renderer's 'first draw' load mark comes with the first frame it presents once the game runs, whatever path
// the frame took to the canvas: Pixi's own render (a scene with no pass into a target, as bunnyMark), or the engine's
// passes. Not while paused (a preload's present), and once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';

globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};

function loadMarkMessages() {
  return postedMessages().filter((m) => m && m.msg === 'loadMarks');
}

test("the renderer's first presented frame posts 'first draw', through Pixi's own render too", async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  let presented = 0;
  // Pixi's render as _takePresentOwnership keeps it: the stage drawn without the engine's _submitRender.
  px._pixiPresent = () => {
    presented++;
  };
  px._presentingFlag = null;
  px._presenting = true;
  px._loadMarksOpen = true;
  const before = loadMarkMessages().length;

  px.isPaused = true;
  px._presentStage();
  assert.equal(presented, 1, 'a paused present draws (a preload\'s setLayerContent)');
  assert.equal(loadMarkMessages().length, before, 'and posts no mark');

  px.isPaused = false;
  px._presentStage();
  assert.equal(presented, 2);
  const posted = loadMarkMessages();
  assert.equal(posted.length, before + 1, 'the first frame once the game runs posts the marks');
  const marks = posted[posted.length - 1].marks;
  assert.ok(Array.isArray(marks) && marks.includes('first draw'), "with 'first draw' among them");

  px._presentStage();
  assert.equal(loadMarkMessages().length, before + 1, 'once');
});
