// E-537: Decoration's setters by pool id (Decoration.setAlpha(id, a), ...) do what the facade's setters do
// (Decoration.get(id).alpha = a). Each step runs the facade's setter on one decoration and the static on a twin spawned
// from the same config, and compares every column; a static writes nothing to a free slot, and names whatever decoration
// the slot holds (a raw slot), where a kept facade names the one it was made for.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Decoration } from '../../src/core/decoration.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { bindDecorationPool, decorationRow, DECORATION_SLOTS } from '../helpers/decorationPoolWorld.mjs';

const D = DecorationComponent;
const N = 8;

/** Two world-owned decorations spawned from the same config: the facade's and the static's. */
function decoTwins(config) {
  const a = DecorationPool.spawn({ x: 150, y: 150, texture: '_white', ...config });
  const b = DecorationPool.spawn({ x: 150, y: 150, texture: '_white', ...config });
  assert.ok(a >= 0 && b >= 0);
  return [a, b];
}

/** [facade step, static step] pairs: the same setter both ways. */
const DECO_STEPS = [
  ['setPosition', (d) => d.setPosition(420.3, 260.7), (id) => Decoration.setPosition(id, 420.3, 260.7)],
  ['x', (d) => (d.x = 333.3), (id) => Decoration.setX(id, 333.3)],
  ['y', (d) => (d.y = 444.4), (id) => Decoration.setY(id, 444.4)],
  ['scaleX', (d) => (d.scaleX = 1.7), (id) => Decoration.setScaleX(id, 1.7)],
  ['scaleY', (d) => (d.scaleY = -0.3), (id) => Decoration.setScaleY(id, -0.3)],
  ['scale', (d) => { d.scaleX = 2.25; d.scaleY = 0.1; }, (id) => Decoration.setScale(id, 2.25, 0.1)],
  ['alpha', (d) => (d.alpha = 0.37), (id) => Decoration.setAlpha(id, 0.37)],
  ['tint', (d) => (d.tint = 0x123456), (id) => Decoration.setTint(id, 0x123456)],
  ['localX', (d) => (d.localX = -12.5), (id) => Decoration.setLocalX(id, -12.5)],
  ['localY', (d) => (d.localY = 7.75), (id) => Decoration.setLocalY(id, 7.75)],
  ['local', (d) => { d.localX = 1.1; d.localY = 2.2; }, (id) => Decoration.setLocalPosition(id, 1.1, 2.2)],
  ['anchorX', (d) => (d.anchorX = 0.2), (id) => Decoration.setAnchorX(id, 0.2)],
  ['anchorY', (d) => (d.anchorY = 0.9), (id) => Decoration.setAnchorY(id, 0.9)],
  ['innerZ', (d) => (d.innerZ = 500.7), (id) => Decoration.setInnerZ(id, 500.7)],
  ['faceNormal', (d) => d.setFaceNormal(0.2, -0.6, 0.77), (id) => Decoration.setFaceNormal(id, 0.2, -0.6, 0.77)],
  ['faceHeight', (d) => (d.faceHeight = 37.3), (id) => Decoration.setFaceHeight(id, 37.3)],
  ['innerZ on a face', (d) => (d.innerZ = -3), (id) => Decoration.setInnerZ(id, -3)],
  ['textureId', (d) => (d.textureId = 7), (id) => Decoration.setTextureId(id, 7)],
  ['offsetX', (d) => (d.offsetX = 4.5), (id) => Decoration.setOffsetX(id, 4.5)],
  ['offsetY', (d) => (d.offsetY = -40.25), (id) => Decoration.setOffsetY(id, -40.25)],
  ['sortOffsetY', (d) => (d.sortOffsetY = 12.5), (id) => Decoration.setSortOffsetY(id, 12.5)],
  ['sway', (d) => (d.sway = true), (id) => Decoration.setSway(id, true)],
  ['swayAmplitude', (d) => (d.swayAmplitude = 0.031), (id) => Decoration.setSwayAmplitude(id, 0.031)],
  ['swayFrequency', (d) => (d.swayFrequency = 1.3), (id) => Decoration.setSwayFrequency(id, 1.3)],
  ['sway off', (d) => (d.sway = false), (id) => Decoration.setSway(id, false)],
  ['impulseSway', (d) => d.impulseSway(0.05, -1.7), (id) => Decoration.impulseSway(id, 0.05, -1.7)],
  ['impulseSway again: no-op', (d) => d.impulseSway(0.5, 2), (id) => Decoration.impulseSway(id, 0.5, 2)],
  ['rotation', (d) => (d.rotation = 0.7), (id) => Decoration.setRotation(id, 0.7)],
  ['baseRotation', (d) => (d.baseRotation = -2.1), (id) => Decoration.setBaseRotation(id, -2.1)],
  ['baseRotCS', (d) => d.setBaseRotCS(0.6, 0.8), (id) => Decoration.setBaseRotCS(id, 0.6, 0.8)],
  ['skew', (d) => d.setSkew(0.3, -0.45), (id) => Decoration.setSkew(id, 0.3, -0.45)],
  ['skewX', (d) => (d.skewX = 0.12), (id) => Decoration.setSkewX(id, 0.12)],
  ['skewY', (d) => (d.skewY = 1.9), (id) => Decoration.setSkewY(id, 1.9)],
  ['rotation when sheared: no-op', (d) => (d.rotation = 1), (id) => Decoration.setRotation(id, 1)],
  ['sway when sheared: no-op', (d) => (d.sway = true), (id) => Decoration.setSway(id, true)],
  ['impulse when sheared: no-op', (d) => d.impulseSway(1, 1), (id) => Decoration.impulseSway(id, 1, 1)],
  ['skew off', (d) => d.setSkew(0, 0), (id) => Decoration.setSkew(id, 0, 0)],
];

