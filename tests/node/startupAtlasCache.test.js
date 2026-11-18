// SST-6: the packed atlas kept in Cache Storage by a hash of everything that decides it. The key misses on a changed
// byte of a source, a changed option, a changed built-in mark, a new engine version or engine code; a hit loads the same
// json, pixels, twin page and decal textures the pack made; a miss hands the atlas over and writes after, replacing the
// same atlas's older entries; a scene can turn it off.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATLAS_CACHE_NAME, atlasCacheKey, atlasCacheKeyText, atlasCacheSources, atlasCodeHash, resolveAssetUrls,
} from '../../src/core/atlas/atlasCache.js';
import { packAtlas } from '../../src/core/atlas/atlasPackJob.js';
import { drawBuiltinTextures } from '../../src/core/atlas/atlasBuiltins.js';
import { AssetWorker } from '../../src/core/assetWorkerClient.js';
import { runAtlasJob } from '../../src/workers/atlasWorker.js';
import {
  MemCacheStorage, MemCanvas, decalHashes, hashBytes, memPng, packScene, randomImage, rng, withFetch, withMemCanvas,
} from './startupAtlasFixtures.mjs';

const OPTIONS = { maxAtlasWidth: 512, maxAtlasHeight: 512, atlasPadding: 2, trimImages: true, trimAlphaThreshold: 0, heuristic: 'best-short-side' };
const packOptions = (extra = {}) => ({ ...OPTIONS, keepMapsTexels: true, mapsCanvas: false, sceneHeightScaleY: NaN, decals: true, ...extra });

/** The fetch withFetch installed, for the key's hashing (a bundle's key: no code to fetch). */
const keyOf = (assets, { options = packOptions(), builtins = [{ name: '_lightGradient', unshaded: false }], version = '1.0.0' } = {}) =>
  atlasCacheKey({ assets, options, builtins, bundle: true, version });

test('the key: the same inputs the same key; a changed byte, option, built-in mark or engine version another', async () => {
  const { files, assets } = packScene(1);
  await withFetch(files, async () => {
    const base = await keyOf(assets);
    assert.match(base.key, /^[0-9a-f]{64}$/);
    assert.deepEqual(await keyOf(structuredClone(assets)), base, 'the same inputs');
    assert.notEqual((await keyOf(assets, { version: '1.0.1' })).key, base.key, 'a new engine version');
    assert.notEqual((await keyOf(assets, { options: packOptions({ atlasPadding: 3 }) })).key, base.key, 'a changed option');
    assert.notEqual((await keyOf(assets, { options: packOptions({ twinFormat: 'C' }) })).key, base.key, 'a changed twin format');
    assert.notEqual((await keyOf(assets, { options: packOptions({ sceneHeightScaleY: 0.7 }) })).key, base.key, 'another camera');
    assert.notEqual((await keyOf(assets, { builtins: [{ name: '_lightGradient', unshaded: true }] })).key, base.key, 'unshaded glows');
    assert.equal((await keyOf(assets, { options: packOptions({ decals: false }) })).key, base.key, 'decals are not in the atlas');
    // An option at its default is the default: the key resolves them.
    assert.equal((await keyOf(assets, { options: packOptions({ twinFormat: 'A' }) })).key, base.key);
    const sheet = { ...assets.spritesheets.walkerA, excludeAnimations: [] };
    const other = await keyOf({ ...assets, spritesheets: { ...assets.spritesheets, walkerA: sheet } });
    assert.notEqual(other.key, base.key, 'a changed assets entry');
    assert.equal(other.slot, base.slot, 'the same atlas: the same slot');
  });
  // A changed byte of one source.
  const edited = { ...files, '/s/farm.json': files['/s/farm.json'].replace('"x":0', '"x": 0') };
  const keys = await withFetch(edited, () => keyOf(assets));
  const base = await withFetch(files, () => keyOf(assets));
  assert.notEqual(keys.key, base.key, 'a changed byte of the sheet\'s json');
  const repng = { ...files, '/s/rock.png': memPng(randomImage(rng(99), 30, 20)) };
  assert.notEqual((await withFetch(repng, () => keyOf(assets))).key, base.key, 'a changed image');
});

