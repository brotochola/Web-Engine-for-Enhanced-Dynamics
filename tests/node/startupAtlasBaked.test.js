// SST-5 step 4: a baked atlas's decal textures and frame texels, read from its PNG in the atlas worker (or on the page
// without one) instead of from a 2D canvas of the whole atlas on the page, are what Scene.extractDecalTextures and
// fillFrameTexels made from that canvas: the same textures by id, the same pixels, the same texels.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cutPixels, decalTexturesFrom, decalTextureBuffers, needsFrameTexels, readAtlasPixels,
} from '../../src/core/atlas/atlasFrames.js';
import { loadBakedAtlas, siblingAssetUrl } from '../../src/core/atlas/bakedAtlas.js';
import { AssetWorker, runJobOrHere } from '../../src/core/assetWorkerClient.js';
import { runAtlasJob } from '../../src/workers/atlasWorker.js';
import { fillFrameTexels } from '../../src/render/frameBase.js';
import { BUILTIN_TEXTURES } from '../../src/core/atlas/atlasBuiltins.js';
import {
  MemCanvas, canvasOfImage, decalHashes, extractDecalTexturesReference, fakeWorker, hashBytes, hashJson, memPng, randomImage, rng,
  withFetch, withMemCanvas,
} from './startupAtlasFixtures.mjs';

/** A baked atlas: a random image and a json of frames placed on it, animations of them (some empty, one naming no frame). */
function bakedAtlas(seed, { texels = false, lacks = [] } = {}) {
  const r = rng(seed);
  const W = 64 + ((r() * 64) | 0);
  const H = 48 + ((r() * 48) | 0);
  const image = randomImage(r, W, H);
  const frames = {};
  const animations = { _empty: ['_empty'] };
  frames._empty = { frame: { x: 0, y: 0, w: 1, h: 1 }, ...(texels ? { base: { texels: 0, solidTexels: 0 } } : {}) };
  for (let k = 0; k < 40; k++) {
    const w = 1 + ((r() * 20) | 0);
    const h = 1 + ((r() * 20) | 0);
    // Some frames run past the atlas's right and bottom edges: getImageData reads transparent there.
    const x = (r() * (W - 2)) | 0;
    const y = (r() * (H - 2)) | 0;
    frames[`f${k}`] = { frame: { x, y, w, h }, ...(texels ? { base: { texels: k & 3, solidTexels: k } } : {}) };
  }
  for (let a = 0; a < 12; a++) animations[`anim${a}`] = [`f${a * 3}`, `f${a * 3 + 1}`];
  animations.empty = [];
  animations.ghost = ['nope'];
  animations.again = ['f5'];
  // The engine's built-ins, as a bake has them (one it lacks is added at load: startupAtlasBuiltins.test.js).
  for (const { name } of BUILTIN_TEXTURES) {
    if (name === '_empty' || lacks.includes(name)) continue;
    frames[name] = { frame: { x: (r() * (W - 9)) | 0, y: (r() * (H - 9)) | 0, w: 8, h: 8 }, ...(texels ? { base: { texels: 0, solidTexels: 64 } } : {}) };
    animations[name] = [name];
  }
  return { image, json: { frames, animations, meta: { size: { w: W, h: H } } } };
}

test('cutPixels reads a rectangle as getImageData does: transparent outside the read region', () => {
  const r = rng(7);
  const image = randomImage(r, 20, 10);
  const canvas = canvasOfImage(image);
  const ctx = canvas.getContext('2d');
  const all = { data: ctx.getImageData(0, 0, 20, 10).data, x: 0, y: 0, width: 20, height: 10 };
  for (const [x, y, w, h] of [[0, 0, 20, 10], [3, 4, 5, 2], [15, 7, 10, 10], [-2, -1, 4, 4], [25, 0, 3, 3], [0, 0, 0, 3]]) {
    assert.deepEqual(cutPixels(all, x, y, w, h), w > 0 && h > 0 ? ctx.getImageData(x, y, w, h).data : new Uint8ClampedArray(0), `${x},${y} ${w}x${h}`);
  }
});

test('the decal textures from the atlas pixels are extractDecalTextures\'s, by id, each frame read once', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { image, json } = bakedAtlas(seed);
    const canvas = canvasOfImage(image);
    const want = extractDecalTexturesReference(canvas, json);
    let reads = 0;
    const ctx = canvas.getContext('2d');
    const got = decalTexturesFrom(json, (x, y, w, h) => {
      reads++;
      return ctx.getImageData(x, y, w, h).data;
    });
    assert.deepEqual(decalHashes(got), decalHashes(want), `seed ${seed}`);
    assert.deepEqual(got.frameNameToId, want.frameNameToId);
    assert.equal(reads, Object.keys(json.frames).length, 'one read a frame: an animation shares its first frame\'s');
    // f0 is anim0's first frame: one buffer under both ids, listed once for a transfer.
    assert.equal(got.textures[1].rgba, got.textures[got.frameNameToId.f0].rgba);
    const buffers = decalTextureBuffers(got.textures);
    assert.equal(buffers.length, new Set(buffers).size);
    assert.equal(buffers.length, Object.keys(json.frames).length);
  }
});