test('E-537: each Decoration static by pool id writes the columns its facade setter writes', () => {
  bindDecorationPool(N);
  const [a, b] = decoTwins({ scaleX: 1, scaleY: 1, alpha: 1 });
  const facade = Decoration.get(a);
  for (const [label, viaFacade, viaStatic] of DECO_STEPS) {
    const swayEpoch = DecorationPool.swayEpoch();
    viaFacade(facade);
    const facadeEpochs = DecorationPool.swayEpoch() - swayEpoch;
    assert.equal(viaStatic(b), undefined, `${label}: a static returns nothing`);
    assert.deepEqual(decorationRow(b), decorationRow(a), label);
    assert.equal(DecorationPool.swayEpoch() - swayEpoch, 2 * facadeEpochs, `${label}: the sway epoch moved alike`);
  }
  // The spatial hash moved both: a query finds them where the setters put them.
  const out = new Uint16Array(4);
  const found = Decoration.queryCircle(D.x[a], D.y[a], 1, out);
  assert.deepEqual([...out.subarray(0, found)].sort(), [a, b].sort());
});

test('E-537: Decoration statics write nothing to a free slot, and setPosition moves no attached decoration', () => {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  bindDecorationPool(N);
  const [a] = decoTwins({ alpha: 0.5 });
  Decoration.despawn(a);
  const before = decorationRow(a);
  for (const [label, , viaStatic] of DECO_STEPS) {
    viaStatic(a);
    assert.deepEqual(decorationRow(a), before, `${label} on a free slot`);
  }
  for (const id of [-1, DECORATION_SLOTS, 1e6]) Decoration.setAlpha(id, 0.1); // outside the pool: nothing to write, no throw
  assert.equal(Decoration.isActive(a), false);
  const attached = GameObject.addDecoration(3, '_white', 5, 6, 1, 1, 0);
  assert.equal(Decoration.isActive(attached), true);
  const x = D.x[attached];
  Decoration.setPosition(attached, 999, 999);
  Decoration.setX(attached, 999);
  assert.equal(D.x[attached], x, 'an attached decoration is placed by its parent');
  Decoration.setLocalX(attached, 50);
  assert.equal(D.localX[attached], 50);
});

test('E-537: a static names the slot\'s current decoration; a kept facade names the one it was made for', () => {
  bindDecorationPool(N);
  const [a] = decoTwins({ alpha: 1 });
  const stale = Decoration.get(a);
  Decoration.despawn(a);
  const [again] = decoTwins({ alpha: 1 });
  assert.equal(again, a, 'the pool reused the slot');
  stale.alpha = 0.25;
  assert.equal(D.alpha[a], 1, 'the stale facade writes nothing');
  Decoration.setAlpha(a, 0.25);
  assert.equal(D.alpha[a], 0.25, 'the id is a raw slot');
});
