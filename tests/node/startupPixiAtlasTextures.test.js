// SST-7 step 4: the atlas's frames become Pixi textures and proxy sheets as before, more cheaply: the proxy sheets'
// frames grouped in one pass over the atlas (the same frames, names and order as scanning the atlas for every sheet), and
// the frames' textures each with a frame of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rectangle, Texture } from '../../src/vendor/pixi.min.js';
import { proxyTexturesByPrefix } from '../../src/render/atlasProxyTextures.js';
import { loadWorker } from '../bench/workerHarness.mjs';

globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};

async function renderer() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  return new shared.constructor({ postMessage: () => {}, onmessage: null });
}

/** The proxy sheets' frames as loadSpritesheets found them before SST-7: every frame of the atlas scanned for each sheet. */
function scanEverySheet(atlasTextures, proxySheets) {
  const out = {};
  for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
    const proxyTextures = {};
    for (const [frameName, texture] of Object.entries(atlasTextures)) {
      if (frameName.startsWith(proxyData.prefix)) proxyTextures[frameName.substring(proxyData.prefix.length)] = texture;
    }
    out[proxyName] = proxyTextures;
  }
  return out;
}

test("the proxy sheets' frames, found in one pass: the same frames, names and order as scanning for each sheet", () => {
  const atlasTextures = {};
  const names = [
    'car_1', 'car_red_1', 'car_red_2', 'car_', 'car_blue_door_3', 'bus_1', 'bus__2', '_lone', 'tree', 'tree_big_1',
    'oddsheet7', 'oddsheet_8', 'car_red_', 'bus_1_2', '12', 'car_3',
  ];
  for (let i = 0; i < names.length; i++) atlasTextures[names[i]] = { id: i };
  const proxySheets = {
    car: { prefix: 'car_' },
    car_red: { prefix: 'car_red_' },
    bus: { prefix: 'bus_' },
    chunk0: { prefix: '' },
    chunk1: { prefix: '' },
    odd: { prefix: 'oddsheet' },
    none: { prefix: 'nothing_' },
  };
  const expected = scanEverySheet(atlasTextures, proxySheets);
  const byPrefix = proxyTexturesByPrefix(atlasTextures, proxySheets);
  for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
    const got = byPrefix.get(proxyData.prefix);
    assert.deepEqual(Object.keys(got), Object.keys(expected[proxyName]), `${proxyName}: the frames, in order`);
    for (const k of Object.keys(got)) assert.equal(got[k], expected[proxyName][k], `${proxyName}: ${k}`);
  }
});

test("the atlas's frames: a texture each, its own frame, orig and trim as the sheet's JSON says", async () => {
  const px = await renderer();
  // The atlas's image: a source whose size the textures read (Node has no ImageBitmap).
  const bitmap = { width: 64, height: 32 };
  const json = {
    frames: {
      a_1: { frame: { x: 0, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 }, spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 } },
      a_2: { frame: { x: 16, y: 0, w: 10, h: 12 }, sourceSize: { w: 16, h: 16 }, spriteSourceSize: { x: 3, y: 2, w: 10, h: 12 } },
      b_1: { frame: { x: 32, y: 8, w: 8, h: 8 } },
    },
    animations: { a_walk: ['a_1', 'a_2'], b_idle: ['b_1'] },
    meta: {},
  };
  px.rebuildInstancedTextureLut = () => {};
  px.loadSpritesheets({ bigAtlas: { imageBitmap: bitmap, json } }, {
    a: { prefix: 'a_', animations: { walk: { prefixedName: 'a_walk' } } },
    b: { prefix: 'b_', animations: { idle: { prefixedName: 'b_idle' } } },
  });
  const sheet = px.spritesheets.bigAtlas;
  const [t1, t2, t3] = ['a_1', 'a_2', 'b_1'].map((n) => sheet.textures[n]);
  assert.ok(t1 instanceof Texture && t2 instanceof Texture && t3 instanceof Texture);
  assert.ok(t1.frame !== t2.frame && t2.frame !== t3.frame, 'a frame each');
  assert.deepEqual([t1.frame.x, t1.frame.y, t1.frame.width, t1.frame.height], [0, 0, 16, 16]);
  assert.deepEqual([t2.frame.x, t2.frame.y, t2.frame.width, t2.frame.height], [16, 0, 10, 12]);
  assert.deepEqual([t3.frame.x, t3.frame.y, t3.frame.width, t3.frame.height], [32, 8, 8, 8]);
  assert.equal(t1.orig, t1.frame, 'an untrimmed frame: orig is its frame');
  assert.equal(t1.trim, undefined);
  assert.ok(t2.orig instanceof Rectangle && t2.trim instanceof Rectangle, 'a trimmed frame: orig and trim');
  assert.deepEqual([t2.orig.width, t2.orig.height, t2.trim.x, t2.trim.y, t2.trim.width, t2.trim.height], [16, 16, 3, 2, 10, 12]);
  assert.equal(t3.orig, t3.frame, 'no sizes in the JSON: untrimmed');
  assert.equal(t3.trim, undefined);
  assert.equal(px.textures.a_2, t2, 'the atlas frames are the loose textures too');
  assert.deepEqual(sheet.animations.a_walk, [t1, t2]);
  assert.deepEqual(px.flatTextures, [t1, t2, t3]);
  assert.deepEqual(Object.keys(px.spritesheets.a.textures), ['1', '2']);
  assert.equal(px.spritesheets.a.textures['2'], t2);
  assert.deepEqual(px.spritesheets.a.animations.walk, [t1, t2]);
  assert.deepEqual(Object.keys(px.spritesheets.b.textures), ['1']);
});
