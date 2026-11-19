/**
 * E-327: Box2D stamps a block of slots (get_rotation_block_shift) with the epoch word whenever an export writes a
 * rotation in it: the step's export of a body that turned, and every whole export (a command, a body's creation).
 * publishPose copies rotations only in the blocks stamped since the pose buffer it writes was last published, so a
 * block whose bodies did not turn must keep its stamp through a step, and every rotation a command sets must stamp.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const DT = 1 / 60;

function world() {
  const { memory, fn } = instantiateBox2dWasm(['malloc']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 2);
  assert.ok(fn('bind_game_buffers')(256));
  fn('world_enable_sleeping')(worldId, 0);
  const shift = fn('get_rotation_block_shift')();
  const count = fn('get_rotation_stamp_count')();
  const stamps = () => new Int32Array(memory.buffer, fn('get_rotation_stamps_byte_offset')(), count);
  const epoch = () => new Int32Array(memory.buffer, fn('get_rotation_epoch_byte_offset')(), 1);
  const box = (slot, x, fixedRotation) => {
    const got = fn('create_body_box')(
      worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, fixedRotation, slot,
    );
    assert.equal(got, slot);
  };
  return { fn, shift, count, stamps, epoch, box, step: () => fn('step_world')(worldId, DT, 4) };
}

test('E-327: the stamps and their epoch are bound: a word per block of slots, none stamped, epoch 1', () => {
  const { shift, count, stamps, epoch } = world();
  assert.equal(shift, 6);
  assert.equal(count, 256 >> 6);
  assert.deepEqual(Array.from(stamps()), [0, 0, 0, 0]);
  assert.equal(epoch()[0], 1);
});

test('E-327: a step stamps the block of a body that turned, not the block of one that only moved', () => {
  const { fn, shift, stamps, epoch, box, step } = world();
  box(3, 0, 1); // moves without turning (fixed rotation)
  box(70, 10, 0); // spins
  box(140, 20, 0); // rests
  fn('body_set_linear_velocity')(3, 2, 0);
  fn('body_set_angular_velocity')(70, 3);
  // Each creation and command stamped its block with epoch 1; the next publish would have moved the epoch on.
  assert.equal(stamps()[3 >> shift], 1);
  epoch()[0] = 5;
  step();
  assert.equal(stamps()[3 >> shift], 1, 'moving without turning: no stamp');
  assert.equal(stamps()[70 >> shift], 5, 'the spinning body stamped its block with the epoch');
  assert.equal(stamps()[140 >> shift], 1, 'the resting body: no stamp');
  epoch()[0] = 6;
  step();
  assert.equal(stamps()[70 >> shift], 6);
  assert.equal(stamps()[3 >> shift], 1);
});

test('E-327: a command stamps the block it exports, even when the rotation is the one already written', () => {
  const { fn, shift, stamps, epoch, box, step } = world();
  box(200, 0, 1);
  step();
  epoch()[0] = 9;
  // GameObject.setRotationCS on a body: logic writes cos and sin into the channels, then physics runs the command, whose
  // export finds the rotation already there; the pose buffers still need it.
  fn('body_set_transform')(200, 0, 0, 0, 1);
  assert.equal(stamps()[200 >> shift], 9);
  epoch()[0] = 10;
  fn('body_set_transform')(200, 1, 0, 0, 1);
  assert.equal(stamps()[200 >> shift], 10);
});