test('the key\'s text: the format, version, code, assets, resolved options and sources; no key for a decoded sheet', () => {
  const text = JSON.parse(atlasCacheKeyText({
    assets: { a: '/a.png' }, options: {}, builtins: [{ name: '_lightGlow', unshaded: true }], sources: [['/a.png', 'ff']], version: '9', code: 'c0de',
  }));
  assert.equal(text.format, 1);
  assert.equal(text.version, '9');
  assert.equal(text.code, 'c0de');
  assert.deepEqual(text.options, {
    maxAtlasWidth: 4096, maxAtlasHeight: 4096, atlasPadding: 2, trimImages: true, trimAlphaThreshold: 0,
    heuristic: 'best-short-side', twinFormat: 'A', sceneHeightScaleY: null, builtins: [['_lightGlow', true]],
  });
  assert.deepEqual(atlasCacheSources({ b: '/b.png', a: '/a.png', spritesheets: { s: { json: '/s.json', png: '/s.png', heightMap: { png: '/h.png' }, reliefMap: '/r.png' } } }),
    ['/a.png', '/b.png', '/h.png', '/r.png', '/s.json', '/s.png']);
  assert.equal(atlasCacheSources({ spritesheets: { adobe: { jsonData: {}, img: {} } } }), null, 'an Adobe Animate sheet: no cache');
  assert.deepEqual(resolveAssetUrls({ a: 'x.png', spritesheets: { s: { png: 'y.png', heightMap: { png: 'h.png', gray: 2 } } } }, (u) => `/r/${u}`),
    { a: '/r/x.png', spritesheets: { s: { png: '/r/y.png', heightMap: { png: '/r/h.png', gray: 2 } } } });
});

test('a source build\'s key holds its atlas code: a changed module misses', async () => {
  const texts = {};
  const fetchFn = async (url) => new Response(texts[url] ?? `// ${url}`);
  const base = 'http://game.test/src/core/atlas/atlasCache.js';
  const a = await atlasCodeHash(base, fetchFn);
  assert.equal(await atlasCodeHash(base, fetchFn), a);
  texts['http://game.test/src/core/atlas/atlasBuild.js'] = '// changed';
  assert.notEqual(await atlasCodeHash(base, fetchFn), a, 'atlasBuild.js changed');
  assert.equal(await atlasCodeHash('blob:http://game.test/1234', fetchFn), null, 'no module files: none');
});

/** packAtlas with the fakes: the scene's sources, a Cache Storage, a version. */
function run(assets, storage, { version = '1.0.0', enabled = true, extra = {} } = {}) {
  const builtins = drawBuiltinTextures({ unshadedGlows: false }).map((b) => ({ name: b.name, image: b.canvas, unshaded: b.unshaded, afterSort: b.afterSort }));
  return packAtlas({
    assets,
    options: packOptions(extra),
    builtins,
    cache: { enabled, bundle: true },
    makeCanvas: (w, h) => new MemCanvas(w, h),
    cacheEnv: { storage, origin: 'http://game.test' },
    cacheKeyOptions: { version },
  });
}

const summary = (r) => ({
  json: JSON.stringify(r.json),
  pixels: hashBytes(toStraight(r.imageBitmap)),
  maps: r.mapsBitmap ? hashBytes(r.mapsBitmap.data) : null,
  decals: decalHashes(r.decals),
});

