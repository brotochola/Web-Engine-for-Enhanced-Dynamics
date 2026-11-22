import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';

// DX-STATICSGEN step 1: with the debug checks on, pre-render compares the drawn sprites' statics with a copy it took
// after last frame's emit, and names the class whose sprite changed one with renderDirty or keyedDirty clear (a direct
// SoA write: the persist path and the keyed frames keep last frame's row, N-103). Once the class did it on two frames:
// logic writes beside pre-render, a setter's value before its marks.

const N = 4;

async function setup(className, config = {}) {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  // engineProvided: the worker loads no script for it (the test has no scene module).
  const registeredClasses = [{ name: className, startIndex: 0, endIndex: N, entityType: 0, poolSize: N, engineProvided: true }];
  const { worker: w } = await bootEmitWorker(N, { config, extra: { registeredClasses } });
  for (let e = 0; e < N; e++) {
    Transform.active[e] = 1;
    Transform.x[e] = 10 * e;
    Transform.rotC[e] = 1;
    SpriteRenderer.active[e] = 1;
    SpriteRenderer.spritesheetId[e] = 0;
    SpriteRenderer.scaleX[e] = 1;
    SpriteRenderer.scaleY[e] = 1;
    SpriteRenderer.alpha[e] = 1;
  }
  return w;
}

// One frame of pre-render's: write buffer, collect, emit (the check before it, the copy after), flip.
function frame(w) {
  w.selectWriteBuffers();
  w._renderableCount = 0;
  w._bindCollectPoses();
  for (let e = 0; e < N; e++) w.collectRenderable(0, e);
  w.buildRenderQueue(1000 / 60);
  w._queueBuf ^= 1;
}

/** The WeedJS warnings `fn` printed. */
async function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    await fn();
  } finally {
    console.warn = saved;
  }
  return lines.filter((l) => l.startsWith('WeedJS: '));
}

test('a static written without its marks is named, once its class did it on two frames', async () => {
  const lines = await warningsOf(async () => {
    const w = await setup('Crate');
    assert.equal(w._staticsCheck, true, 'the init config leaves the debug checks on');
    frame(w);
    frame(w);
    SpriteRenderer.alpha[2] = 0.5; // no renderDirty, no keyedDirty
    frame(w);
    SpriteRenderer.alpha[2] = 0.25;
    frame(w);
    frame(w);
  });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Crate changed a sprite's alpha without marking it/);
  assert.match(lines[0], /markDirty\(\)/);
  Layer.reset();
});

test('one unmarked frame is not enough (a setter caught between its value and its marks)', async () => {
  const lines = await warningsOf(async () => {
    const w = await setup('Barrel');
    frame(w);
    frame(w);
    SpriteRenderer.scaleX[1] = 2;
    frame(w);
    frame(w);
    frame(w);
  });
  assert.deepEqual(lines, []);
  Layer.reset();
});

test('statics written with both marks, as the setters write them, say nothing', async () => {
  const lines = await warningsOf(async () => {
    const w = await setup('Lamp');
    frame(w);
    for (let f = 0; f < 6; f++) {
      SpriteRenderer.alpha[0] = 0.1 * (f + 1);
      SpriteRenderer.tint[3] = 0x102030 * (f + 1);
      SpriteRenderer.anchorY[2] = 0.1 * f;
      for (const e of [0, 2, 3]) {
        SpriteRenderer.renderDirty[e] = 1;
        SpriteRenderer.keyedDirty[e] = 1;
      }
      frame(w);
    }
  });
  assert.deepEqual(lines, []);
  Layer.reset();
});

test('renderDirty alone is not a mark: the keyed frames read keyedDirty', async () => {
  const lines = await warningsOf(async () => {
    const w = await setup('Sign');
    frame(w);
    frame(w);
    for (let f = 0; f < 3; f++) {
      SpriteRenderer.tint[1] = 0xff0000 + f;
      SpriteRenderer.renderDirty[1] = 1;
      frame(w);
    }
  });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Sign changed a sprite's tint/);
  Layer.reset();
});

test('debug checks off: no copy, no warning', async () => {
  const lines = await warningsOf(async () => {
    const w = await setup('Fence', { debug: { checks: false } });
    assert.equal(w._staticsCheck, false);
    frame(w);
    frame(w);
    for (let f = 0; f < 3; f++) {
      SpriteRenderer.alpha[3] = 0.2 * (f + 1);
      frame(w);
    }
  });
  assert.deepEqual(lines, []);
  Layer.reset();
});
