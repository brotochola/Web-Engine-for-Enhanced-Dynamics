// SST-5: the atlas worker, a short-lived module worker the page starts while a scene loads (src/core/assetWorkerClient.js)
// so the atlas's pixel work leaves the page's main thread. It answers one message a job:
//   { id, job, ...args } → { id, ok: true, result, marks, background } or { id, ok: false, error, marks }
// where `marks` are its SST-0 load marks (the page files them under the worker 'atlas'), and `background` says it still
// works for that job after answering (SST-6: the atlas cache's write), then posts { id, backgroundDone: true, marks }.
// Its imports stay few (no utils.js, no GameObject): a module worker evaluates its whole graph before its first message.

import { decalTextureBuffers } from '../core/atlas/atlasFrames.js';
import { completeBakedPixels } from '../core/atlas/bakedPixels.js';
import { packAtlas } from '../core/atlas/atlasPackJob.js';
import { loadMark, takeLoadMarks } from '../util/loadMarks.js';

const makeCanvas = (w, h) => new OffscreenCanvas(w, h);

/**
 * The jobs, by name. Each takes the message and returns { result, transfer, background? }.
 * @type {Record<string, (msg: object) => Promise<{ result: object, transfer: Transferable[], background?: Promise<void> | null }>>}
 */
const JOBS = {
  /**
   * A baked atlas's pixels for the page (SST-5 step 4), from its PNG, decoded here: the built-ins it lacks drawn in (then
   * the completed atlas is the renderer's bitmap), its decal textures, and the texels a bake from before H-EDGE lacks.
   * msg: { png: Blob, json: { frames, animations, meta }, decals: boolean,
   *   builtins: Array<{ name, image: ImageBitmap, unshaded }>, padding: number }
   */
  async bakedPixels(msg) {
    const image = await createImageBitmap(msg.png);
    loadMark('atlas worker decoded');
    const builtins = msg.builtins || [];
    const read = await completeBakedPixels({
      image, json: msg.json, decals: msg.decals === true, builtins, padding: msg.padding, makeCanvas,
    });
    image.close();
    for (const b of builtins) b.image.close?.();
    loadMark('atlas worker read');
    const transfer = read.decals ? decalTextureBuffers(read.decals.textures) : [];
    if (read.bitmap) transfer.push(read.bitmap);
    return { result: read, transfer };
  },

  /**
   * A packed atlas: from the atlas cache (SST-6), else every source fetched and decoded here, read back, packed and
   * drawn (SST-5 steps 1-2, atlasBuild.js), the decal textures read from it, the renderer's bitmaps made; a miss writes
   * its cache entry after answering.
   * msg: { assets (URLs absolute), options (buildBigAtlas's, sceneHeightScaleY a number),
   *   builtins: Array<{ name, image: ImageBitmap, unshaded, afterSort }>, cache: { enabled, bundle } | null }
   */
  async pack(msg) {
    const { result, background } = await packAtlas({
      assets: msg.assets, options: msg.options, builtins: msg.builtins || [], cache: msg.cache || null, makeCanvas,
    });
    for (const b of msg.builtins || []) b.image.close?.();
    for (const sheet of Object.values(msg.assets?.spritesheets || {})) sheet?.img?.close?.();
    loadMark('atlas worker bitmaps');
    const transfer = [result.imageBitmap];
    if (result.mapsBitmap) transfer.push(result.mapsBitmap);
    if (result.decals) transfer.push(...decalTextureBuffers(result.decals.textures));
    return { result, transfer, background };
  },
};

/**
 * Run one job message: what the worker posts back, what it transfers, and the work it goes on with after (null when
 * none).
 * @returns {Promise<{ message: object, transfer: Transferable[], background: Promise<void> | null }>}
 */
export async function runAtlasJob(msg) {
  const job = JOBS[msg?.job];
  try {
    if (!job) throw new Error(`atlas worker: no job "${msg?.job}"`);
    const { result, transfer, background = null } = await job(msg);
    return { message: { id: msg.id, ok: true, result, marks: takeLoadMarks(), background: background !== null }, transfer, background };
  } catch (error) {
    return {
      message: { id: msg?.id, ok: false, error: { message: error?.message ?? String(error), stack: error?.stack ?? '' }, marks: takeLoadMarks() },
      transfer: [],
      background: null,
    };
  }
}

// In a worker: answer each message. Node's tests import this module and call runAtlasJob themselves.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined') {
  loadMark('atlas worker modules');
  // Jobs posted while the module loaded wait in the worker's queue until this is set. A module that fails to load fires
  // the Worker's error event on the page instead, which then does the job itself.
  self.onmessage = async (e) => {
    const { message, transfer, background } = await runAtlasJob(e.data);
    self.postMessage(message, transfer);
    if (background) {
      await background;
      self.postMessage({ id: message.id, backgroundDone: true, marks: takeLoadMarks() });
    }
  };
}
