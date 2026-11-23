// A baked atlas from before a built-in texture (Predator's and littleCity's lack E-498's _lightGlow and the metaball)
// gets the ones it lacks at load: drawn where its frames leave room (or on rows below
// it), a frame and a one-frame animation each after the atlas's own, in the renderer's bitmap and in the decal textures,
// so pre-render finds them (demoWarnings: "animationNameToIndex missing _lightGlow") without baking the demos again.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_TEXTURES, drawBuiltinTextures, missingBuiltins } from '../../src/core/atlas/atlasBuiltins.js';
import { placeBuiltins } from '../../src/core/atlas/bakedPixels.js';
import { loadBakedAtlas } from '../../src/core/atlas/bakedAtlas.js';
import { AssetWorker } from '../../src/core/assetWorkerClient.js';
import {
  canvasOfImage, decalHashes, extractDecalTexturesReference, fakeWorker, hashBytes, memPng, randomImage, rng, withFetch,
  withMemCanvas,
} from './startupAtlasFixtures.mjs';

const overlaps = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

test('the built-ins: createBigAtlas\'s order, and the ones a json lacks (never _empty)', () => {
  assert.deepEqual(BUILTIN_TEXTURES.map((b) => b.name), [
    '_empty', '_lightGradient', '_lightGlow', '_metaball', '_bulletTrail', '_white', '_whiteCircle', '_whiteCircle_64x64',
  ]);
  // Predator's bake (demos/img/baked/PredatorScene/bigAtlas.json) holds these five.
  const predator = { animations: Object.fromEntries(['_empty', '_lightGradient', '_bulletTrail', '_white', '_whiteCircle', '_whiteCircle_64x64'].map((n) => [n, [n]])) };
  assert.deepEqual(missingBuiltins(predator), ['_lightGlow', '_metaball']);
  assert.deepEqual(missingBuiltins({ animations: {} }).includes('_empty'), false);
});

test('placeBuiltins: in the room the frames leave, padded from them; on rows below when it is full', () => {
  const pad = 2;
  // Frames down the left half of a 128 × 96 atlas: room on the right.
  const frames = {};
  for (let k = 0; k < 6; k++) frames[`f${k}`] = { frame: { x: pad, y: pad + k * 16, w: 60, h: 12 } };
  const adds = [{ width: 40, height: 40 }, { width: 10, height: 1 }, { width: 20, height: 40 }];
  const room = placeBuiltins(frames, 128, 96, adds, pad);
  assert.deepEqual([room.width, room.height], [128, 96], 'the atlas keeps its size');
  room.rects.forEach((r, i) => {
    const a = { x: r.x, y: r.y, w: adds[i].width, h: adds[i].height };
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 128 && a.y + a.h <= 96, `add ${i} inside the atlas`);
    for (const f of Object.values(frames)) assert.equal(overlaps(a, f.frame, pad), false, `add ${i} padded from every frame`);
    room.rects.forEach((q, j) => {
      if (j !== i) assert.equal(overlaps(a, { x: q.x, y: q.y, w: adds[j].width, h: adds[j].height }, pad), false);
    });
  });
  // A full atlas: rows below it, the atlas taller (as wide as before when they fit across).
  const full = { all: { frame: { x: 0, y: 0, w: 128, h: 96 } } };
  const below = placeBuiltins(full, 128, 96, adds, pad);
  assert.equal(below.width, 128);
  assert.ok(below.height > 96);
  below.rects.forEach((r, i) => assert.ok(r.y >= 96 + pad && r.x + adds[i].width <= 128, `add ${i} below`));
  // Nothing to add: nothing changes.
  assert.deepEqual(placeBuiltins(full, 128, 96, [], pad), { width: 128, height: 96, rects: [] });
});

/** A bake lacking some built-ins: a random image, its frames on the left, the built-ins it has as 8 × 8 frames. */
function staleBake(seed, lacks) {
  const r = rng(seed);
  const W = 400;
  const H = 300;
  const image = randomImage(r, W, H);
  const frames = { _empty: { frame: { x: 0, y: 0, w: 1, h: 1 } } };
  const animations = { _empty: ['_empty'] };
  for (let k = 0; k < 20; k++) {
    frames[`f${k}`] = { frame: { x: 2 + (k % 4) * 30, y: 2 + ((k / 4) | 0) * 30, w: 26, h: 26 }, base: { texels: 1, solidTexels: 3 } };
    animations[`a${k}`] = [`f${k}`];
  }
  for (const { name } of BUILTIN_TEXTURES) {
    if (name === '_empty' || lacks.includes(name)) continue;
    frames[name] = { frame: { x: 140, y: 2 + Object.keys(frames).length * 10, w: 8, h: 8 } };
    animations[name] = [name];
  }
  return { image, json: { frames, animations, meta: { size: { w: W, h: H }, proxySheets: {} } } };
}

