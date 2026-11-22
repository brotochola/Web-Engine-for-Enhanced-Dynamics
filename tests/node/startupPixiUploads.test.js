// SST-7 step 1: every texture the renderer's init message brought (the atlas, its maps page, the loose textures, the
// tilesets) goes to the GPU at init, once each, through Pixi's texture system (initSource), not at its first draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Texture, TextureSource } from '../../src/vendor/pixi.min.js';
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

test('the atlas, its maps page, the loose textures and the tilesets go to the GPU at init, each once', async () => {
  const px = await renderer();
  const atlas = new TextureSource({ width: 8, height: 8, label: 'atlas' });
  const maps = new TextureSource({ width: 8, height: 8, label: 'maps' });
  const loose = new TextureSource({ width: 4, height: 4, label: 'loose' });
  const tileset = new TextureSource({ width: 4, height: 4, label: 'tileset' });
  px.assets.spritesheets = { bigAtlas: { source: atlas }, cars: { source: atlas, isProxy: true } };
  px.assets.atlasMapsSource = maps;
  px.assets.textures = { car_1: new Texture({ source: atlas }), car_2: new Texture({ source: atlas }), bunny: new Texture({ source: loose }) };
  px.assets.tilemaps = { ground: { tilesetTexture: new Texture({ source: tileset }) } };
  const uploaded = [];
  px.pixiApp = { renderer: { texture: { initSource: (source) => uploaded.push(source.label) } } };
  px.assets.uploadAssetTextures();
  assert.deepEqual(uploaded, ['atlas', 'maps', 'loose', 'tileset']);
});
