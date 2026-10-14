import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');

/**
 * H-01 parity test - guards the EXISTING behaviour the optimization must not
 * change.
 *
 * `updateKeyboardBuffer` used to walk `Object.entries(this.keyMap)` on every key
 * event: 75 array allocations and 74 writes to mirror 74 keys, when only the one
 * key that changed could have changed. The optimization makes the per-event path
 * O(1) and caches the flattened map for the full sync.
 *
 * The risk is not the arithmetic, it is the invariant. The O(1) path is only
 * correct while every writer of `this.keyboard` is a key event that calls back
 * into the sync. So these tests pin:
 *
 *   - the full sync and the incremental path produce identical bytes, for every
 *     scripted sequence;
 *   - a key the map does not know is a no-op, exactly as before;
 *   - a full sync still overwrites a buffer that was dirtied behind its back,
 *     which is what the no-argument path is for and what teardown depends on;
 *   - the edge-trigger half of the buffer is never touched.
 *
 * GATE 2: `Scene.prototype.updateKeyboardBuffer` is the shipped method, called
 * on a stub `this`. The first version of this file transcribed the method
 * instead, and it was useless for exactly the reason this bug needs: a
 * transcription cannot break when the source breaks, so reverting the source to
 * the broken version still passed 6/6.
 *
 * NOT COVERED, stated rather than hidden: the constructor step that builds
 * `_keyNames` / `_keyIndices`. `new Scene(config)` needs a renderer, a canvas
 * and a buffer allocation, none of which exist in Node, so this file cannot
 * exercise it. That step is where the bug below actually lived. See the
 * implementation log - the two-pass version was found by inspection and fixed
 * there, not by a failing test.
 */

/** The key map, built exactly the way scene.js builds it. */
function buildKeyMap() {
  const keyMap = {};
  let keyIndex = 0;
  for (let i = 0; i < 26; i++) keyMap[String.fromCharCode(97 + i)] = keyIndex++;
  for (let i = 0; i < 10; i++) keyMap[String.fromCharCode(48 + i)] = keyIndex++;
  for (const k of [' ', 'enter', 'escape', 'tab', 'backspace', 'delete', 'shift', 'control', 'alt', 'meta']) {
    keyMap[k] = keyIndex++;
  }
  for (const k of ['arrowup', 'arrowdown', 'arrowleft', 'arrowright']) keyMap[k] = keyIndex++;
  for (let i = 1; i <= 12; i++) keyMap[`f${i}`] = keyIndex++;
  for (const c of ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']) keyMap[c] = keyIndex++;
  return { keyMap, size: keyIndex };
}

const { keyMap, size: KEY_COUNT } = buildKeyMap();

/** The shipped method, bound to a stub scene. */
const shipped = Scene.prototype.updateKeyboardBuffer;

/**
 * The expected buffer, derived WITHOUT enumerating the key map.
 *
 * Deliberately not `Object.entries`-based. A first reference that enumerated the
 * same way the (broken) implementation did agreed with the bug perfectly: V8
 * orders the digit keys '0'..'9' as array indices, numerically and before the
 * letter keys, so pairing `Object.keys` with `Object.values` writes every key's
 * state into another key's slot - and a reference that shares the ordering
 * assumption makes that look correct.
 *
 * So this asks the question directly, per index: which key owns this slot, and
 * is it held? Nothing here shares an assumption with the code under test.
 */
function expectedBuffer(keyboard, size) {
  const byIndex = new Array(size);
  for (const key in keyMap) byIndex[keyMap[key]] = key;
  const expected = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    const key = byIndex[i];
    expected[i] = key !== undefined && keyboard[key] ? 1 : 0;
  }
  return expected;
}

/** A stub `this` with the cached lists built the way scene.js builds them. */
function makeScene(bufferLength = KEY_COUNT * 2) {
  const entries = Object.entries(keyMap);
  const names = new Array(entries.length);
  const indices = new Int32Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    names[i] = entries[i][0];
    indices[i] = entries[i][1];
  }
  return {
    keyMap,
    _keyNames: names,
    _keyIndices: indices,
    views: { input: new Int32Array(bufferLength) },
    keyboard: {},
    inputBufferSize: KEY_COUNT,
  };
}

test('H-01: Object.values does NOT return keyMap values in insertion order', { concurrency: false }, () => {
  // The hazard the constructor's caching step has to avoid. keyMap is built so
  // its values are 0..N-1 in insertion order, but '0'..'9' are canonical numeric
  // strings, so V8 emits them first and numerically.
  const dense = [];
  for (let i = 0; i < KEY_COUNT; i++) dense.push(i);

  assert.notDeepEqual(
    Object.values(keyMap),
    dense,
    'if this ever passes, Object.values stopped reordering and the one-pass build ' +
      'is no longer required for correctness',
  );
});

