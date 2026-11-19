import test from 'node:test';
import assert from 'node:assert/strict';
import { packScene, withFetch } from './startupAtlasFixtures.mjs';

// The atlas cache keys a bundle's atlas by its build (the hash of the sources it was built from, which buildBundle.js
// hands webpack's DefinePlugin as __WEED_BUILD_INPUTS__): two bundles of one engine version built from different code
// get different keys. Without a build (webpack not run, or a source build's bundle flag), the key is as before.

/** atlasCache.js evaluated afresh with __WEED_BUILD_INPUTS__ as `build` (undefined: none). */
async function cacheModule(build, tag) {
  if (build === undefined) delete globalThis.__WEED_BUILD_INPUTS__;
  else globalThis.__WEED_BUILD_INPUTS__ = build;
  try {
    return await import(`../../src/core/atlas/atlasCache.js?build=${tag}`);
  } finally {
    delete globalThis.__WEED_BUILD_INPUTS__;
  }
}

test('a bundle\'s atlas key holds its build: two builds of one version miss each other', async () => {
  const { files, assets } = packScene(3);
  // One at a time: each module reads the global as it is evaluated.
  const a = await cacheModule('aaaa1111', 'a');
  const a2 = await cacheModule('aaaa1111', 'a2');
  const b = await cacheModule('bbbb2222', 'b');
  const none = await cacheModule(undefined, 'none');
  const empty = await cacheModule('', 'empty');
  const options = { maxAtlasWidth: 512, maxAtlasHeight: 512, atlasPadding: 2, trimImages: true };
  const builtins = [{ name: '_lightGradient', unshaded: false }];
  await withFetch(files, async () => {
    const keyOf = (m) => m.atlasCacheKey({ assets, options, builtins, bundle: true, version: '1.0.0' }).then((k) => k.key);
    const [ka, ka2, kb, kn, ke] = await Promise.all([keyOf(a), keyOf(a2), keyOf(b), keyOf(none), keyOf(empty)]);
    assert.equal(ka, ka2, 'the same build: the same key');
    assert.notEqual(ka, kb, 'another build of the same version: another key');
    assert.notEqual(ka, kn);
    assert.equal(kn, ke, 'an empty build is no build');
  });
});
