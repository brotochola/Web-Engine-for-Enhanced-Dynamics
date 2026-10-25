import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Layer } from '../../src/core/layer.js';

// E-137. The bullet collect sends a bullet with no layer mask or the entities layer's bit alone (the pool's
// default), and its trail, straight to the main collector, writing the rows itself, past collectRenderable's
// type dispatch and bit scan (E-98c and E-98e for sprites).
// The collectors, the full-collector calls and the sort key left in COLLECT_Y must come out as the loop that
// called collectRenderable for every bullet left them, and masked bullets still go through collectRenderable.
// The reference is that loop: the bullets the shortcut takes get the entities layer's bit and bit 15 (no
// sprite-queue layer, so the bit scan drops it) as their mask, which routes each one through collectRenderable
// (the generic branch, the loop as it was) to the same collector.

const POOL = 24;

function setup(pre) {
  BulletComponent.active = new Uint8Array(POOL).map((_, i) => (i % 5 === 3 ? 0 : 1));
  BulletComponent.y = new Float32Array(POOL).map((_, i) => 100.3 + i * 17.25 - (i % 4) * 41.5);
  // Trails on most; none on some (0), a NaN width (no trail, as `> 0` reads it).
  BulletComponent.trailWidth = new Float32Array(POOL).map((_, i) => (i % 7 === 0 ? 0 : i % 11 === 0 ? NaN : 1.5));
  BulletComponent.layerMask = new Uint16Array(POOL);
  pre.maxBullets = POOL;
  // The particle worker's visible list: its count, then slots, out of order; the last one unmasked with a trail
  // (the key the loop leaves is its trail's).
  const slots = [5, 0, 17, 3, 9, 22, 1, 13, 8, 21, 11, 16, 14, 19, 7, 4, 23, 2];
  pre.visibleBulletsData = Int32Array.from([slots.length, ...slots]);
  pre.renderQueueEnabled = true;
}

/** Empty main and fx collectors: the main one holds `cap` rows. */
function collectors(pre, fx, cap) {
  pre._renderableY = new Float32Array(cap + 1);
  pre._renderableType = new Uint8Array(cap + 1);
  pre._renderableIndex = new Int32Array(cap + 1);
  pre._renderableCount = 0;
  pre.renderQueueMaxItems = cap;
  pre._customLayerCollectors = {
    [fx]: {
      y: new Float32Array(64), type: new Uint8Array(64), index: new Int32Array(64),
      count: 0, maxItems: 64, ySorting: false, _overflowWarned: false,
    },
  };
}

/** The collectors' rows, the full-collector calls and the key COLLECT_Y holds (read through _writeRenderable). */
function snapshot(pre, fx, fulls) {
  const n = pre._renderableCount;
  const rows = (a, k) => Array.from(a.subarray(0, k));
  const c = pre._customLayerCollectors[fx];
  const out = {
    main: { type: rows(pre._renderableType, n), index: rows(pre._renderableIndex, n), y: rows(pre._renderableY, n) },
    fx: { type: rows(c.type, c.count), index: rows(c.index, c.count), y: rows(c.y, c.count) },
    fulls: fulls.count,
  };
  // One more row past the cap, to read the key the collect left.
  pre.renderQueueMaxItems++;
  pre._writeRenderable(4, 99, Layer.entitiesId);
  out.leftKey = pre._renderableY[pre._renderableCount - 1];
  return out;
}

for (const cap of [64, 12]) {
  test(`the bullet collect fills the collectors as collectRenderable does (${cap === 64 ? 'room for all' : 'a full collector'})`, async () => {
    Layer.reset();
    Layer.initializeFromConfig({ fx: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const realCollect = pre.collectRenderable;
    const realFull = pre._collectorFull;
    const fulls = { count: 0 };
    pre._collectorFull = function full() {
      fulls.count++;
      return realFull.call(this);
    };
    try {
      setup(pre);
      const fx = Layer.get('fx').id;
      // Slot 9 to fx only, 16 to fx and the entities layer (both with trails), 21 to the entities layer by its bit
      // (no trail: the shortcut, as the pool's default mask), 1 to the entities layer and bit 15 (the generic path).
      BulletComponent.layerMask[9] = 1 << fx;
      BulletComponent.layerMask[16] = (1 << fx) | Layer.entitiesMask();
      BulletComponent.layerMask[21] = Layer.entitiesMask();
      BulletComponent.layerMask[1] = Layer.entitiesMask() | (1 << 15);

      collectors(pre, fx, cap);
      const generic = [];
      pre.collectRenderable = (type, i) => {
        generic.push(`${type}:${i}`);
        realCollect.call(pre, type, i);
      };
      pre.collectVisibleBullets();
      delete pre.collectRenderable;
      assert.deepEqual(generic, ['4:9', '5:9', '4:1', '5:1', '4:16', '5:16'], 'only the bullets masked past the entities layer take the generic path');
      const got = snapshot(pre, fx, fulls);
      if (cap === 64) assert.equal(got.fulls, 0);
      else assert.ok(got.fulls > 0, 'the collector filled up');
      assert.deepEqual(got.fx.index, [9, 9, 16, 16]);

      // The loop as it was: every active bullet through collectRenderable, its key in COLLECT_Y.
      const masks = BulletComponent.layerMask;
      const bit = Layer.entitiesMask();
      BulletComponent.layerMask = masks.map((m) => (m === 0 || m === bit ? bit | (1 << 15) : m));
      collectors(pre, fx, cap);
      fulls.count = 0;
      let calls = 0;
      pre.collectRenderable = (type, i) => {
        calls++;
        realCollect.call(pre, type, i);
      };
      pre.collectVisibleBullets();
      delete pre.collectRenderable;
      const visible = Array.from(pre.visibleBulletsData.subarray(1));
      const rows = visible.filter((i) => BulletComponent.active[i]).reduce((r, i) => r + (BulletComponent.trailWidth[i] > 0 ? 2 : 1), 0);
      assert.equal(calls, rows, 'every bullet and trail took collectRenderable');
      assert.deepEqual(got, snapshot(pre, fx, fulls));
      BulletComponent.layerMask = masks;
    } finally {
      delete pre.collectRenderable;
      delete pre._collectorFull;
      Layer.reset();
    }
  });
}
