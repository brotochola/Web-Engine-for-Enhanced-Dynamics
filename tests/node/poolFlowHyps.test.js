import test from 'node:test';
import assert from 'node:assert/strict';

import { applyBullet, applyBulletTwoPass, applyDecoScan } from '../bench/micro-opts-hyps/hypPatches.mjs';
import { restoreSrcTree, snapshotSrcTree } from '../bench/measureLib.mjs';

test('BTWOPASS / DECOSCAN / BULLET patches apply on the current tree', () => {
  const snap = snapshotSrcTree();
  try {
    applyBulletTwoPass();
    applyDecoScan();
    restoreSrcTree(snap);
    applyBullet({ overlay: false });
    assert.ok(true);
  } finally {
    restoreSrcTree(snap);
  }
});
