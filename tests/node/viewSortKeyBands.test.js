import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  viewSortKeyBand,
  sortKeyBelongsToBand,
} from '../../src/render/viewSortKeyBands.js';
import {
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  DECORATION_Y_SORT_SCALE,
  PRE_RENDER_DEFAULTS,
} from '../../src/util/configDefaults.js';

const Y_SORT_K = DECORATION_Y_SORT_SCALE;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const preRender = readFileSync(join(root, 'src/workers/preRenderWorker.js'), 'utf8');

test('default numberOfPreRenderWorkers stays 1', () => {
  assert.equal(PRE_RENDER_DEFAULTS.numberOfPreRenderWorkers, 1);
});

test('N=1 never filters by a sort-key band (full pixel range)', () => {
  const band = viewSortKeyBand(100, 400, 0, 1);
  assert.equal(band.pixelMinimum, Number.NEGATIVE_INFINITY);
  assert.equal(band.pixelLimit, Number.POSITIVE_INFINITY);
  assert.equal(sortKeyBelongsToBand(0, band.pixelMinimum, band.pixelLimit), true);
  assert.equal(sortKeyBelongsToBand(1e12, band.pixelMinimum, band.pixelLimit), true);
});

test('N=1 still uses the single-worker update path, not sharded Y-bands', () => {
  assert.match(preRender, /if \(this\._sharded\) \{\s*this\._updateSharded/);
  assert.match(preRender, /this\._sharded = this\.workerCount > 1/);
  assert.match(preRender, /this\._sortKeyBandsOn = this\._sharded/);
  assert.equal(PRE_RENDER_DEFAULTS.numberOfPreRenderWorkers, 1);
  const updateAt = preRender.indexOf('update(deltaTime, dtRatio) {');
  const shardedAt = preRender.indexOf('_updateSharded(deltaTime, dtRatio) {');
  const single = preRender.slice(updateAt, shardedAt);
  assert.match(single, /this\.collectVisibleEntities\(\)/);
  assert.doesNotMatch(single, /_latchViewSortKeyBand/);
  assert.doesNotMatch(single, /_sortKeyBandsOn/);
});

test('a band cut never splits one pixel\'s innerZ range across workers', () => {
  const camY = 40;
  const viewH = 500;
  const nWorkers = 3;
  const bands = [];
  for (let i = 0; i < nWorkers; i++) {
    bands.push(viewSortKeyBand(camY, viewH, i, nWorkers));
  }
  for (let i = 0; i < nWorkers - 1; i++) {
    assert.equal(bands[i].pixelLimit, bands[i + 1].pixelMinimum);
  }
  assert.equal(bands[0].pixelMinimum, Number.NEGATIVE_INFINITY);
  assert.equal(bands[nWorkers - 1].pixelLimit, Number.POSITIVE_INFINITY);

  const pixelLo = Math.round(camY) - 2;
  const pixelHi = Math.round(camY + viewH) + 2;
  for (let pixel = pixelLo; pixel <= pixelHi; pixel++) {
    let owner = -1;
    for (let b = 0; b < nWorkers; b++) {
      if (sortKeyBelongsToBand(pixel, bands[b].pixelMinimum, bands[b].pixelLimit)) {
        assert.equal(owner, -1, `pixel ${pixel} claimed twice`);
        owner = b;
      }
    }
    assert.notEqual(owner, -1, `pixel ${pixel} has no owner`);
    // Every innerZ of this pixel maps to the same foot pixel, so the same worker.
    for (let inner = DECORATION_INNER_Z_MIN; inner <= DECORATION_INNER_Z_MAX; inner++) {
      const key = pixel * Y_SORT_K + inner;
      assert.equal(Math.round(key / Y_SORT_K - inner / Y_SORT_K), pixel);
      assert.equal(
        sortKeyBelongsToBand(pixel, bands[owner].pixelMinimum, bands[owner].pixelLimit),
        true
      );
      for (let b = 0; b < nWorkers; b++) {
        if (b === owner) continue;
        assert.equal(
          sortKeyBelongsToBand(pixel, bands[b].pixelMinimum, bands[b].pixelLimit),
          false,
          `pixel ${pixel} innerZ ${inner} leaked to worker ${b}`
        );
      }
    }
  }
});

test('Y-bands and preRenderMerge are not armed together', () => {
  assert.match(preRender, /_sortKeyBandsOn = this\._sharded/);
  assert.match(preRender, /SORT_SPRITES_PRERENDER/);
  assert.match(preRender, /SORT_SPRITES_PRERENDER_MERGE/);
  const init = preRender.slice(
    preRender.indexOf('this._sortKeyBandsOn ='),
    preRender.indexOf('this._bandPixelMinimum =')
  );
  assert.match(init, /SORT_SPRITES_PRERENDER/);
  assert.doesNotMatch(init, /SORT_SPRITES_PRERENDER_MERGE/);
  assert.match(preRender, /_sortSprites === SORT_SPRITES_PRERENDER_MERGE/);
});
