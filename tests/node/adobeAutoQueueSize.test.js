// N-73: the main render queue's auto size counts Adobe Animate pieces. The scene sizes the queue (reserveBox2dBlock,
// createSharedBuffers) long before AdobeAnimRegistry fills (after the atlas), so it reads the assets init compiled
// (Scene._preparedAdobeAssets); with neither, a character got one row and its pieces ran out of queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';
import { AdobeAnimCompiler } from '../../src/util/adobeAnimCompiler.js';
import { computeAutoMaxVisibleRenderables, resolveMaxVisibleRenderables } from '../../src/util/sceneSharedBuffers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function willian() {
  const dir = path.join(repoRoot, 'demos/fla/willian/willian2');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
  return AdobeAnimCompiler.compile('willian', read('Animation.json'), read('spritemap1.json'));
}

class Character {}
class Prop {}

function scene(prepared) {
  return {
    totalEntityCount: 1010,
    registeredClasses: [
      { class: Character, count: 10, components: [SpriteRenderer, AdobeAnimComponent] },
      { class: Prop, count: 1000, components: [SpriteRenderer] },
    ],
    config: { renderer: {}, lighting: { enabled: false } },
    _preparedAdobeAssets: prepared,
  };
}

test('the auto size counts the pieces of the assets init compiled', () => {
  AdobeAnimRegistry.clearForSceneUnload();
  const asset = willian();
  let most = 1;
  for (const c of asset.framePieceCount) if (c > most) most = c;
  assert.ok(most > 1, `the demo character draws ${most} pieces in its largest frame`);

  assert.equal(computeAutoMaxVisibleRenderables(scene(null)), 1010, 'with nothing compiled yet: one row a character');
  const s = scene({ compiledAssets: { willian: asset }, spritesheetConfigs: {} });
  assert.equal(computeAutoMaxVisibleRenderables(s), 1010 + 10 * (most - 1), 'every piece of the largest frame');
  resolveMaxVisibleRenderables(s);
  assert.equal(s.config.renderer.maxVisibleRenderables, 1010 + 10 * (most - 1), 'the size the scene keeps');
});