/** A bitmap's pixels as a canvas holding it reads them (what the GPU gets after its premultiply). */
function toStraight(bitmap) {
  const c = new MemCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

test('a miss packs and writes after; a hit is the same atlas; a changed byte misses and replaces the entry', async () => {
  const { files, assets } = packScene(4);
  const storage = new MemCacheStorage();
  await withMemCanvas(() => withFetch(files, async () => {
    const miss = await run(assets, storage);
    assert.equal(miss.result.cache, 'miss');
    assert.ok(miss.background, 'the write runs after the atlas is handed over');
    assert.equal(storage.urls(ATLAS_CACHE_NAME).length, 0, 'nothing written before');
    await miss.background;
    const written = storage.urls(ATLAS_CACHE_NAME);
    assert.deepEqual(written.map((u) => u.split('/').pop()).sort(), ['atlas.json', 'atlas.png', 'maps.rgba']);
    assert.ok(written.every((u) => u.startsWith('http://game.test/__weedjs/atlas-cache/')));

    const hit = await run(assets, storage);
    assert.equal(hit.result.cache, 'hit');
    assert.equal(hit.background, null);
    assert.deepEqual(summary(hit.result), summary(miss.result), 'the same json, pixels, twin page and decal textures');

    // Another engine version: a miss, whose entry replaces the old one (the same atlas, the same slot).
    const next = await run(assets, storage, { version: '1.0.1' });
    assert.equal(next.result.cache, 'miss');
    await next.background;
    const now = storage.urls(ATLAS_CACHE_NAME);
    assert.equal(now.length, 3, 'one entry: the old one dropped');
    assert.ok(now.every((u) => !written.includes(u)));
    assert.equal((await run(assets, storage, { version: '1.0.1' })).result.cache, 'hit');
    assert.equal((await run(assets, storage, { version: '1.0.0' })).result.cache, 'miss', 'the old version\'s entry is gone');
  }));
  // A changed byte of a source: a miss.
  const edited = { ...files, '/s/bg.png': memPng(randomImage(rng(5), 12, 9)) };
  await withMemCanvas(() => withFetch(edited, async () => {
    assert.equal((await run(assets, storage)).result.cache, 'miss');
  }));
});

test('the cache off: packed, nothing read or written; a cache that fails: packed', async () => {
  const { files, assets } = packScene(6);
  await withMemCanvas(() => withFetch(files, async () => {
    const storage = new MemCacheStorage();
    const off = await run(assets, storage, { enabled: false });
    assert.equal(off.result.cache, 'off');
    assert.equal(off.background, null);
    assert.equal(storage.opened, 0);
    const broken = { open: async () => { throw new Error('quota'); } };
    const r = await packAtlas({
      assets,
      options: packOptions(),
      builtins: drawBuiltinTextures().map((b) => ({ name: b.name, image: b.canvas, unshaded: b.unshaded, afterSort: b.afterSort })),
      cache: { enabled: true, bundle: true },
      makeCanvas: (w, h) => new MemCanvas(w, h),
      cacheEnv: { storage: broken, origin: 'http://game.test' },
      cacheKeyOptions: { version: '1' },
    });
    assert.equal(r.result.cache, 'off', 'packed as if there were no cache');
    assert.deepEqual(summary(r.result), summary(off.result));
  }));
});

test('the worker client: release() stops the worker only after its background write', async () => {
  // A worker that answers a job saying it goes on, and posts backgroundDone when told to.
  let finish = null;
  const raw = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(msg) {
      setTimeout(() => {
        raw.onmessage({ data: { id: msg.id, ok: true, result: { done: 1 }, marks: ['a', 1], background: true } });
        finish = () => raw.onmessage({ data: { id: msg.id, backgroundDone: true, marks: ['atlas cache written', 2] } });
      }, 0);
    },
    terminate() {
      raw.terminated = true;
    },
  };
  const worker = new AssetWorker(raw);
  assert.deepEqual(await worker.run('pack', {}), { done: 1 });
  assert.deepEqual(worker.takeMarks(), ['a', 1]);
  const late = [];
  worker.release((marks) => late.push(...marks));
  assert.equal(raw.terminated, false, 'still writing');
  finish();
  assert.equal(raw.terminated, true);
  assert.deepEqual(late, ['atlas cache written', 2], 'the background job\'s marks, after the release');
  // With nothing in the background, release stops it at once.
  const idle = new AssetWorker({ postMessage() {}, terminate() { idle.done = true; } });
  idle.release();
  assert.equal(idle.done, true);
});

test('the worker\'s pack job answers, then writes its entry', async () => {
  const { files, assets } = packScene(8);
  await withMemCanvas(() => withFetch(files, async () => {
    const saved = globalThis.caches;
    const savedLocation = globalThis.location;
    const storage = new MemCacheStorage();
    globalThis.caches = storage;
    Object.defineProperty(globalThis, 'location', { value: { origin: 'http://game.test', href: 'http://game.test/src/workers/atlasWorker.js' }, configurable: true });
    try {
      const builtins = drawBuiltinTextures();
      const bitmaps = await Promise.all(builtins.map((b) => createImageBitmap(b.canvas)));
      const out = await runAtlasJob({
        id: 2,
        job: 'pack',
        assets,
        options: packOptions(),
        builtins: builtins.map((b, i) => ({ name: b.name, image: bitmaps[i], unshaded: b.unshaded, afterSort: b.afterSort })),
        cache: { enabled: true, bundle: true },
      });
      assert.equal(out.message.ok, true, out.message.error?.message);
      assert.equal(out.message.result.cache, 'miss');
      assert.equal(out.message.background, true);
      await out.background;
      assert.equal(storage.urls(ATLAS_CACHE_NAME).length, 3);
    } finally {
      if (saved === undefined) delete globalThis.caches;
      else globalThis.caches = saved;
      if (savedLocation === undefined) delete globalThis.location;
      else Object.defineProperty(globalThis, 'location', { value: savedLocation, configurable: true });
    }
  }));
});
