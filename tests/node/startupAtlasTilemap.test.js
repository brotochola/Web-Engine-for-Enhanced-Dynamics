// SST-11: a scene's tilemaps parsed and laid out off the page's main thread (src/workers/tilemapWorker.js): the same
// tile data (the SharedArrayBuffer's bytes) and metadata the page made before (TileMap.initializeFromLoaded's), through
// the worker, on the page, and when the worker fails to load; a tilemap that fails is left out as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TileMap } from '../../src/core/tileMap.js';
import { loadTilemaps } from '../../src/core/tileMapLoad.js';
import { AssetWorker } from '../../src/core/assetWorkerClient.js';
import { runTilemapMessage } from '../../src/workers/tilemapWorker.js';
import { hashBytes, rng, withFetch } from './startupAtlasFixtures.mjs';

/** TileMap.initializeFromLoaded as it was before SST-11 (the reference): the SABs and the metadata it made. */
function initializeFromLoadedReference(loadedTilemaps) {
  const sabs = {};
  const metadataMap = {};
  let count = 0;
  for (const [tilemapId, loaded] of Object.entries(loadedTilemaps)) {
    const tiledData = loaded.data;
    const mapWidth = tiledData.width;
    const mapHeight = tiledData.height;
    const tileWidth = tiledData.tilewidth;
    const tileHeight = tiledData.tileheight;
    const tilesets = (tiledData.tilesets || []).map((ts) => ({
      firstgid: ts.firstgid || 1, columns: ts.columns || 1, tileWidth: ts.tilewidth || tileWidth, tileHeight: ts.tileheight || tileHeight,
    }));
    const tileLayers = tiledData.layers.filter((l) => l.type === 'tilelayer' && l.data && l.data.length > 0);
    const tilesPerLayer = mapWidth * mapHeight;
    const sab = new SharedArrayBuffer(tileLayers.length * tilesPerLayer * 4);
    const id = count++;
    sabs[tilemapId] = sab;
    const layerMetas = [];
    tileLayers.forEach((layer, li) => {
      const view = new Int32Array(sab, li * tilesPerLayer * 4, tilesPerLayer);
      for (let i = 0; i < tilesPerLayer; i++) view[i] = layer.data[i];
      layerMetas.push({ name: layer.name, index: li, visible: layer.visible !== false, opacity: layer.opacity !== undefined ? layer.opacity : 1 });
    });
    metadataMap[tilemapId] = { id, name: tilemapId, mapWidth, mapHeight, tileWidth, tileHeight, layers: layerMetas, tilesets };
  }
  return { sabs, metadata: metadataMap };
}

/** A Tiled map: tile layers (one hidden, one half opaque, one empty), an object layer, flipped GIDs past 2^31. */
function tiledMap(seed, w = 23, h = 17) {
  const r = rng(seed);
  const layer = (name, extra = {}) => ({
    type: 'tilelayer',
    name,
    data: Array.from({ length: w * h }, () => {
      const gid = 1 + ((r() * 90) | 0);
      return r() < 0.1 ? gid + 0x80000000 : r() < 0.2 ? 0 : gid;
    }),
    ...extra,
  });
  return {
    width: w,
    height: h,
    tilewidth: 32,
    tileheight: 16,
    tilesets: [{ firstgid: 1, columns: 8, tilewidth: 32, tileheight: 16 }, { firstgid: 65 }],
    layers: [layer('ground'), { type: 'objectgroup', name: 'spawns', objects: [] }, layer('roofs', { visible: false, opacity: 0.5 }), { type: 'tilelayer', name: 'empty', data: [] }, layer('walls')],
  };
}

const summary = ({ sabs, metadata }) => ({
  bytes: Object.fromEntries(Object.entries(sabs).map(([k, sab]) => [k, hashBytes(new Uint8Array(sab))])),
  metadata: JSON.stringify(metadata),
});

