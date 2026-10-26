import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BODY_DIRTY } from '../../src/box2d/box2dBodySync.js';

// syncBodySlot's create branch (weedjsPost.js, body-create-start/end), run as shipped. A create that finds
// the entity despawned meanwhile (no RigidBody or Collider active any more) is not a failure: physics runs
// beside the logic workers, and SpawnStorm despawned ~470 entities a second while their bodies were being
// created, each one a warning and a retry mark. A create that fails on a live entity still warns once and
// retries every step.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadCreate() {
  const start = post.indexOf('// body-create-start');
  const end = post.indexOf('// body-create-end');
  assert.ok(start >= 0 && end > start, 'the create block is missing in weedjsPost.js');
  return new Function('env', `
    const { want, i, createBodyForEntity, hasBody, createFailed, seenBodyGeneration, generation, addDenseBody,
      views, bodySetSleepThresholdFn, bodyDirtyFlags, bodyDirtyWords, bodyDirtyHalves, BODY_DIRTY, console } = env;
    let have = env.have;
    let created = false;
    let changes = 0;
    ${post.slice(start, end)}
    return { created, changes };
  `);
}

const N = 64;
function env(create) {
  const words = new Int32Array(new SharedArrayBuffer(Math.ceil(N / 32) * 4));
  const warnings = [];
  const dense = [];
  return {
    want: 1,
    have: 0,
    i: 21,
    generation: 3,
    createBodyForEntity: create,
    hasBody: new Uint8Array(N),
    createFailed: new Uint8Array(N),
    seenBodyGeneration: new Int32Array(N),
    addDenseBody: (i) => dense.push(i),
    views: {
      entityActive: new Uint8Array(N).fill(1),
      rbActive: new Uint8Array(N),
      colActive: new Uint8Array(N).fill(1),
      sleepThreshold: null,
      px: null,
    },
    bodySetSleepThresholdFn: () => {},
    bodyDirtyFlags: new Int32Array(new SharedArrayBuffer(N * 4)),
    bodyDirtyWords: words,
    bodyDirtyHalves: new Uint16Array(words.buffer),
    BODY_DIRTY,
    console: { warn: (...a) => warnings.push(a) },
    warnings,
    dense,
  };
}

test('a create that finds the entity despawned meanwhile neither warns nor retries', () => {
  const run = loadCreate();
  const e = env(function despawnedMeanwhile(i) {
    e.views.entityActive[i] = 0;
    e.views.colActive[i] = 0;
    return false;
  });
  const r = run(e);
  assert.deepEqual(r, { created: false, changes: 0 });
  assert.equal(e.warnings.length, 0, 'no warning');
  assert.equal(e.bodyDirtyFlags[21], 0, 'no retry mark');
  assert.deepEqual([...e.bodyDirtyWords], [0, 0]);
  assert.equal(e.createFailed[21], 0);
});

test('a create that fails on a live entity warns once and retries every step', () => {
  const run = loadCreate();
  const e = env(() => false);
  run(e);
  assert.equal(e.warnings.length, 1, 'one warning');
  assert.equal(e.warnings[0][1], 21);
  assert.equal(e.bodyDirtyFlags[21], BODY_DIRTY.LIFECYCLE, 'marked for the next step');
  assert.equal(e.bodyDirtyHalves[21 >>> 4], 1 << (21 & 15));
  assert.equal(e.createFailed[21], 1);
  e.bodyDirtyFlags[21] = 0;
  e.bodyDirtyWords.fill(0);
  run(e);
  assert.equal(e.warnings.length, 1, 'the same failure warns once');
  assert.equal(e.bodyDirtyFlags[21], BODY_DIRTY.LIFECYCLE, 'and is marked again');
});

test('a create that succeeds keeps the body', () => {
  const run = loadCreate();
  const e = env(() => true);
  e.createFailed[21] = 1;
  const r = run(e);
  assert.deepEqual(r, { created: true, changes: 1 });
  assert.equal(e.hasBody[21], 1);
  assert.equal(e.createFailed[21], 0);
  assert.equal(e.seenBodyGeneration[21], 3);
  assert.deepEqual(e.dense, [21]);
  assert.equal(e.warnings.length, 0);
});
