import test from 'node:test';
import assert from 'node:assert/strict';

import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';

// E-84: pre-render looks an asset up by id per character per frame. The id lookup must find what
// the name lookup finds, through re-registration, a serialize round trip (how workers receive the
// registry) and a scene unload.

test('getAsset by id finds what the name finds, through a serialize round trip', () => {
  AdobeAnimRegistry.clearForSceneUnload();
  const a = { clipFrameRate: [24] };
  const b = { clipFrameRate: [12, 30] };
  const ida = AdobeAnimRegistry.register('a', a);
  const idb = AdobeAnimRegistry.register('b', b);
  assert.equal(AdobeAnimRegistry.getAsset(ida), a);
  assert.equal(AdobeAnimRegistry.getAsset('b'), b);
  assert.equal(AdobeAnimRegistry.getClipFrameRate(idb, 1), 30);
  assert.equal(AdobeAnimRegistry.getAsset(0), null, 'id 0 is no asset');
  assert.equal(AdobeAnimRegistry.getAsset(99), null, 'an unknown id is no asset');

  const a2 = { clipFrameRate: [60] };
  assert.equal(AdobeAnimRegistry.register('a', a2), ida, 'a name keeps its id');
  assert.equal(AdobeAnimRegistry.getAsset(ida), a2, 'and the id finds the new asset');

  AdobeAnimRegistry.deserialize(AdobeAnimRegistry.serialize());
  assert.equal(AdobeAnimRegistry.getClipFrameRate(ida, 0), 60);
  assert.equal(AdobeAnimRegistry.getClipFrameRate(idb, 1), 30);
  assert.equal(AdobeAnimRegistry.getAsset(idb), AdobeAnimRegistry.getAsset('b'));

  AdobeAnimRegistry.clearForSceneUnload();
  assert.equal(AdobeAnimRegistry.getAsset(ida), null, 'unload drops every id');
});
