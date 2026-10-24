import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BODY_DIRTY, bindBodySyncBuffers, markBodyDirty } from '../../src/box2d/box2dBodySync.js';

// E-87. The logic side marks a body through a 16-bit view of the dirty words and physics drains
// them 16 bits at a time after a plain 32-bit read, so no Atomics result leaves the Smi range
// (Chrome boxes one that does, per call). The bytes are the same as one 32-bit word per 32
// entities: these tests run physics' real drain over words the real marker wrote.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadDrain() {
  const start = post.indexOf('// sync-bodies-drain-start');
  const end = post.indexOf('// sync-bodies-drain-end');
  assert.ok(start >= 0 && end > start, 'the drain block is missing in weedjsPost.js');
  return new Function('env', `
    const { bodyDirtyWords, bodyDirtyHalves, bodyDirtyFlags, entityCount, seen } = env;
    const syncBodySlot = (i, flags) => { seen.push([i, flags]); return 1; };
    let changes = 0;
    let visited = 0;
    ${post.slice(start, end)}
    return { changes, visited };
  `);
}

function setup(entityCount) {
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(entityCount * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(entityCount / 32) * 4),
    bodyGeneration: new SharedArrayBuffer(entityCount * 4),
  };
  bindBodySyncBuffers(buffers);
  const words = new Int32Array(buffers.bodyDirtyWords);
  return {
    buffers,
    words,
    env: (count, seen) => ({
      bodyDirtyWords: words,
      bodyDirtyHalves: new Uint16Array(buffers.bodyDirtyWords),
      bodyDirtyFlags: new Int32Array(buffers.bodyDirtyFlags),
      entityCount: count,
      seen,
    }),
  };
}

test('a mark sets bit i & 31 of 32-bit word i >> 5, the high bits too', () => {
  const { words } = setup(96);
  for (const i of [0, 15, 16, 30, 31, 33, 63]) markBodyDirty(i, BODY_DIRTY.MASS);
  assert.equal(words[0], (1 << 0) | (1 << 15) | (1 << 16) | (1 << 30) | (1 << 31));
  assert.equal(words[1], (1 << 1) | (1 << 31));
  assert.equal(words[2], 0);
});

test('the drain visits every marked body once, in index order, with its flags, and clears the words', () => {
  const { words, env } = setup(96);
  const marked = [95, 0, 31, 16, 30, 15, 64, 47, 48, 33];
  for (const i of marked) markBodyDirty(i, i === 30 ? BODY_DIRTY.GEOMETRY : BODY_DIRTY.MASS);
  const seen = [];
  const drain = loadDrain();
  const { changes, visited } = drain(env(96, seen));
  const want = [...marked].sort((a, b) => a - b);
  assert.deepEqual(seen.map(([i]) => i), want);
  assert.deepEqual(seen.find(([i]) => i === 30), [30, BODY_DIRTY.GEOMETRY]);
  assert.equal(visited, marked.length);
  assert.equal(changes, marked.length);
  assert.deepEqual([...words], [0, 0, 0]);
  const again = [];
  assert.equal(drain(env(96, again)).visited, 0);
  assert.equal(again.length, 0);
});

test('the drain clears but skips bits at or past the live entity count', () => {
  const { words, env } = setup(64);
  markBodyDirty(10, BODY_DIRTY.MASS);
  markBodyDirty(40, BODY_DIRTY.MASS);
  markBodyDirty(63, BODY_DIRTY.MASS);
  const seen = [];
  loadDrain()(env(40, seen));
  assert.deepEqual(seen.map(([i]) => i), [10]);
  assert.deepEqual([...words], [0, 0]);
});

test('the scene\'s all-dirty start drains every entity below the count', () => {
  const { words, env } = setup(70);
  // As sceneSharedBuffers fills them: every word -1, the last one masked to the remainder.
  words.fill(-1);
  words[2] = (2 ** (70 & 31) - 1) | 0;
  const seen = [];
  loadDrain()(env(70, seen));
  assert.deepEqual(seen.map(([i]) => i), Array.from({ length: 70 }, (_, i) => i));
});
