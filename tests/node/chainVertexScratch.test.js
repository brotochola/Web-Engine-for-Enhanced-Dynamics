import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const weedjsPost = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadScratch(Module) {
  const start = weedjsPost.indexOf('// chain-scratch-start');
  const end = weedjsPost.indexOf('// chain-scratch-end');
  assert.ok(start >= 0 && end > start, 'chain scratch block missing');
  const src = weedjsPost.slice(start, end);
  return new Function('Module', `
    let maxChainPoints = 0;
    ${src}
    return {
      setMax(n) { maxChainPoints = n | 0; },
      ensure() { ensureChainVertexScratch(); },
      pointer() { return chainVertexHeapPointer; },
      floatIndex() { return chainVertexHeapFloatIndex; },
      capacity() { return chainVertexHeapCapacity; },
    };
  `)(Module);
}

test('chain scratch grows from 8 points to 1024 and frees the first block', () => {
  const mallocs = [];
  const frees = [];
  let next = 128;
  const heap = new Float32Array(64);
  const Module = {
    _malloc(bytes) {
      const ptr = next;
      next += bytes;
      mallocs.push({ ptr, bytes });
      return ptr;
    },
    _free(ptr) {
      frees.push(ptr);
    },
    get HEAPF32() {
      return heap;
    },
  };
  const scratch = loadScratch(Module);

  scratch.setMax(8);
  scratch.ensure();
  assert.equal(mallocs.length, 1);
  assert.equal(mallocs[0].bytes, 8 * 8);
  const base = scratch.floatIndex();
  for (let i = 0; i < 16; i++) Module.HEAPF32[base + i] = i + 1;
  assert.equal(Module.HEAPF32[base + 15], 16);

  scratch.setMax(1024);
  scratch.ensure();
  assert.equal(mallocs.length, 2);
  assert.equal(mallocs[1].bytes, 1024 * 8);
  assert.deepEqual(frees, [mallocs[0].ptr]);
  assert.equal(scratch.capacity(), 1024);
  assert.equal(scratch.pointer(), mallocs[1].ptr);

  const kept = scratch.pointer();
  scratch.setMax(32);
  scratch.ensure();
  assert.equal(scratch.pointer(), kept);
  assert.equal(mallocs.length, 2);
  assert.equal(frees.length, 1);

  scratch.setMax(0);
  scratch.ensure();
  assert.equal(scratch.pointer(), 0);
  assert.equal(scratch.capacity(), 0);
  assert.deepEqual(frees, [mallocs[0].ptr, mallocs[1].ptr]);

  assert.match(
    weedjsPost,
    /maxChainPoints = 0;\s*releaseChainVertexScratch\(\)/,
  );
});
