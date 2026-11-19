// SST-12: the physics host zeroes only the part of the engine block below Box2D's heap break as it was before the block's
// malloc (physicsHostImpl.js reserveEngineBlock). This checks the premise on the shipped module: a fresh module's large
// malloc lands at or past the previous break (sbrk(0), weedjs_memory_peak_bytes), and its bytes are zero there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

test('a fresh Box2D module puts a large block past its old heap break, and the block reads zero', () => {
  const { memory, fn } = instantiateBox2dWasm(['malloc', 'weedjs_memory_peak_bytes'], { pages: 3072 });
  const breakBefore = fn('weedjs_memory_peak_bytes')() >>> 0;
  const bytes = 64 * 1024 * 1024;
  const raw = fn('malloc')(bytes + 64) >>> 0;
  assert.ok(raw > 0, 'the block is allocated');
  const byte = (raw + 63) & ~63;
  assert.ok(byte >= breakBefore, `the block (${byte}) lies past the break before it (${breakBefore})`);
  const view = new Uint8Array(memory.buffer, byte, bytes);
  for (let i = 0; i < bytes; i += 4093) assert.equal(view[i], 0, `byte ${i}`);
  assert.equal(view[bytes - 1], 0);
});
