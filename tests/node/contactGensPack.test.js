import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Engine store after Hyp 6: two uint32 maps, never BigInt, never Float64. */
function setGens(genAMap, genBMap, key, genA, genB) {
  genAMap.set(key, genA >>> 0);
  genBMap.set(key, genB >>> 0);
}

function gensMatch(genAMap, genBMap, key, genA, genB) {
  const storedA = genAMap.get(key);
  if (storedA === undefined) return false;
  return storedA === (genA >>> 0) && genBMap.get(key) === (genB >>> 0);
}

test('two uint32 maps roundtrip gen pairs without BigInt', () => {
  const genA = new Map();
  const genB = new Map();
  const pairs = [
    [0, 0],
    [1, 2],
    [0xffffffff, 0],
    [0, 0xffffffff],
    [0xabcddcba, 0x12345678],
  ];
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const key = i + 1;
    setGens(genA, genB, key, a, b);
    assert.equal(gensMatch(genA, genB, key, a, b), true);
    assert.equal(gensMatch(genA, genB, key, a, b ^ 1), false);
  }
});

test('two uint32 maps distinguish swapped gens', () => {
  const genA = new Map();
  const genB = new Map();
  setGens(genA, genB, 7, 3, 9);
  assert.equal(gensMatch(genA, genB, 7, 9, 3), false);
  assert.equal(gensMatch(genA, genB, 7, 3, 9), true);
});

test('logicWorker contact gens are two uint32 maps, not BigInt', () => {
  const src = fs.readFileSync(path.join(root, 'src/workers/logicWorker.js'), 'utf8');
  assert.match(src, /this\._collisionGenA = new Map\(\)/);
  assert.match(src, /this\._collisionGenB = new Map\(\)/);
  assert.doesNotMatch(src, /_packGens/);
  assert.doesNotMatch(src, /_collisionGens/);
  const packSlice = src.slice(src.indexOf('_setCollisionGens'), src.indexOf('_processBox2dCollisionCallbacks'));
  assert.doesNotMatch(packSlice, /BigInt/);
  assert.doesNotMatch(packSlice, /Float64|Float64Array/);
});

test('ContactDrainStressScene bodies use CollisionListener', () => {
  const scene = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/contactDrainStressScene.js'),
    'utf8'
  );
  const body = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/contactDrain/contactDrainBody.js'),
    'utf8'
  );
  assert.match(scene, /seed:/);
  assert.match(scene, /ContactDrainBody/);
  assert.match(body, /CollisionListener/);
  assert.match(body, /onCollisionEnter/);
  assert.match(body, /onCollisionStay/);
  assert.match(body, /onCollisionExit/);
});
