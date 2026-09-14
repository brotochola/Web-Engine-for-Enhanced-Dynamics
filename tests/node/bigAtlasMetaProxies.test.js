import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

test('meta.proxySheets registration resolves proxy anim names', () => {
  SpriteSheetRegistry.clearForSceneUnload();

  const atlasJson = {
    frames: {
      civil1_hurt_0: {
        frame: { x: 0, y: 0, w: 8, h: 8 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 },
        sourceSize: { w: 8, h: 8 },
      },
      rock1: {
        frame: { x: 8, y: 0, w: 8, h: 8 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 },
        sourceSize: { w: 8, h: 8 },
      },
    },
    animations: {
      _empty: ['_empty'],
      civil1_hurt: ['civil1_hurt_0'],
      rock1: ['rock1'],
    },
    meta: {
      image: 'bigAtlas.png',
      format: 'RGBA8888',
      size: { w: 16, h: 8 },
      scale: 1,
      proxySheets: {
        civil1: {
          isProxy: true,
          targetSheet: 'bigAtlas',
          prefix: 'civil1_',
          animations: {
            hurt: { index: 0, prefixedName: 'civil1_hurt' },
          },
          indexToName: { 0: 'hurt' },
        },
      },
      individualTextures: ['rock1'],
    },
  };

  SpriteSheetRegistry.register('bigAtlas', atlasJson);
  for (const [sheetName, proxyData] of Object.entries(atlasJson.meta.proxySheets)) {
    SpriteSheetRegistry.registerProxy(sheetName, proxyData);
  }
  for (const name of atlasJson.meta.individualTextures) {
    SpriteSheetRegistry.registerSpritesheetId(name);
  }

  assert.equal(SpriteSheetRegistry.getAnimationIndex('civil1', 'hurt'), 0);
  assert.equal(SpriteSheetRegistry.getFrameName('civil1', 'hurt', 0), 'civil1_hurt_0');
  assert.equal(SpriteSheetRegistry.getBigAtlasAnimName('civil1', 'hurt'), 'civil1_hurt');
  assert.ok(SpriteSheetRegistry.getSpritesheetId('rock1') > 0);

  SpriteSheetRegistry.clearForSceneUnload();
});
