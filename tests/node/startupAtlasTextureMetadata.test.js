// The render queue's texture metadata built by atlas/textureMetadata.js (Scene.buildTextureMetadata's body, moved with
// the atlas's other page work) is what the scene's method builds, for an atlas with proxy sheets and chunks.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry, addBigAtlasChunks } from '../../src/core/spriteSheetRegistry.js';
import { buildTextureMetadata } from '../../src/core/atlas/textureMetadata.js';
import { Scene } from '../../src/core/scene.js';

/** A bigAtlas of 300 animations (a chunk sheet past 256), a walker sheet's proxy, some animations of several frames. */
function install() {
  SpriteSheetRegistry.spritesheets.clear();
  SpriteSheetRegistry.frameDimensions.clear();
  SpriteSheetRegistry._frameSizeCache.clear();
  SpriteSheetRegistry.spritesheetNames = [''];
  SpriteSheetRegistry.spritesheetNameToId = new Map();
  const animations = {};
  const frames = {};
  for (let k = 0; k < 300; k++) {
    const n = 1 + (k % 3);
    animations[`a${k}`] = [];
    for (let f = 0; f < n; f++) {
      frames[`a${k}_${f}`] = { frame: { x: f, y: k, w: 1 + f, h: 2 + (k % 5) }, sourceSize: { w: 3 + f, h: 4 } };
      animations[`a${k}`].push(`a${k}_${f}`);
    }
  }
  animations.walker_go = ['a1_0', 'a2_1'];
  const walker = { isProxy: true, targetSheet: 'bigAtlas', prefix: 'walker_', animations: { go: { originalName: 'go', prefixedName: 'walker_go', index: 0 } }, indexToName: { 0: 'go' } };
  const json = { animations, frames, meta: { proxySheets: { walker } } };
  const proxySheets = { ...json.meta.proxySheets };
  addBigAtlasChunks(json, proxySheets);
  SpriteSheetRegistry.register('bigAtlas', json);
  for (const [name, proxy] of Object.entries(proxySheets)) SpriteSheetRegistry.registerProxy(name, proxy);
}

test('the texture metadata: the module builds what Scene.buildTextureMetadata builds', () => {
  install();
  const want = Scene.prototype.buildTextureMetadata.call({});
  const got = buildTextureMetadata(SpriteSheetRegistry);
  assert.deepEqual(got, want);
  assert.equal(got.totalFrames, 100 * (1 + 2 + 3) + 2);
  assert.ok(Object.keys(got.proxyToGlobalAnim).length >= 3, 'bigAtlas, its chunk and the walker');
});
