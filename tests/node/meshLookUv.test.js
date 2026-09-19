import test from 'node:test';
import assert from 'node:assert/strict';

import { meshLookFullscreenUvs, meshLookPassUvs, MESH_LOOK_UV_FLOATS } from '../../src/render/meshLookUv.js';

test('MESH look pass UVs are one convention (no backend flip in geometry)', () => {
  const pass = meshLookPassUvs();
  const noFlip = meshLookFullscreenUvs(false);
  assert.equal(pass.length, MESH_LOOK_UV_FLOATS);
  assert.deepEqual([...pass], [...noFlip]);
  assert.deepEqual([...pass], [0, 0, 1, 0, 1, 1, 0, 1]);
});

test('look-on-stage WebGL flip stays a distinct UV set', () => {
  const flip = meshLookFullscreenUvs(true);
  const pass = meshLookPassUvs();
  assert.deepEqual([...flip], [0, 1, 1, 1, 1, 0, 0, 0]);
  assert.notDeepEqual([...flip], [...pass]);
});
