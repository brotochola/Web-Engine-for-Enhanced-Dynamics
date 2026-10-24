/**
 * `weedjs_memory_peak_bytes` (BM-3): the break of Box2D's memory, which the physics stats publish
 * as MEMORY_PEAK_KB. It counts static data and stacks, so it starts above zero; a malloc past the
 * top raises it; Emscripten's dlmalloc never trims, so a free does not lower it. Not a speed claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

test('the peak starts at the static data, rises past a new block, and stays after the free', () => {
  const { memory, fn } = instantiateBox2dWasm(['weedjs_memory_peak_bytes', 'malloc', 'free']);
  const peak = () => fn('weedjs_memory_peak_bytes')() >>> 0;
  const before = peak();
  assert.ok(before > 0 && before <= memory.buffer.byteLength, `starting break ${before}`);

  const size = 8 * 1024 * 1024;
  const ptr = fn('malloc')(size) >>> 0;
  assert.ok(ptr > 0, 'malloc failed');
  const grown = peak();
  assert.ok(grown >= ptr + size, `break ${grown} is below the block's end ${ptr + size}`);

  fn('free')(ptr);
  assert.equal(peak(), grown, 'free lowered the break');
});
