// Phase 4 (WASM_HYPOTHESES "Design for the build"): with physics on, the render-queue memory and the spatial
// publish memory are a block of Box2D's memory, so a kernel can read physics state (Transform's pose lives in
// Box2D's heap), the render columns and the spatial grid in one memory. The main thread knows the block's size
// before any buffer exists (renderQueueBlockBytes, spatialBlockBytes), so it starts the physics worker first,
// with Box2D's memory grown by the block, asks the host to malloc it, and the shared buffers are then laid in
// it: the render-queue regions first, the spatial ones after them. Without physics the block is a shared memory of
// its own with the same layout (standaloneBlock), so the kernels that read both parts in one memory (the bullet tick,
// the visibility gather) run there too. With wasm.box2dBlock off, or when the block cannot be had, the memories stay
// separate, as before.

import { box2dMemoryPages } from '../box2d/box2dMemory.js';
import { renderQueueBlockBytes, spatialBlockBytes } from './sceneSharedBuffers.js';
import { NULL_GUARD_BYTES } from './wasmMemoryMap.js';

/** Box2D's module imports at most 32768 pages of 64 KB (2 GB). */
const BOX2D_MAX_PAGES = 32768;
/** Room for dlmalloc's chunk header and the 64-byte alignment of one large block. */
const BLOCK_SLACK_BYTES = 1 << 20;

/** The pages Box2D's memory grows by for a block of `bytes` (with dlmalloc's room for one large chunk). */
export function box2dBlockPages(bytes) {
  return Math.ceil((bytes + BLOCK_SLACK_BYTES) / 65536);
}

/**
 * The block this scene's regions need and the pages Box2D's memory then takes, or null when the scene keeps
 * separate memories. queueBytes: the render-queue part, from the block's start (64-aligned); spatialBytes: the
 * spatial part after it.
 * @returns {null | { bytes: number, pages: number, queueBytes: number, spatialBytes: number }}
 */
export function box2dBlockPlan(scene) {
  if (!scene._physicsEnabled || scene.config.wasm?.box2dBlock === false) return null;
  const queueBytes = (renderQueueBlockBytes(scene) + 63) & ~63;
  const box2dPages = box2dMemoryPages(scene.config.physics);
  const pagesFor = (bytes) => box2dPages + box2dBlockPages(bytes);
  // A spatial part that would take the block past the limit (many neighbours: a row and a candidate list of
  // maxNeighbors ids per entity) stays out of it, in a memory of its own or the JS path, and the render-queue
  // part keeps its place.
  let spatialBytes = spatialBlockBytes(scene);
  if (spatialBytes > 0 && pagesFor(queueBytes + spatialBytes) > BOX2D_MAX_PAGES) spatialBytes = 0;
  const bytes = queueBytes + spatialBytes;
  if (!(bytes > 0)) return null;
  const pages = pagesFor(bytes);
  return pages <= BOX2D_MAX_PAGES ? { bytes, pages, queueBytes, spatialBytes } : null;
}

/**
 * Without physics: the block as a shared memory of its own, laid out as box2dBlockPlan lays Box2D's (the render-queue
 * part, then the spatial part), after a null guard (a kernel reads offset 0 as a missing column). As scene.box2dBlock
 * keeps it, or null with physics on, with wasm.box2dBlock off, or when nothing goes in it or it cannot be made.
 * @returns {null | { memory: WebAssembly.Memory, byte: number, bytes: number, queueBytes: number, spatialByte: number,
 *   spatialBytes: number, standalone: true }}
 */
export function standaloneBlock(scene) {
  if (scene._physicsEnabled || scene.config.wasm?.box2dBlock === false) return null;
  const queueBytes = (renderQueueBlockBytes(scene) + 63) & ~63;
  const base = NULL_GUARD_BYTES;
  const pagesFor = (bytes) => Math.ceil((base + bytes) / 65536);
  let spatialBytes = spatialBlockBytes(scene);
  if (spatialBytes > 0 && pagesFor(queueBytes + spatialBytes) > BOX2D_MAX_PAGES) spatialBytes = 0;
  const bytes = queueBytes + spatialBytes;
  if (!(bytes > 0) || pagesFor(bytes) > BOX2D_MAX_PAGES) return null;
  let memory;
  try {
    memory = new WebAssembly.Memory({ initial: pagesFor(bytes), maximum: pagesFor(bytes), shared: true });
  } catch {
    return null;
  }
  return { memory, byte: base, bytes, queueBytes, spatialByte: base + queueBytes, spatialBytes, standalone: true };
}

/** The reserved block with its two parts' places (box2dBlockPlan), as scene.box2dBlock keeps it. */
export function box2dBlockParts(block, plan) {
  if (!block) return null;
  return {
    ...block,
    queueBytes: plan.queueBytes,
    spatialByte: block.byte + plan.queueBytes,
    spatialBytes: plan.spatialBytes,
  };
}

/**
 * Ask a started physics worker for the block. Resolves to { memory, byte, bytes }, or null when the host has
 * none to give (or never answers: a worker that failed to start shows its own error).
 */
export function requestBox2dBlock(worker, bytes, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (block) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      clearTimeout(timer);
      resolve(block);
    };
    const onMessage = (e) => {
      if (e.data?.msg !== 'engineBlock') return;
      done(e.data.memory ? { memory: e.data.memory, byte: e.data.byte | 0, bytes: e.data.bytes | 0 } : null);
    };
    const onError = () => done(null);
    timer = setTimeout(() => done(null), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ msg: 'reserveEngineBlock', bytes });
  });
}
