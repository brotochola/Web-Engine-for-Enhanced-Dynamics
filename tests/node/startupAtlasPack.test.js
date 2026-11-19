// SST-5 steps 1-2: the packed atlas built in the atlas worker (src/workers/atlasWorker.js 'pack') is the atlas the page
// packed on its own thread (SpriteSheetRegistry.createBigAtlas): the same json, the same pixels, the same twin page and
// the same decal textures; the page's loader gets it through the worker, on its own thread, or when the worker fails.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { atlasComposeList, drawComposeList, paintMapsPage } from '../../src/core/atlas/atlasBuild.js';
import { drawBuiltinTextures } from '../../src/core/atlas/atlasBuiltins.js';
import { assetsForWorker, loadPackedAtlas } from '../../src/core/atlas/packedAtlas.js';
import { AssetWorker } from '../../src/core/assetWorkerClient.js';
import { runAtlasJob } from '../../src/workers/atlasWorker.js';
import {
  MemCanvas, blobImage, decalHashes, extractDecalTexturesReference, fakeWorker, hashBytes, hashPixels, packScene, rng,
  withFetch, withMemCanvas,
} from './startupAtlasFixtures.mjs';

const OPTIONS = { maxAtlasWidth: 512, maxAtlasHeight: 512, atlasPadding: 2, trimImages: true, trimAlphaThreshold: 0, heuristic: 'best-short-side' };

/** The page's pack (createBigAtlas, on this thread) and its decal textures as Scene.extractDecalTextures read them. */
async function pagePack(assets, { unshadedGlows, twinFormat }) {
  const packed = await SpriteSheetRegistry.createBigAtlas(assets, { ...OPTIONS, keepMapsTexels: true, unshadedGlows, twinFormat, camera: null });
  return { packed, decals: extractDecalTexturesReference(packed.canvas, packed.json) };
}

test('the worker\'s pack job: the page\'s json, pixels, twin page and decal textures', async () => {
  for (const seed of [1, 2, 3]) {
    for (const [unshadedGlows, twinFormat] of [[false, 'A'], [true, 'C']]) {
      const { files, assets } = packScene(seed);
      await withMemCanvas(() => withFetch(files, async () => {
        const { packed, decals } = await pagePack(assets, { unshadedGlows, twinFormat });
        const builtins = drawBuiltinTextures({ unshadedGlows });
        const bitmaps = await Promise.all(builtins.map((b) => createImageBitmap(b.canvas)));
        const { message, transfer } = await runAtlasJob({
          id: 3,
          job: 'pack',
          assets,
          options: { ...OPTIONS, twinFormat, keepMapsTexels: true, mapsCanvas: false, sceneHeightScaleY: NaN, decals: true },
          builtins: builtins.map((b, i) => ({ name: b.name, image: bitmaps[i], unshaded: b.unshaded, afterSort: b.afterSort })),
        });
        assert.equal(message.ok, true, message.error?.message);
        const got = message.result;
        assert.equal(JSON.stringify(got.json), JSON.stringify(packed.json), `seed ${seed}: the json`);
        assert.ok(packed.json.meta.maps, 'the scene has a twin page');
        assert.equal(hashBytes(got.imageBitmap.data), hashBytes(packed.canvas.transferToImageBitmap().data), `seed ${seed}: the pixels`);
        assert.equal(hashBytes(got.mapsBitmap.data), hashBytes(packed.mapsTexels), `seed ${seed}: the twin page's texels`);
        assert.deepEqual(decalHashes(got.decals), decalHashes(decals), `seed ${seed}: the decal textures`);
        assert.ok(transfer.includes(got.imageBitmap) && transfer.includes(got.mapsBitmap));
        const names = message.marks.filter((_, i) => i % 2 === 0);
        for (const m of ['atlas sources', 'atlas pack', 'atlas draw', 'atlas maps', 'atlas built', 'atlas worker bitmaps']) {
          assert.ok(names.includes(m), `the worker marks ${m}`);
        }
      }));
    }
  }
});

