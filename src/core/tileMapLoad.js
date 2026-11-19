// SST-11: a scene's tilemaps loaded off the page's main thread. For each one, in parallel: its JSON fetched as bytes and
// its tileset fetched and decoded (createImageBitmap decodes off this thread), while a tilemap worker starts; the worker
// parses the JSON and lays the tile layers out in a SharedArrayBuffer (TileMap.buffersFromTiled), which is what every
// thread reads; the page then builds its TileMaps over those buffers (TileMap.initializeFromBuffers), as the workers do.
// Without a worker the page parses it itself: the same buffers.

import { fetchAssetRead, resolvedAssetUrl } from '../util/fetchAsset.js';
import { loadMark } from '../util/loadMarks.js';
import { TileMap, tiledFromBytes } from './tileMap.js';
import { runJobOrHere, startAssetWorker } from './assetWorkerClient.js';

/**
 * Load a scene's tilemaps (config assets.tilemaps) and initialize TileMap on this thread. A tilemap that fails to load is
 * logged and left out, as before; the others keep their ids in the order the scene declares them.
 * @param {Record<string, { json: string, png: string }> | null | undefined} tilemaps
 * @param {{ startWorker?: (script: string) => Promise<import('./assetWorkerClient.js').AssetWorker | null> }} [opts]
 * @returns {Promise<{ loaded: Record<string, { tilesetBitmap: ImageBitmap }>, marks: Array<string | number> }>} loaded: the
 *   scene's loadedTilemaps (the renderer gets the tilesets); marks: the workers' load marks, flat
 */
export async function loadTilemaps(tilemaps, { startWorker = (script) => startAssetWorker(script) } = {}) {
  const loaded = {};
  const marks = [];
  if (!tilemaps) return { loaded, marks };
  const entries = Object.entries(tilemaps);
  const results = await Promise.all(entries.map(async ([tilemapId, config], index) => {
    const worker = await startWorker('tilemapWorker');
    try {
      const what = `tilemap "${tilemapId}" JSON`;
      const [json, tileset] = await Promise.all([
        fetchAssetRead(config.json, what, (r) => r.arrayBuffer()),
        fetchAssetRead(config.png, `tilemap "${tilemapId}" tileset`, (r) => r.blob()),
      ]);
      loadMark('tilemap fetched');
      const bytes = json.body;
      const url = json.response.url || resolvedAssetUrl(config.json);
      const args = { bytes, tilemapId, index, what, url };
      const [built, tilesetBitmap] = await Promise.all([
        // The bytes go to the worker (transferred); a worker that then fails to load leaves the page to fetch them again.
        runJobOrHere(worker, 'tilemap', args, [bytes], async () => {
          const own = bytes.byteLength > 0 ? bytes : (await fetchAssetRead(config.json, what, (r) => r.arrayBuffer())).body;
          return TileMap.buffersFromTiled(tiledFromBytes(own, what, url), tilemapId, index);
        }),
        createImageBitmap(tileset.body),
      ]);
      return { tilemapId, built, tilesetBitmap };
    } catch (error) {
      console.error(`❌ Failed to load tilemap "${tilemapId}":`, error);
      return null;
    } finally {
      if (worker) {
        for (const m of worker.takeMarks()) marks.push(m);
        worker.release();
      }
    }
  }));
  const sabs = {};
  const metadata = {};
  let id = 0;
  for (const r of results) {
    if (r === null) continue;
    loaded[r.tilemapId] = { tilesetBitmap: r.tilesetBitmap };
    sabs[r.tilemapId] = r.built.sab;
    // Ids follow the declared order among the tilemaps that loaded.
    metadata[r.tilemapId] = { ...r.built.meta, id: id++ };
  }
  if (id > 0) TileMap.initializeFromBuffers({ sabs, metadata });
  loadMark('tilemaps built');
  return { loaded, marks };
}
