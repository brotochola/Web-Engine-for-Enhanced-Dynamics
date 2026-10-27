import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { loadWorker } from '../bench/workerHarness.mjs';

// A worker's loop is one requestAnimationFrame chain. A pause left the frame it had asked for pending, and a resume
// within the same frame started a second chain beside it: the fast swap pauses and resumes in 2-6 ms, so each of the
// editor's Stops (and a game's level change) added a loop to the logic, spatial, particle, pre-render and physics
// workers (60, 121, 180, 237, 300 frames a second in Chrome), and each extra physics frame stepped the world 1/60 s.

/** Display frames by hand: a callback asked for now runs at the next vsync(). */
function fakeFrames() {
  let next = 1;
  const pending = new Map();
  return {
    requestAnimationFrame: (fn) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => {
      pending.delete(id);
    },
    get pending() {
      return pending.size;
    },
    /** One display frame: the callbacks pending now run once. @returns {number} how many ran */
    vsync() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn(performance.now());
      return due.length;
    },
  };
}

test('a worker paused and resumed within one frame runs one loop', async () => {
  const frames = fakeFrames();
  globalThis.requestAnimationFrame = frames.requestAnimationFrame;
  globalThis.cancelAnimationFrame = frames.cancelAnimationFrame;
  const w = await loadWorker('particleWorker.js', 'particleWorker');
  let ran = 0;
  w.update = () => {
    ran++;
  };
  w.reportFPS = () => {};
  w.startGameLoop();
  assert.equal(frames.vsync(), 1);

  // The fast swap: pause, its work, resume, all before the next display frame.
  w.pause();
  w.resume();
  for (let k = 0; k < 3; k++) assert.equal(frames.vsync(), 1, `frame ${k}: one loop`);

  // A resume sent to a running worker (Scene.resume posts to every worker) starts nothing.
  ran = 0;
  w.resume();
  assert.equal(ran, 0, 'a running worker ran a frame on resume');
  assert.equal(frames.vsync(), 1);
  assert.equal(frames.pending, 1);

  // Paused, the frame it had asked for is gone.
  w.pause();
  assert.equal(frames.pending, 0);
});

function loadPhysicsHost(frames) {
  const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    name: 'physics pages=1024',
    Module: { HEAPF32: { buffer: { byteLength: 64 * 1048576 } } },
    weedjsEnableHostMode() {},
    weedjsDoStep() {},
    WeedPhysicsConfig: { PHYSICS_SIM_DEFAULTS: {}, validatePhysicsConfig: (current, next) => next },
    postMessage() {},
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: frames.requestAnimationFrame,
    cancelAnimationFrame: frames.cancelAnimationFrame,
  });
  vm.runInContext('var self = globalThis;', context);
  vm.runInContext(host, context);
  return (msg) => context.onmessage({ data: { msg } });
}

test('the physics host paused and resumed within one frame runs one loop', () => {
  const frames = fakeFrames();
  const send = loadPhysicsHost(frames);
  send('start');
  assert.equal(frames.vsync(), 1);
  send('pause');
  assert.equal(frames.pending, 0, 'the paused host kept its frame');
  send('resume');
  for (let k = 0; k < 3; k++) assert.equal(frames.vsync(), 1, `frame ${k}: one loop`);
  send('resume'); // running already
  assert.equal(frames.pending, 1);
  assert.equal(frames.vsync(), 1);
});