test('loadPackedAtlas: the same atlas through the worker, on the page, and when the worker fails; ids as a pack registers them', async () => {
  const { files, assets } = packScene(7);
  const results = [];
  for (const kind of ['worker', 'page', 'broken']) {
    await withMemCanvas(() => withFetch(files, async () => {
      SpriteSheetRegistry.spritesheetNames = [''];
      SpriteSheetRegistry.spritesheetNameToId = new Map();
      const raw = kind === 'page' ? null : fakeWorker({ loads: kind === 'worker' });
      const worker = raw ? new AssetWorker(raw) : null;
      const atlas = await loadPackedAtlas(assets, { options: OPTIONS, camera: null, unshadedGlows: false, decals: true, worker });
      worker?.close();
      results.push({
        json: JSON.stringify(atlas.json),
        pixels: hashBytes(atlas.imageBitmap.data),
        maps: hashBytes(atlas.mapsBitmap.data),
        decals: decalHashes(atlas.decals),
        ids: SpriteSheetRegistry.spritesheetNames.slice(),
      });
      const shown = await atlas.inspect();
      assert.equal(shown.width, atlas.json.meta.size.w, `${kind}: the inspector packs it again on demand`);
    }));
  }
  assert.deepEqual(results[0].ids, ['', 'rock', 'bg'], 'the individual textures, in their declared order, first');
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test('the compose list draws the atlas the old loop drew', () => {
  const r = rng(3);
  const sheet = blobImage(r, 40, 30, 20);
  const image = blobImage(r, 10, 6, 3);
  const frames = [
    { sourceImg: sheet, sourceRect: { x: 3, y: 2, w: 10, h: 7 }, rect: { x: 0, y: 0, width: 10, height: 7 } },
    { sourceImg: sheet, sourceRect: { x: 20, y: 10, w: 15, h: 12 }, rect: { x: 12, y: 0, width: 15, height: 12 } },
    { sourceImg: image, sourceRect: null, rect: { x: 0, y: 14, width: 10, height: 6 } },
    { sourceImg: image, sourceRect: null },
  ];
  const old = new MemCanvas(40, 30);
  const octx = old.getContext('2d');
  for (const d of frames) {
    if (!d.rect) continue;
    if (d.sourceRect) octx.drawImage(d.sourceImg, d.sourceRect.x, d.sourceRect.y, d.sourceRect.w, d.sourceRect.h, d.rect.x, d.rect.y, d.rect.width, d.rect.height);
    else octx.drawImage(d.sourceImg, d.rect.x, d.rect.y, d.rect.width, d.rect.height);
  }
  const list = atlasComposeList(frames, 40, 30);
  assert.equal(list.sources.length, 2, 'each source once');
  assert.equal(list.draws.length, 3 * 7, 'a draw a placed frame');
  const neu = new MemCanvas(40, 30);
  drawComposeList(neu.getContext('2d'), list);
  assert.equal(hashPixels(neu), hashPixels(old));
});

test('the twin page without its canvas: the same texels', () => {
  const r = rng(11);
  const heights = blobImage(r, 8, 4, 4);
  const sheet = blobImage(r, 8, 4, 4);
  for (let p = 0; p < 32; p++) sheet.data[p * 4 + 3] = 255;
  const frame = () => [{
    sourceImg: sheet, sourceRect: { x: 0, y: 0, w: 8, h: 4 }, frameRect: { x: 0, y: 0, w: 8, h: 4 }, rect: { x: 0, y: 0, width: 8, height: 4 },
    maps: { heightImg: heights, normalImg: null, gray: 0, key: 'k' },
  }];
  return withMemCanvas(() => {
    const withCanvas = paintMapsPage(frame(), 64, 64, true);
    const without = paintMapsPage(frame(), 64, 64, true, false);
    assert.ok(withCanvas.canvas);
    assert.equal(without.canvas, null);
    assert.equal(hashBytes(without.texels), hashBytes(withCanvas.texels));
  });
});

test('assetsForWorker: every file URL resolved against the page, the rest as it is', async () => {
  const resolve = (u) => `https://game.test/${u.replace(/^\//, '')}`;
  const { assets } = await assetsForWorker({
    rock: 'img/rock.png',
    spritesheets: {
      hero: { json: 'img/hero.json', png: '/img/hero.png', heightMap: { png: 'img/hero_h.png', gray: 3 }, normalMap: 'img/hero_n.png', reliefMap: 'img/r.png', excludeAnimations: ['x'] },
    },
  }, resolve);
  assert.equal(assets.rock, 'https://game.test/img/rock.png');
  assert.deepEqual(assets.spritesheets.hero, {
    json: 'https://game.test/img/hero.json',
    png: 'https://game.test/img/hero.png',
    heightMap: { png: 'https://game.test/img/hero_h.png', gray: 3 },
    normalMap: 'https://game.test/img/hero_n.png',
    reliefMap: 'https://game.test/img/r.png',
    excludeAnimations: ['x'],
  });
});
