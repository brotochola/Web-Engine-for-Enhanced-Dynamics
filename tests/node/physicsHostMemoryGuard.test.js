import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// BM-6 (docs/internal/BOX2D_MEMORY_PLAN.md). Box2D's memory is sized from the physics worker's
// name and must never grow. A glue built without its pre-js would make its own growable 16 MB
// memory; the host compares the heap with the size the name asked for and refuses to start.

const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const start = host.indexOf('// bm6-memory-start');
const end = host.indexOf('// bm6-memory-end');
assert.ok(start > 0 && end > start, 'bm6-memory block missing');
const box2dMemoryMismatch = new Function(`${host.slice(start, end)}\nreturn box2dMemoryMismatch;`)();

const MB = 1024 * 1024;

test('a heap of the size the worker name asked for passes', () => {
  assert.equal(box2dMemoryMismatch('physics pages=1024', 64 * MB), '');
  assert.equal(box2dMemoryMismatch('physics pages=32768', 2048 * MB), '');
});

test('without pages in the name the size is 512 MB, as the pre-js uses', () => {
  assert.equal(box2dMemoryMismatch('', 512 * MB), '');
  assert.equal(box2dMemoryMismatch(undefined, 512 * MB), '');
});

test('a glue that made its own 16 MB memory is refused, with the fix named', () => {
  const message = box2dMemoryMismatch('physics pages=1024', 16 * MB);
  assert.match(message, /Box2D memory is 16 MB but the scene asked for 64 MB/);
  assert.match(message, /weed_pre\.js/);
  assert.match(box2dMemoryMismatch('', 16 * MB), /asked for 512 MB/);
});