test('H-01: incremental writes match a full sync after a scripted sequence', { concurrency: false }, () => {
  const events = [
    ['down', 'a'], ['down', 'w'], ['down', 's'], ['down', 'd'],
    ['up', 'a'],
    ['down', 'f5'], ['down', 'shift'], ['down', ' '],
    ['up', 'w'], ['up', 's'], ['up', 'd'], ['up', 'f5'], ['up', 'shift'], ['up', ' '],
  ];

  const scene = makeScene();

  // Reference: a full sync after every event, with no per-event fast path.
  const refScene = makeScene();
  for (const [kind, key] of events) {
    refScene.keyboard[key] = kind === 'down';
    shipped.call(refScene);
  }

  // Optimized: O(1) per event.
  for (const [kind, key] of events) {
    scene.keyboard[key] = kind === 'down';
    shipped.call(scene, key);
  }

  assert.deepEqual(
    Array.from(scene.views.input),
    Array.from(expectedBuffer(scene.keyboard, scene.views.input.length)),
    'the incremental path must land where a full sync would',
  );
  assert.deepEqual(
    Array.from(scene.views.input),
    Array.from(refScene.views.input),
    'and identical to the always-full-sync path',
  );
});

test('H-01: an unmapped key is a no-op, same as before', { concurrency: false }, () => {
  const scene = makeScene();
  const unknown = 'notakey';
  scene.keyboard[unknown] = true;
  shipped.call(scene, unknown);

  assert.equal(
    scene.views.input.some((v) => v !== 0),
    false,
    'a key outside the map must not write anywhere',
  );
});

test('H-01: a full sync still repairs a buffer that was dirtied behind its back', { concurrency: false }, () => {
  // This is what the no-argument path exists for, and what teardown relies on:
  // `scene.keyboard` is assigned wholesale in teardown and in the constructor,
  // and the buffer is bound and re-synced. If the full path stopped
  // overwriting, that would go stale.
  const scene = makeScene();
  scene.keyboard = { a: true, w: true };

  // Dirty only the held-state half. The second half is the edge-trigger
  // counters, and the full sync must NOT touch those - which is the next test's
  // job, not this one's.
  for (let i = 0; i < KEY_COUNT; i++) scene.views.input[i] = 12345;

  shipped.call(scene);

  assert.equal(scene.views.input[scene.keyMap.a], 1, 'a is held');
  assert.equal(scene.views.input[scene.keyMap.w], 1, 'w is held');
  assert.equal(scene.views.input[scene.keyMap.s], 0, 's is not held');
  assert.equal(
    scene.views.input.subarray(0, KEY_COUNT).includes(12345),
    false,
    'every stale value in the held-state half must be overwritten',
  );
  assert.deepEqual(
    Array.from(scene.views.input.subarray(0, KEY_COUNT)),
    Array.from(expectedBuffer(scene.keyboard, KEY_COUNT)),
  );
});

test('H-01: edge-trigger counters in the second half of the buffer are untouched', { concurrency: false }, () => {
  // onKeyDown increments input[inputBufferSize + index] before syncing. The sync
  // must only ever write the held-state half, or it would clear the press
  // counters the workers read.
  const scene = makeScene();
  const size = scene.inputBufferSize;
  const buffer = scene.views.input;

  scene.keyboard.a = true;
  buffer[size + scene.keyMap.a] += 1;
  shipped.call(scene, 'a');

  assert.equal(buffer[scene.keyMap.a], 1, 'held state written');
  assert.equal(buffer[size + scene.keyMap.a], 1, 'the press counter must survive');
  assert.equal(buffer[size + scene.keyMap.w], 0, 'and no counter is invented');

  // A full sync must not disturb them either.
  shipped.call(scene);
  assert.equal(buffer[size + scene.keyMap.a], 1, 'a full sync must leave counters alone');
});

test('H-01: releasing a key clears only its own slot', { concurrency: false }, () => {
  const scene = makeScene();
  scene.keyboard.a = true;
  scene.keyboard.w = true;
  shipped.call(scene);

  scene.keyboard.a = false;
  shipped.call(scene, 'a');

  assert.equal(scene.views.input[scene.keyMap.a], 0);
  assert.equal(scene.views.input[scene.keyMap.w], 1, 'w is still held');
});

test('H-01: with no views.input the method is a silent no-op', { concurrency: false }, () => {
  const scene = makeScene();
  scene.views = { input: null };
  assert.doesNotThrow(() => shipped.call(scene, 'a'));
  assert.doesNotThrow(() => shipped.call(scene));
});