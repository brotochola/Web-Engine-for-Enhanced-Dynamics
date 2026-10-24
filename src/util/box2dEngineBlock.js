// Phase 4 (WASM_HYPOTHESES "Design for the build"): with physics on, the render-queue memory and the spatial
// publish memory are a block of Box2D's memory, so a kernel can read physics state (Transform's pose lives in
// Box2D's heap), the render columns and the spatial grid in one memory. The main thread knows the block's size
// before any buffer exists (renderQueueBlockBytes, spatialBlockBytes), so it starts the physics worker first,
// with Box2D's memory grown by the block, asks the host to malloc it, and the shared buffers are then laid in
// it: the render-queue regions first, the spatial ones after them. Without physics, with wasm.box2dBlock off, or
// when the block cannot be had, the memories stay separate, as before.

import { box2dMemoryPages } from '../box2d/box2dMemory.js';
import { renderQueueBlockBytes, spatialBlockBytes } from './sceneSharedBuffers.js';

/** Box2D's module imports at most 32768 pages of 64 KB (2 GB). */
const BOX2D_MAX_PAGES = 32768;
/** Room for dlmalloc's chunk header and the 64-byte alignment of one large block. */
const BLOCK_SLACK_BYTES = 1 << 20;

/**
 * The block this scene's regions need and the pages Box2D's memory then takes, or null when the scene keeps
 * separate memories. queueBytes: the render-queue part, from the block's start (64-aligned); spatialBytes: the
 * spatial part after it.
 * @returns {null | { bytes: number, pages: number, queueBytes: number, spatialBytes: number }}
 */
export function box2dBlockPlan(scene) {
  if (!scene._physicsEnabled || scene.config.wasm?.box2dBlock === false) return null;
  const queueBytes = (renderQueueBlockBytes(scene) + 63) & ~63;
  const spatialBytes = spatialBlockBytes(scene);
  const bytes = queueBytes + spatialBytes;
  if (!(bytes > 0)) return null;
  const pages = box2dMemoryPages(scene.config.physics) + Math.ceil((bytes + BLOCK_SLACK_BYTES) / 65536);
  return pages <= BOX2D_MAX_PAGES ? { bytes, pages, queueBytes, spatialBytes } : null;
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
