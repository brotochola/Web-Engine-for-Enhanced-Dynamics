// SST-11: the tilemap worker, a short-lived module worker the page starts for each tilemap a scene declares
// (src/core/tileMapLoad.js), so a big Tiled JSON (Predator's is 1.5 MB, carScene's 16 MB) is parsed and its tile layers
// copied into their SharedArrayBuffer off the page's main thread. One job, the asset workers' protocol
// (src/core/assetWorkerClient.js):
//   { id, job: 'tilemap', bytes: ArrayBuffer, tilemapId, index, what, url }
//     → { id, ok: true, result: { sab, meta }, marks } or { id, ok: false, error, marks }

import { TileMap, tiledFromBytes } from '../core/tileMap.js';
import { loadMark, takeLoadMarks } from '../util/loadMarks.js';

/**
 * Parse a tilemap's JSON and lay its tile layers out (TileMap.buffersFromTiled).
 * @param {{ bytes: ArrayBuffer, tilemapId: string, index: number, what: string, url: string }} msg
 * @returns {{ sab: SharedArrayBuffer, meta: object }}
 */
export function tilemapJob(msg) {
  const tiled = tiledFromBytes(msg.bytes, msg.what, msg.url);
  loadMark('tilemap parsed');
  const out = TileMap.buffersFromTiled(tiled, msg.tilemapId, msg.index | 0);
  loadMark('tilemap laid out');
  return out;
}

/** Answer one message. */
export function runTilemapMessage(msg) {
  try {
    if (msg?.job !== 'tilemap') throw new Error(`tilemap worker: no job "${msg?.job}"`);
    return { id: msg.id, ok: true, result: tilemapJob(msg), marks: takeLoadMarks() };
  } catch (error) {
    return { id: msg?.id, ok: false, error: { message: error?.message ?? String(error), stack: error?.stack ?? '' }, marks: takeLoadMarks() };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined') {
  loadMark('tilemap worker modules');
  self.onmessage = (e) => self.postMessage(runTilemapMessage(e.data));
}
