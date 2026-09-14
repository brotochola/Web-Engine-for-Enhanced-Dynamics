import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fract01,
  packTileOffset01,
  unpackTileOffset01,
  bakeLocalOffsetFromWorld,
} from '../../src/components/spriteRenderer.js';
import { SPRITE_TILE_MODE } from '../../src/util/configDefaults.js';
import { computeBufferSize, createViews } from '../../src/render/renderQueueLayout.js';

function glFract(x) {
  return x - Math.floor(x);
}

test('SPRITE_TILE_MODE is stretch / world / local', () => {
  assert.equal(SPRITE_TILE_MODE.STRETCH, 0);
  assert.equal(SPRITE_TILE_MODE.WORLD, 1);
  assert.equal(SPRITE_TILE_MODE.LOCAL, 2);
});

test('packTileOffset01 wraps negatives like GLSL fract', () => {
  assert.equal(packTileOffset01(-0.125), packTileOffset01(0.875));
  const u = unpackTileOffset01(packTileOffset01(-0.046875));
  assert.ok(Math.abs(u - fract01(-0.046875)) < 1 / 65535 + 1e-6);
});

test('bakeWorldTileToLocal keeps center UV equal to world fract', () => {
  const cases = [
    { world: 1000, period: 128, vis: 32 },
    { world: 10, period: 128, vis: 32 },
    { world: 0, period: 64, vis: 64 },
  ];
  for (const { world, period, vis } of cases) {
    const repeats = vis / period;
    const packed = packTileOffset01(bakeLocalOffsetFromWorld(world, period, vis));
    const off = unpackTileOffset01(packed);
    const localCenter = glFract(0.5 * repeats + off);
    const worldUv = glFract(world / period);
    assert.ok(
      Math.abs(localCenter - worldUv) < 2 / 65535 + 1e-6,
      `world=${world} local=${localCenter} worldUv=${worldUv}`
    );
  }
});

test('RenderQueueLayout includes tileMode / tileOffset / tileMul', () => {
  const n = 4;
  const sab = new SharedArrayBuffer(computeBufferSize(n));
  const v = createViews(sab, n);
  assert.equal(v.repeatX.length, n);
  assert.equal(v.tileMode.length, n);
  assert.equal(v.tileOffsetU.length, n);
  assert.equal(v.tileOffsetV.length, n);
  assert.equal(v.tileMulX.length, n);
  assert.equal(v.tileMulY.length, n);
  v.tileMulX[1] = -0.5;
  assert.equal(v.tileMulX[1], -0.5);
});
