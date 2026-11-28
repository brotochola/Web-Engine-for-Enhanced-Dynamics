// E-378: the atlas packs its built-ins without a scan, so _white and _empty read as never scanned and every pass that
// wants binary frames (the edge pass's plain cull, E-448's opaque pass) left them out; their bases now carry the texels a
// scan would give (frameBase.js BUILTIN_FRAME_TEXELS).
import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_FRAME_TEXELS, FRAME_HALF, frameBaseWithBuiltinTexels } from '../../src/render/frameBase.js';

test('the built-ins drawn solid or empty have their texels (binary), the others and every scanned frame keep theirs', () => {
  assert.deepEqual(frameBaseWithBuiltinTexels('_white', undefined), { texels: 0, solidTexels: 64 });
  assert.deepEqual(frameBaseWithBuiltinTexels('_empty', { cx: 1, rx: 2, ry: 1 }), { cx: 1, rx: 2, ry: 1, texels: 0, solidTexels: 0 });
  const scanned = { texels: FRAME_HALF, solidTexels: 3 };
  assert.equal(frameBaseWithBuiltinTexels('_white', scanned), scanned, 'a frame the atlas scanned keeps its own');
  assert.equal(frameBaseWithBuiltinTexels('_whiteCircle', undefined), undefined, 'an antialiased built-in stays unscanned');
  assert.equal(frameBaseWithBuiltinTexels('toString', undefined), undefined);
  assert.ok(Object.isFrozen(BUILTIN_FRAME_TEXELS._white));
});
