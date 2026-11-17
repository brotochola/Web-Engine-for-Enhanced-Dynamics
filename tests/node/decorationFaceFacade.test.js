/**
 * N-263: a face through the Decoration facade. Its innerZ is also its depth's tie on a shared plane (DX-FACEDEPTH), so
 * setting it moves the face's row too; setFaceNormal / getFaceNormal / faceHeight / isFace reach what spawn's
 * faceNormalX… and faceHeight set; and DecorationPool is public (named and on WEED).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { Decoration } from '../../src/core/decoration.js';
import { decodeFaceHeight, encodeFaceHeight, encodeFaceNormal } from '../../src/render/faceMap.js';
import { buildPoolScene } from '../helpers/poolScene.mjs';

test("a face's innerZ set through the facade is its depth tie too; a plain decoration's row is left alone", () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const sign = DecorationPool.spawn({ x: 5, y: 5, faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, faceHeight: 32.5 });
  Decoration.get(sign).innerZ = 3;
  assert.equal(D.innerZ[sign], 3);
  assert.deepEqual(decodeFaceHeight(D.faceZ[sign]), { height: 32.5, innerZ: 3 }, 'the tie moved, the height stayed');
  Decoration.get(sign).innerZ = 50;
  assert.equal(decodeFaceHeight(D.faceZ[sign]).innerZ, 7, 'a face ties up to 7');
  const plain = DecorationPool.spawn({ x: 6, y: 6 });
  const before = D.faceZ[plain];
  Decoration.get(plain).innerZ = 2;
  assert.equal(D.innerZ[plain], 2);
  assert.equal(D.faceZ[plain], before, 'no face, no row to move');
});

test('setFaceNormal makes a face (turning faces on), getFaceNormal and faceHeight read and write it, (0, 0, 0) undoes it', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const i = DecorationPool.spawn({ x: 1, y: 2, innerZ: 1 });
  const deco = Decoration.get(i);
  assert.equal(deco.isFace, false);
  assert.deepEqual(deco.getFaceNormal(), [0, 0, 0]);
  assert.equal(DecorationPool.facesInUse(), false);
  deco.setFaceNormal(0, 2, 0);
  assert.equal(deco.isFace, true);
  assert.equal(D.faceOct[i], encodeFaceNormal(0, 1, 0));
  assert.equal(DecorationPool.facesInUse(), true, 'the first face turns faces on');
  const n = deco.getFaceNormal(new Float64Array(3));
  assert.ok(Math.abs(n[0]) < 1e-9 && Math.abs(n[1] - 1) < 1e-9 && Math.abs(n[2]) < 1e-9, `normal ${[...n]}`);
  deco.faceHeight = 40.125;
  assert.equal(deco.faceHeight, 40.125);
  assert.equal(D.faceZ[i], encodeFaceHeight(40.125, 1), 'the height keeps its innerZ tie');
  deco.setFaceNormal(0, 0, 0);
  assert.equal(deco.isFace, false);
  assert.equal(DecorationPool.facesInUse(), true, 'faces stay on for good');
});

test('DecorationPool is part of the public API, named and on WEED', async () => {
  const api = await import('../../src/index.js');
  assert.equal(api.DecorationPool, DecorationPool);
  assert.equal(api.default.DecorationPool, DecorationPool);
  assert.equal(typeof api.DecorationPool.facesInUse, 'function');
});