test('buffersFromTiled and the worker\'s job lay a map out as initializeFromLoaded did', () => {
  for (const seed of [1, 2, 3]) {
    const data = tiledMap(seed);
    const want = summary(initializeFromLoadedReference({ city: { data } }));
    const page = TileMap.buffersFromTiled(data, 'city', 0);
    assert.deepEqual(summary({ sabs: { city: page.sab }, metadata: { city: page.meta } }), want, `seed ${seed}: the page`);
    const bytes = new TextEncoder().encode(JSON.stringify(data)).buffer;
    const answer = runTilemapMessage({ id: 9, job: 'tilemap', bytes, tilemapId: 'city', index: 0, what: 'tilemap "city" JSON', url: '/m.json' });
    assert.equal(answer.ok, true, answer.error?.message);
    assert.deepEqual(summary({ sabs: { city: answer.result.sab }, metadata: { city: answer.result.meta } }), want, `seed ${seed}: the worker`);
    assert.deepEqual(answer.marks.filter((_, i) => i % 2 === 0), ['tilemap parsed', 'tilemap laid out']);
  }
  const bad = runTilemapMessage({ id: 1, job: 'tilemap', bytes: new TextEncoder().encode('<!doctype html>').buffer, tilemapId: 'x', index: 0, what: 'tilemap "x" JSON', url: '/x.json' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.message, 'WeedJS: could not load tilemap "x" JSON /x.json: it is not JSON (it starts "<!doctype html>"), so the URL serves something else');
});

test('initializeFromLoaded still builds the TileMaps the page queries', () => {
  const data = tiledMap(5);
  TileMap.initializeFromLoaded({ city: { data } });
  const city = TileMap.get('city');
  assert.deepEqual(city.getLayerNames(), ['ground', 'roofs', 'walls']);
  assert.equal(city.walls.getTileIdAt(3, 2), data.layers[4].data[2 * 23 + 3] | 0);
  assert.equal(city.roofs.visible, false);
  assert.equal(TileMap.getSerializableData().metadata.city.id, 0);
  TileMap.reset();
});

/** A Worker running the tilemap worker module here, a turn later; transferred buffers are detached, as postMessage does. */
function fakeTilemapWorker({ loads = true } = {}) {
  const w = {
    onmessage: null,
    onerror: null,
    posted: 0,
    postMessage(msg, transfer = []) {
      w.posted++;
      const copy = structuredClone(msg, { transfer });
      setTimeout(() => {
        if (!loads) w.onerror?.({ message: 'module failed', preventDefault() {} });
        else w.onmessage?.({ data: runTilemapMessage(copy) });
      }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

test('loadTilemaps: the same TileMaps through the worker, on the page, and when the worker fails; a broken one left out', async () => {
  const maps = { city: tiledMap(7), park: tiledMap(8, 9, 30) };
  const files = {
    '/m/city.json': JSON.stringify(maps.city),
    '/m/park.json': JSON.stringify(maps.park),
    '/m/broken.json': '<!doctype html><p>Not here</p>',
    '/m/tiles.png': new Blob(['png']),
  };
  const want = summary(initializeFromLoadedReference({ city: { data: maps.city }, park: { data: maps.park } }));
  const savedBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (blob) => ({ fromBlob: await blob.text() });
  const savedError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    for (const kind of ['worker', 'page', 'broken']) {
      const workers = [];
      const startWorker = async () => {
        if (kind === 'page') return null;
        const raw = fakeTilemapWorker({ loads: kind === 'worker' });
        workers.push(raw);
        return new AssetWorker(raw);
      };
      errors.length = 0;
      const { loaded, marks } = await withFetch(files, () => loadTilemaps({
        city: { json: '/m/city.json', png: '/m/tiles.png' },
        broken: { json: '/m/broken.json', png: '/m/tiles.png' },
        park: { json: '/m/park.json', png: '/m/tiles.png' },
      }, { startWorker }));
      assert.deepEqual(Object.keys(loaded), ['city', 'park'], `${kind}: the broken one left out`);
      assert.deepEqual(loaded.city.tilesetBitmap, { fromBlob: 'png' });
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][1]?.message), /tilemap "broken" JSON .*it is not JSON/);
      const got = TileMap.getSerializableData();
      assert.deepEqual(summary(got), want, `${kind}: the tile data and metadata (ids in the declared order)`);
      assert.equal(TileMap.get('park').getLayer('ground').getTileIdAt(1, 1), maps.park.layers[0].data[1 * 9 + 1] | 0);
      if (kind === 'worker') {
        assert.ok(marks.includes('tilemap parsed'), 'the workers\' marks');
        assert.ok(workers.every((w) => w.terminated), 'each worker stopped when done');
      }
      if (kind === 'broken') assert.equal(workers.length, 3);
      TileMap.reset();
    }
  } finally {
    globalThis.createImageBitmap = savedBitmap;
    console.error = savedError;
  }
});
