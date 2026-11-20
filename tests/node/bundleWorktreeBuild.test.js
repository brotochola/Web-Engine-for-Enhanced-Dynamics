import test from 'node:test';
import assert from 'node:assert/strict';

// N-251. A worktree's bundles differed from the main folder's build of the same sources. One cause: atlasCache.js's bare
// import.meta.url, which webpack writes as the builder's own file:// path, so every bundle carried (and published) the
// folder it was built in.

test('in a webpack build the atlas code base is no path: no module files to hash', async () => {
  const source = await import('../../src/core/atlas/atlasCache.js');
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    return new Response(`// ${url}`);
  };
  assert.match(String(await source.atlasCodeHash(undefined, fetchFn)), /^[0-9a-f]{64}$/, 'a source build hashes its modules');
  assert.ok(fetched.length > 0 && fetched.every((u) => u.startsWith('file:')), 'from its own file URL');
  globalThis.__WEED_BUILD_INPUTS__ = 'n251';
  try {
    const bundled = await import('../../src/core/atlas/atlasCache.js?n251-bundle');
    fetched.length = 0;
    assert.equal(await bundled.atlasCodeHash(undefined, fetchFn), null);
    assert.equal(fetched.length, 0);
  } finally {
    delete globalThis.__WEED_BUILD_INPUTS__;
  }
});