test('a stale bake gets its missing built-ins at load: json, renderer bitmap and decals, through the worker or the page', async () => {
  await withMemCanvas(async () => {
    const lacks = ['_lightGlow', '_metaball'];
    const drawn = Object.fromEntries(drawBuiltinTextures({ only: lacks }).map((b) => [b.name, b.canvas]));
    const results = [];
    for (const kind of ['worker', 'page', 'broken']) {
      const { image, json } = staleBake(5, lacks);
      const ownFrames = Object.keys(json.frames);
      const ownAnimations = Object.keys(json.animations);
      const files = { '/b/bigAtlas.json': JSON.stringify(json), '/b/bigAtlas.png': memPng(image) };
      const raw = kind === 'page' ? null : fakeWorker({ loads: kind === 'worker' });
      const worker = raw ? new AssetWorker(raw) : null;
      const atlas = await withFetch(files, () => loadBakedAtlas(
        { json: '/b/bigAtlas.json', png: '/b/bigAtlas.png' },
        { decals: true, sceneName: 'Stale', worker, unshadedGlows: true, padding: 2 },
      ));
      worker?.close();
      const got = atlas.json;
      assert.deepEqual(Object.keys(got.animations), [...ownAnimations, ...lacks], `${kind}: the built-ins after the atlas's own animations`);
      assert.deepEqual(Object.keys(got.frames).slice(0, ownFrames.length), ownFrames, 'the bake\'s frames first, as they were');
      for (const name of lacks) {
        const f = got.frames[name].frame;
        assert.deepEqual([f.w, f.h], [drawn[name].width, drawn[name].height], `${kind}: ${name} at its size`);
        assert.ok(f.x + f.w <= got.meta.size.w && f.y + f.h <= got.meta.size.h);
        for (const own of ownFrames) assert.equal(overlaps(f, got.frames[own].frame), false, `${name} over no frame of the bake`);
        assert.deepEqual(got.animations[name], [name]);
      }
      // DX-GLOWRADIUS: the compact glow unshaded with the scene's other glows, and the atlas marked.
      assert.equal(got.frames._lightGlow.unshaded, true);
      assert.equal(got.frames._metaball.unshaded, undefined);
      assert.equal(got.meta.unshaded, true);
      // The renderer's bitmap: the bake's pixels where they were, the built-ins where the json says.
      const bmp = atlas.imageBitmap;
      assert.deepEqual([bmp.width, bmp.height], [got.meta.size.w, got.meta.size.h]);
      const canvas = canvasOfImage(bmp);
      const ctx = canvas.getContext('2d');
      const old = canvasOfImage(image).getContext('2d');
      const own = got.frames.f7.frame;
      assert.equal(hashBytes(ctx.getImageData(own.x, own.y, own.w, own.h).data), hashBytes(old.getImageData(own.x, own.y, own.w, own.h).data));
      const glow = got.frames._lightGlow.frame;
      // The fakes draw a built-in opaque white.
      assert.deepEqual(Array.from(ctx.getImageData(glow.x, glow.y, 1, 1).data), [255, 255, 255, 255]);
      // The decal textures: what the page's old readback would have read from the completed atlas.
      const want = extractDecalTexturesReference(canvas, got);
      assert.deepEqual(decalHashes(atlas.decals), decalHashes(want), `${kind}: the decal textures of the completed atlas`);
      assert.equal(atlas.decals.frameNameToId._metaball, Object.keys(got.animations).length + Object.keys(got.frames).indexOf('_metaball'));
      // The built-ins get texels (fillFrameTexels's, as every bake's built-ins do at load); the bake's frames keep theirs.
      assert.equal(typeof got.frames._metaball.base?.texels, 'number');
      assert.deepEqual(got.frames.f3.base, { texels: 1, solidTexels: 3 });
      results.push({ json: JSON.stringify(got), pixels: hashBytes(canvas.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data) });
    }
    assert.equal(results[1].json, results[0].json, 'the page makes the json the worker makes');
    assert.equal(results[2].json, results[0].json);
    assert.equal(results[1].pixels, results[0].pixels, 'and the same bitmap');
    assert.equal(results[2].pixels, results[0].pixels);
  });
});

test('a bake with every built-in loads as it is: the PNG decoded for the renderer, no frame added', async () => {
  await withMemCanvas(async () => {
    const { image, json } = staleBake(9, []);
    const files = { '/b/bigAtlas.json': JSON.stringify(json), '/b/bigAtlas.png': memPng(image) };
    const worker = new AssetWorker(fakeWorker());
    const atlas = await withFetch(files, () => loadBakedAtlas(
      { json: '/b/bigAtlas.json', png: '/b/bigAtlas.png' },
      { decals: false, sceneName: 'Fresh', worker },
    ));
    worker.close();
    assert.deepEqual(Object.keys(atlas.json.animations), Object.keys(json.animations));
    assert.deepEqual(atlas.json.meta.size, json.meta.size);
    assert.equal(hashBytes(atlas.imageBitmap.data), hashBytes(image.data), 'the decoded PNG, not a canvas copy');
    assert.equal(atlas.decals, null);
  });
});
