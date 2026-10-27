// Static sprites past bigAtlas index 255 (VISUAL_EDITOR_PLAN.md ED-74, found item 26): SpriteRenderer's spritesheetId
// and animationState are bytes, as is the pre-render emit's [sheet][state] table, and littleCity's houses sit at
// bigAtlas indices up to 1,067, so a house past 255 drew another sprite. Each further 256 of bigAtlas's animations is
// a proxy sheet (bigAtlas@1, @2, …); setSprite stores that sheet and an index under 256; the texture metadata maps it
// back to the global index; frame sizes resolve through it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry, addBigAtlasChunks, bigAtlasChunkName, BIG_ATLAS_CHUNK } from '../../src/core/spriteSheetRegistry.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';

/** A bigAtlas of `n` single-frame animations a0 … a{n-1}, frame k being (k + 1) px wide. */
function atlasJson(n) {
  const animations = {};
  const frames = {};
  for (let k = 0; k < n; k++) {
    animations[`a${k}`] = [`a${k}`];
    frames[`a${k}`] = { frame: { x: 0, y: 0, w: k + 1, h: 2 } };
  }
  return { animations, frames, meta: { proxySheets: { walker: { isProxy: true, targetSheet: 'bigAtlas', prefix: 'walker_', animations: {}, indexToName: {} } } } };
}

/** The registry as Scene._installBigAtlas leaves it. */
function install(json) {
  SpriteSheetRegistry.spritesheets.clear();
  SpriteSheetRegistry.frameDimensions.clear();
  SpriteSheetRegistry._frameSizeCache.clear();
  SpriteSheetRegistry.spritesheetNames = [''];
  SpriteSheetRegistry.spritesheetNameToId = new Map();
  GameObject._globalAnimationCache = Object.create(null);
  const proxySheets = { ...(json.meta?.proxySheets || {}) };
  addBigAtlasChunks(json, proxySheets);
  SpriteSheetRegistry.register('bigAtlas', json);
  for (const [name, proxy] of Object.entries(proxySheets)) SpriteSheetRegistry.registerProxy(name, proxy);
  return proxySheets;
}

test('the chunks: 256 animations each past the first 256, mapping a local index to the global one', () => {
  const proxies = {};
  assert.equal(addBigAtlasChunks(atlasJson(256), proxies), 0, 'all fit in bigAtlas');
  assert.equal(addBigAtlasChunks(atlasJson(600), proxies), 2);
  const one = proxies[bigAtlasChunkName(1)];
  const two = proxies[bigAtlasChunkName(2)];
  assert.deepEqual([Object.keys(one.animations).length, Object.keys(two.animations).length], [256, 600 - 512]);
  assert.deepEqual(one.animations.a300, { originalName: 'a300', prefixedName: 'a300', index: 300 - 256 });
  assert.equal(two.indexToName[599 - 512], 'a599');
});

test('setSprite stores the chunk’s sheet and an index under 256; past 255 it no longer wraps', () => {
  const json = atlasJson(1100);
  const proxies = install(json);
  assert.equal(Object.keys(proxies).length, 1 + 4, 'the walker spritesheet and chunks 1 to 4');
  const entity = {
    constructor: { name: 'House' },
    spriteRenderer: {},
    state: -1,
    setAnimationState(i) {
      this.state = i;
    },
  };
  const set = (name) => {
    GameObject.prototype.setSprite.call(entity, name);
    return [SpriteSheetRegistry.getSpritesheetName(entity.spriteRenderer.spritesheetId), entity.state];
  };
  assert.deepEqual(set('a10'), ['bigAtlas', 10]);
  assert.deepEqual(set('a255'), ['bigAtlas', 255]);
  assert.deepEqual(set('a256'), [bigAtlasChunkName(1), 0]);
  assert.deepEqual(set('a1067'), [bigAtlasChunkName(4), 1067 - 4 * BIG_ATLAS_CHUNK], 'littleCity’s last house');
  assert.deepEqual(set('a1067'), [bigAtlasChunkName(4), 43], 'from the cache too');
  assert.ok(entity.state < 256);
});

test('the pre-render’s table maps a chunk’s index back to the global one; frame sizes resolve through it', () => {
  install(atlasJson(1100));
  const meta = Scene.prototype.buildTextureMetadata.call({});
  for (const [global, chunk] of [[300, 1], [1067, 4], [10, 0]]) {
    const sheet = chunk === 0 ? 'bigAtlas' : bigAtlasChunkName(chunk);
    const id = SpriteSheetRegistry.getSpritesheetId(sheet);
    assert.equal(meta.proxyToGlobalAnim[id][global % 256], global, `${sheet} ${global % 256}`);
    assert.deepEqual(SpriteSheetRegistry.frameSizeOf(id, global % 256), { w: global + 1, h: 2 }, `the size of a${global}`);
  }
  assert.equal(SpriteSheetRegistry.getAnimationName(bigAtlasChunkName(2), 3), 'a515');
});
