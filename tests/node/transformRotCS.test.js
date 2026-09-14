import test from 'node:test';
import assert from 'node:assert/strict';

import { STATE_CHANNELS, STATE_CHANNEL_COUNT } from '../../src/box2d/box2dConstants.js';
import { bindBox2dHotFields } from '../../src/box2d/box2dHotFields.js';
import { Transform } from '../../src/components/transform.js';

test('STATE_CHANNELS includes ROT_C / ROT_S as channels 6 and 7', () => {
  assert.equal(STATE_CHANNEL_COUNT, 8);
  assert.equal(STATE_CHANNELS.ROTATION, 2);
  assert.equal(STATE_CHANNELS.ROT_C, 6);
  assert.equal(STATE_CHANNELS.ROT_S, 7);
});

test('bindBox2dHotFields exposes Transform.rotC / rotS', () => {
  Transform.clearArrays();
  const n = 4;
  const floats = n * STATE_CHANNEL_COUNT;
  const sab = new SharedArrayBuffer(floats * 4 + n); // + sleeping bytes
  const channelOffsets = [];
  for (let c = 0; c < STATE_CHANNEL_COUNT; c++) channelOffsets.push(c * n);

  // Identity: rotC=1 for all
  const rotC = new Float32Array(sab, channelOffsets[STATE_CHANNELS.ROT_C] << 2, n);
  rotC.fill(1);

  bindBox2dHotFields({
    sab,
    channelOffsets,
    sleepingByteOffset: floats * 4,
    bodyCapacity: n,
  });

  assert.equal(Transform.rotC.length, n);
  assert.equal(Transform.rotS.length, n);
  assert.equal(Transform.rotC[0], 1);
  assert.equal(Transform.rotS[0], 0);

  // Angle setter syncs rotC/rotS + rotation channel; getter reads channel (WASM also writes it)
  const angle = Math.PI / 4;
  const t = Object.create(Transform.prototype);
  t.index = 2;
  t.rotation = angle;
  assert.ok(Math.abs(Transform.rotC[2] - Math.cos(angle)) < 1e-6);
  assert.ok(Math.abs(Transform.rotS[2] - Math.sin(angle)) < 1e-6);
  assert.ok(Math.abs(Transform.rotation[2] - angle) < 1e-6);
  assert.ok(Math.abs(t.rotation - angle) < 1e-6);

  Transform.clearArrays();
});
