import test from 'node:test';
import assert from 'node:assert/strict';
import { Decal } from '../../src/core/decal.js';

test('Decal.stamp returns 0 when stamp ring is unbound', { concurrency: false }, () => {
  Decal.bindStampRing(null);
  Decal.bindStampApply(null);
  assert.equal(Decal.isStampRingBound(), false);
  assert.equal(Decal.stamp({ x: 1, y: 2, texture: 'blood' }), 0);
});

test('Decal.enqueueStamp + drain paints a tile pixel', { concurrency: false }, () => {
  const tilesX = 1;
  const tilesY = 1;
  const tilePixelSize = 8;
  const tileSize = 256;
  const bytes = tilePixelSize * tilePixelSize * 4;
  const tiles = new Uint8ClampedArray(bytes);
  const dirty = new Uint8Array(1);
  const tex = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);

  const sab = Decal.createStampRingSab(64);
  Decal.bindStampRing(sab);
  assert.equal(Decal.isStampRingBound(), true);
  assert.equal(
    Decal.enqueueStamp(128, 128, 1, 8, 8, 0xffffff, 1, 0),
    true
  );

  let drained = 0;
  const n = Decal.drainStampRing((x, y, tint, scaleX, scaleY, textureId, alpha, blendMode) => {
    drained++;
    assert.equal(x, 128);
    assert.equal(y, 128);
    assert.equal(textureId, 1);
    assert.equal(tint, 0xffffff);
    assert.equal(alpha, 1);
    assert.equal(blendMode, 0);
    Decal.stampToTileBuffers({
      worldX: x,
      worldY: y,
      tint,
      scaleX,
      scaleY,
      alpha,
      blendMode,
      textureRgba: tex,
      texWidth: 2,
      texHeight: 2,
      decalsTiles: tiles,
      decalsTilesDirty: dirty,
      decalsTileSize: tileSize,
      decalsTilePixelSize: tilePixelSize,
      decalsTilesX: tilesX,
      decalsTilesY: tilesY,
      decalsResolution: tilePixelSize / tileSize,
    });
  });
  assert.equal(n, 1);
  assert.equal(drained, 1);
  assert.equal(dirty[0], 1);
  let painted = 0;
  for (let i = 3; i < tiles.length; i += 4) {
    if (tiles[i] > 0) painted++;
  }
  assert.ok(painted > 0, 'expected at least one painted pixel');
  Decal.bindStampRing(null);
  Decal.bindStampApply(null);
});

test('Decal.stamp applies locally and does not enqueue', { concurrency: false }, () => {
  const tilesX = 1;
  const tilesY = 1;
  const tilePixelSize = 8;
  const tileSize = 256;
  const bytes = tilePixelSize * tilePixelSize * 4;
  const tiles = new Uint8ClampedArray(bytes);
  const dirty = new Uint8Array(1);
  const tex = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);

  const sab = Decal.createStampRingSab(64);
  Decal.bindStampRing(sab);
  Decal.bindStampApply((x, y, tint, scaleX, scaleY, textureId, alpha, blendMode) => {
    Decal.stampToTileBuffers({
      worldX: x,
      worldY: y,
      tint,
      scaleX,
      scaleY,
      alpha,
      blendMode,
      textureRgba: tex,
      texWidth: 2,
      texHeight: 2,
      decalsTiles: tiles,
      decalsTilesDirty: dirty,
      decalsTileSize: tileSize,
      decalsTilePixelSize: tilePixelSize,
      decalsTilesX: tilesX,
      decalsTilesY: tilesY,
      decalsResolution: tilePixelSize / tileSize,
    });
  });

  assert.equal(Decal.stamp({ x: 128, y: 128, scale: 8, tint: 0xffffff, alpha: 1 }), 1);
  assert.equal(Decal.drainStampRing(() => {
    assert.fail('local stamp must not enqueue');
  }), 0);
  assert.equal(dirty[0], 1);
  let painted = 0;
  for (let i = 3; i < tiles.length; i += 4) {
    if (tiles[i] > 0) painted++;
  }
  assert.ok(painted > 0, 'expected at least one painted pixel');
  Decal.bindStampApply(null);
  Decal.bindStampRing(null);
});

test('Decal.getColor samples atlas world coords', { concurrency: false }, () => {
  const tilePixelSize = 8;
  const tilesX = 2;
  const tilesY = 2;
  const sab = new SharedArrayBuffer(tilesX * tilesY * tilePixelSize * tilePixelSize * 4);
  const rgba = new Uint8ClampedArray(sab);
  rgba[0] = 10;
  rgba[1] = 20;
  rgba[2] = 30;
  rgba[3] = 255;

  Decal.bindAtlas({
    tilesSab: sab,
    tileSize: 256,
    tilePixelSize,
    tilesX,
    tilesY,
  });
  assert.equal(Decal.getColor(0, 0), ((10 << 24) | (20 << 16) | (30 << 8) | 255) >>> 0);
  assert.equal(Decal.getColor(-1, 0), 0);
  assert.equal(Decal.getColor(256, 0), 0);
  Decal.bindAtlas(null);
  assert.equal(Decal.getColor(0, 0), 0);
});