test('readAtlasPixels: decals per frame when the bake has texels, the whole atlas once (and its texels) when not', () => {
  for (const texels of [false, true]) {
    for (let seed = 11; seed <= 14; seed++) {
      const { image, json } = bakedAtlas(seed, { texels });
      const canvas = canvasOfImage(image);
      const want = extractDecalTexturesReference(canvas, json);
      const wantJson = structuredClone(json);
      const ctx = canvas.getContext('2d');
      fillFrameTexels(wantJson, () => ({ data: ctx.getImageData(0, 0, image.width, image.height).data, x: 0, y: 0, width: image.width, height: image.height }));
      assert.equal(needsFrameTexels(json), !texels, texels ? 'every frame has its texels' : 'the frames lack texels');
      const read = readAtlasPixels(image, json, { decals: true, makeCanvas: (w, h) => new MemCanvas(w, h) });
      assert.deepEqual(decalHashes(read.decals), decalHashes(want), `seed ${seed} texels ${texels}`);
      assert.equal(read.texels === null, texels, 'texels read only for a bake without them');
      const filled = structuredClone(json);
      for (const [name, [t, solid]] of Object.entries(read.texels || {})) filled.frames[name].base = { ...(filled.frames[name].base || {}), texels: t, solidTexels: solid };
      assert.equal(hashJson(filled), hashJson(wantJson), 'the same texels fillFrameTexels wrote');
    }
  }
  // A bake with every texel and no decals reads nothing.
  const { image, json } = bakedAtlas(3);
  for (const f of Object.values(json.frames)) f.base = { texels: 0, solidTexels: 1 };
  let made = 0;
  const none = readAtlasPixels(image, json, { decals: false, makeCanvas: (w, h) => (made++, new MemCanvas(w, h)) });
  assert.deepEqual(none, { decals: null, texels: null });
  assert.equal(made, 0, 'no canvas');
  // An atlas with maps keeps its frames as they are (fillFrameTexels leaves it).
  const mapped = bakedAtlas(4);
  mapped.json.meta.maps = true;
  assert.equal(needsFrameTexels(mapped.json), false);
});

test('the atlas worker\'s bakedPixels job decodes the PNG and returns what the page read before', async () => {
  await withMemCanvas(async () => {
    const { image, json } = bakedAtlas(21);
    const canvas = canvasOfImage(image);
    const want = extractDecalTexturesReference(canvas, json);
    const { message, transfer } = await runAtlasJob({ id: 4, job: 'bakedPixels', png: memPng(image), json, decals: true });
    assert.equal(message.ok, true, message.error?.message);
    assert.equal(message.id, 4);
    assert.deepEqual(decalHashes(message.result.decals), decalHashes(want));
    assert.equal(transfer.length, Object.keys(json.frames).length, 'each frame\'s buffer transferred once');
    assert.ok(Object.keys(message.result.texels).length > 0);
    const names = message.marks.filter((_, i) => i % 2 === 0);
    assert.deepEqual(names, ['atlas worker decoded', 'atlas worker read']);
    const bad = await runAtlasJob({ id: 5, job: 'nothing' });
    assert.equal(bad.message.ok, false);
    assert.match(bad.message.error.message, /no job "nothing"/);
  });
});

test('loadBakedAtlas: the same json, decals and bitmap through the worker, on the page, and when the worker fails to load', async () => {
  await withMemCanvas(async () => {
    const { image, json } = bakedAtlas(31);
    const want = extractDecalTexturesReference(canvasOfImage(image), json);
    const wantJson = structuredClone(json);
    fillFrameTexels(wantJson, () => ({ data: canvasOfImage(image).getContext('2d').getImageData(0, 0, image.width, image.height).data, x: 0, y: 0, width: image.width, height: image.height }));
    const results = [];
    for (const kind of ['worker', 'page', 'broken']) {
      const files = { '/baked/bigAtlas.json': JSON.stringify(json), '/baked/bigAtlas.png': memPng(image) };
      const raw = kind === 'page' ? null : fakeWorker({ loads: kind === 'worker' });
      const worker = raw ? new AssetWorker(raw) : null;
      const atlas = await withFetch(files, () => loadBakedAtlas({ json: '/baked/bigAtlas.json', png: '/baked/bigAtlas.png' }, { decals: true, sceneName: 'Test', worker }));
      assert.equal(hashJson(atlas.json), hashJson(wantJson), `${kind}: the json with the texels filled`);
      assert.deepEqual(decalHashes(atlas.decals), decalHashes(want), `${kind}: the decal textures`);
      assert.deepEqual(atlas.decals.frameNameToId, want.frameNameToId);
      assert.equal(hashBytes(atlas.imageBitmap.data), hashBytes(image.data), `${kind}: the PNG decoded for the renderer as it is`);
      assert.equal(atlas.mapsBitmap, null);
      const shown = await atlas.inspect();
      assert.equal(shown.width, image.width, 'the inspector gets a canvas on demand');
      if (raw) assert.equal(raw.posted, 1);
      results.push(atlas);
      worker?.close();
      if (raw) assert.equal(raw.terminated, true);
    }
  });
});

test('runJobOrHere: a job\'s own error is not retried on the page', async () => {
  await withMemCanvas(async () => {
    const worker = new AssetWorker(fakeWorker());
    let here = 0;
    await assert.rejects(runJobOrHere(worker, 'nothing', {}, [], () => here++), /no job/);
    assert.equal(here, 0);
    assert.equal(await runJobOrHere(null, 'nothing', {}, [], () => 'page'), 'page');
  });
});

test('siblingAssetUrl: a file beside the atlas png, an absolute or rooted name as it is', () => {
  assert.equal(siblingAssetUrl('/demos/baked/bigAtlas.png?v=2', 'bigAtlas_maps.png'), '/demos/baked/bigAtlas_maps.png');
  assert.equal(siblingAssetUrl('/demos/baked/bigAtlas.png', '/x/maps.png'), '/x/maps.png');
  assert.equal(siblingAssetUrl('bigAtlas.png', 'https://cdn/x.png'), 'https://cdn/x.png');
  assert.equal(siblingAssetUrl('bigAtlas.png', 'maps.png'), 'maps.png');
});
