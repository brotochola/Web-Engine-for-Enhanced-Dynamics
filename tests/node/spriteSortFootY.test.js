import test from 'node:test';
import assert from 'node:assert/strict';

import { spriteSortFootY, spriteYSortKey } from '../../src/util/sortIndexByKey.js';

// A sprite with anchor (0.5, 1) would sort on the pose, so every case here uses
// a centred anchor to force the bottom-edge offset to matter.
function src(n, over = {}) {
  return {
    anchorX: new Float32Array(n).fill(0.5),
    anchorY: new Float32Array(n).fill(0.5),
    scaleX: new Float32Array(n).fill(1),
    scaleY: new Float32Array(n).fill(1),
    inheritRotation: new Uint8Array(n).fill(1),
    spriteRotC: new Float32Array(n).fill(1),
    spriteRotS: new Float32Array(n).fill(0),
    ...over,
  };
}

const W = 90;
const H = 40;

test('feet-anchored sprite sorts on the pose, no frame needed', () => {
  const s = src(2);
  s.anchorY[0] = 1.0;
  assert.equal(spriteSortFootY(s, 0, 500, 1, 0, W, H), 500);
  // Rotated or not, a feet anchor is its own sort line.
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500);
});

test('unknown frame collapses the offset to the pose', () => {
  const s = src(1);
  assert.equal(spriteSortFootY(s, 0, 500, 1, 0, 0, 0), 500);
});

test('identity rotation: y + (1 - anchorY) * height * |scaleY|', () => {
  const s = src(1);
  assert.equal(spriteSortFootY(s, 0, 500, 1, 0, W, H), 500 + 20);
  s.scaleY[0] = -2;
  assert.equal(spriteSortFootY(s, 0, 500, 1, 0, W, H), 500 + 40, '|scaleY|, sign does not matter');
});

test('body rotation is used when the sprite inherits it', () => {
  const s = src(1);
  // 90 degrees: rotC = 0, rotS = 1. ox is 0 (anchorX 0.5), oy is 20.
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500);
  // Off-centre anchor so ox has something to do too.
  s.anchorX[0] = 0;
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500 + 45);
});

test('inheritTransformRotation = 0 sorts on the sprite own facing, not the pose', () => {
  const s = src(1);
  s.inheritRotation[0] = 0;
  // Body is rotated 90 degrees, sprite is drawn unrotated.
  s.spriteRotC[0] = 1;
  s.spriteRotS[0] = 0;
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500 + 20, 'must ignore the 90 degree body rotation');

  // Same entity, sprite now facing 90 degrees: the sort line has to move.
  s.spriteRotC[0] = 0;
  s.spriteRotS[0] = 1;
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500, 'sprite rotation must reach the sort line');
});

test('a turning sprite moves its sort line only when it carries its own rotation', () => {
  const build = (inherit) => {
    const s = src(1);
    if (!inherit) s.inheritRotation[0] = 0;
    return s;
  };
  const at = (s, bodyRotC, bodyRotS, spriteRotC, spriteRotS) => {
    s.spriteRotC[0] = spriteRotC;
    s.spriteRotS[0] = spriteRotS;
    return spriteSortFootY(s, 0, 500, bodyRotC, bodyRotS, W, H);
  };

  // Body spins, sprite inherits it: the sort line tracks the body.
  const inherit = build(true);
  assert.notEqual(at(inherit, 1, 0, 1, 0), at(inherit, 0, 1, 1, 0));

  // Body spins, sprite owns its rotation: the sort line tracks the sprite and
  // is blind to the body. This is the car case — facing lives in the frame, the
  // body only steers.
  const own = build(false);
  assert.equal(at(own, 1, 0, 1, 0), at(own, 0, 1, 1, 0), 'body rotation must not move the sort line');
  assert.notEqual(at(own, 1, 0, 1, 0), at(own, 1, 0, 0, 1), 'sprite rotation must move it');
});

test('a missing component array falls back to the pose', () => {
  const s = src(1);
  s.anchorY = null;
  assert.equal(spriteSortFootY(s, 0, 500, 0, 1, W, H), 500);
  assert.equal(spriteSortFootY(null, 0, 500, 0, 1, W, H), 500);
});

test('spriteSortFootY feeds spriteYSortKey without losing sub-pixel stability', () => {
  const s = src(1);
  const key = spriteSortFootY(s, 0, 500.4, 1, 0, W, H);
  assert.equal(spriteYSortKey(key, 128), spriteYSortKey(520.4, 128));
  assert.equal(spriteYSortKey(spriteSortFootY(s, 0, 500.2, 1, 0, W, H), 128), spriteYSortKey(key, 128));
});
