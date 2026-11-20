import test from 'node:test';
import assert from 'node:assert/strict';

// N-251. A worktree's bundles differed from the main folder's build of the same sources, so a branch could not build
// and time its own bundle in one. Two causes. (1) Webpack and Node followed the worktree's node_modules junction (the
// harness links it to the main folder's, revWorktree.mjs): babel-loader's path went into every module's identifier, so
// the deterministic ids moved, and style-loader's runtime path went into an asset's hash. The configs resolve modules
// and loaders as found, and buildBundle.js runs webpack with --preserve-symlinks. (2) atlasCache.js's bare
// import.meta.url, which webpack writes as the builder's own file:// path: every bundle carried (and published) the
// folder it was built in. A junctioned worktree and the main folder then built all 12 dist files byte for byte alike.

test('every webpack config resolves modules and loaders as found, not through a symlink', async () => {
  const { default: workers } = await import('../../webpack.config.js');
  const { default: bundles } = await import('../../webpack.bundle.config.js');
  const configs = [...workers, ...bundles];
  assert.equal(configs.length, 4);
  for (const config of configs) {
    const name = config.output?.filename || config.name;
    assert.equal(config.resolve?.symlinks, false, `${name}: resolve.symlinks`);
    assert.equal(config.resolveLoader?.symlinks, false, `${name}: resolveLoader.symlinks`);
  }
});

test("buildBundle runs webpack with Node's symlinks preserved", async () => {
  const { makeBuildEnv } = await import('../../scripts/buildBundle.js');
  const flags = makeBuildEnv(false, false).NODE_OPTIONS.split(/\s+/);
  assert.ok(flags.includes('--preserve-symlinks'), flags.join(' '));
  assert.ok(flags.includes('--preserve-symlinks-main'), flags.join(' '));
});

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
