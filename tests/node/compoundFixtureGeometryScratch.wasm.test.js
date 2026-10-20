/**
 * Crash/leak check: one WASM vertex scratch, clear+add many polygons.
 * Timing here is not the keep metric (that is compoundGeometryDirtyScene).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_STATIC = 0;
const MAX_VERTS = 8;

const instantiateBox2dWasm = instantiateShared;

test('one heap scratch survives many clear+add polygon loops', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(64));
  const slot = fn('create_body')(worldId, BODY_STATIC, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0);
  assert.ok(slot >= 0);

  const ptr = fn('malloc')(MAX_VERTS * 2 * 4);
  assert.ok(ptr);
  const heap = new Float32Array(memory.buffer, ptr, MAX_VERTS * 2);
  const tris = [
    [0, 0, 10, 0, 0, 10],
    [10, 0, 20, 0, 20, 10],
    [0, 10, 10, 10, 0, 20],
  ];

  for (let loop = 0; loop < 400; loop++) {
    fn('body_clear_shapes')(slot);
    for (let t = 0; t < tris.length; t++) {
      heap.set(tris[t]);
      fn('body_add_shape_polygon')(slot, ptr, 3, 0, 0, 0);
    }
  }

  fn('step_world')(worldId, 1 / 60, 1);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const x = new Float32Array(memory.buffer)[(stateByte >> 2) + slot];
  assert.ok(Number.isFinite(x), 'body slot still readable after clear+add storm');
  fn('free')(ptr);
});
