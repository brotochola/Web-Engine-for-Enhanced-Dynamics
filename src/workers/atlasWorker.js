// SST-5: the atlas worker, a short-lived module worker the page starts while a scene loads (src/core/assetWorkerClient.js)
// so the atlas's pixel work leaves the page's main thread. It answers one message a job:
//   { id, job, ...args } → { id, ok: true, result, marks } or { id, ok: false, error, marks }
// where `marks` are its SST-0 load marks (the page files them under the worker 'atlas'). Its imports stay few (no
// utils.js, no GameObject): a module worker evaluates its whole graph before its first message.

import { readAtlasPixels, decalTextureBuffers } from '../core/atlas/atlasFrames.js';
import { loadMark, takeLoadMarks } from '../util/loadMarks.js';

const makeCanvas = (w, h) => new OffscreenCanvas(w, h);

/**
 * The jobs, by name. Each takes the message and returns { result, transfer }.
 * @type {Record<string, (msg: object) => Promise<{ result: object, transfer: Transferable[] }>>}
 */
const JOBS = {
  /**
   * A baked atlas's pixels for the page (SST-5 step 4): its decal textures and the texels a bake from before H-EDGE
   * lacks, from its PNG, decoded here.
   * msg: { png: Blob, json: { frames, animations, meta }, decals: boolean }
   */
  async bakedPixels(msg) {
    const image = await createImageBitmap(msg.png);
    loadMark('atlas worker decoded');
    const read = readAtlasPixels(image, msg.json, { decals: msg.decals === true, makeCanvas });
    image.close();
    loadMark('atlas worker read');
    return { result: read, transfer: read.decals ? decalTextureBuffers(read.decals.textures) : [] };
  },
};

/** Run one job message: what the worker posts back, and what it transfers. */
export async function runAtlasJob(msg) {
  const job = JOBS[msg?.job];
  try {
    if (!job) throw new Error(`atlas worker: no job "${msg?.job}"`);
    const { result, transfer } = await job(msg);
    return { message: { id: msg.id, ok: true, result, marks: takeLoadMarks() }, transfer };
  } catch (error) {
    return {
      message: { id: msg?.id, ok: false, error: { message: error?.message ?? String(error), stack: error?.stack ?? '' }, marks: takeLoadMarks() },
      transfer: [],
    };
  }
}

// In a worker: answer each message. Node's tests import this module and call runAtlasJob themselves.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined') {
  loadMark('atlas worker modules');
  // Jobs posted while the module loaded wait in the worker's queue until this is set. A module that fails to load fires
  // the Worker's error event on the page instead, which then does the job itself.
  self.onmessage = async (e) => {
    const { message, transfer } = await runAtlasJob(e.data);
    self.postMessage(message, transfer);
  };
}
