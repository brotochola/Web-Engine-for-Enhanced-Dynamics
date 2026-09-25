/**
 * Which painter-ordered pairs share one clip Z under the int16-wide span,
 * and that a fit to the keys actually drawn keeps 1 px and a zIndex band.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  depthFromOrderKey,
  depthSpanForZ,
  orderKeySpan,
  orderSortKey,
  zSortBand,
} from '../../src/util/sortIndexByKey.js';

const YK = 128;

function f32(z) {
  return Math.fround(z);
}

/** Fixed 24-bit depth, round-to-nearest, same [0,1] the rasterizer stores. */
function d24(z) {
  const max = 16777215;
  const q = Math.round(Math.min(1, Math.max(0, z)) * max);
  return q / max;
}

function pair(name, keyA, keyB, span) {
  const half = span * 0.5;
  const a = depthFromOrderKey(keyA, span, half);
  const b = depthFromOrderKey(keyB, span, half);
  return {
    name,
    keyDelta: keyB - keyA,
    f32: f32(a) === f32(b),
    d24: d24(a) === d24(b),
  };
}

function pairsFor(worldHeight) {
  const band = zSortBand(worldHeight);
  const span = 65536 * band;
  const mid = (worldHeight * 0.5) | 0;
  const yKey = (y, inner) => Math.round(y) * YK + inner;
  const at = (y, z, inner = 0) => orderSortKey(yKey(y, inner), z, true, band);
  return [
    pair('1px foot', at(mid, 0), at(mid + 1, 0), span),
    pair('anchor ~5px', at(mid, 0), at(mid + 5, 0), span),
    pair('anchor ~64px', at(mid, 0), at(mid + 64, 0), span),
    pair('innerZ same pixel', at(mid, 0, 0), at(mid, 0, 1), span),
    pair('zIndex 1 vs far Y', at(worldHeight, 0), at(0, 1), span),
  ];
}

test('int16 span: which painter pairs share a depth', () => {
  for (const h of [5000, 10000]) {
    assert.equal(orderKeySpan(h), 65536 * zSortBand(h));
  }
  const collapsed = [];
  for (const h of [5000, 10000]) {
    for (const row of pairsFor(h)) {
      if (row.f32 || row.d24) collapsed.push(`${h} ${row.name} f32=${row.f32} d24=${row.d24} dKey=${row.keyDelta}`);
    }
  }
  assert.deepEqual(collapsed, [
    '5000 1px foot f32=true d24=false dKey=128',
    '5000 anchor ~5px f32=true d24=false dKey=640',
    '5000 innerZ same pixel f32=true d24=true dKey=1',
    '5000 zIndex 1 vs far Y f32=true d24=true dKey=128',
    '10000 1px foot f32=true d24=false dKey=128',
    '10000 anchor ~5px f32=true d24=false dKey=640',
    '10000 innerZ same pixel f32=true d24=true dKey=1',
    '10000 zIndex 1 vs far Y f32=true d24=true dKey=128',
  ]);
});

test('one z band keeps 1px; zIndex 1 stays in front of the far Y', () => {
  const h = 5000;
  const band = zSortBand(h);
  const one = depthSpanForZ(h, 0, 0);
  assert.equal(one.span, band);
  const mid = 2500;
  const a = orderSortKey(mid * YK, 0, true, band);
  const b = orderSortKey((mid + 1) * YK, 0, true, band);
  const da = Math.fround(depthFromOrderKey(a, one.span, one.half));
  const db = Math.fround(depthFromOrderKey(b, one.span, one.half));
  assert.notEqual(da, db);
  assert.ok(db < da);

  const two = depthSpanForZ(h, 0, 1);
  const far = orderSortKey(h * YK, 0, true, band);
  const front = orderSortKey(0, 1, true, band);
  const dFar = Math.fround(depthFromOrderKey(far, two.span, two.half));
  const dFront = Math.fround(depthFromOrderKey(front, two.span, two.half));
  assert.notEqual(dFar, dFront);
  assert.ok(dFront < dFar);
});
