/**
 * Which logic worker must run an entity’s tick / callbacks / onSpawned.
 *
 * `forceProcessOnLogicWorker` is a worker index (0 = logic0), not a boolean.
 * Worker 0 is a real worker, so “do not force” cannot be 0.
 */

/** Do not force this entity onto one worker: use stride `activeListSlot % logicWorkerCount`. */
export const FORCE_PROCESS_ON_LOGIC_WORKER_NONE = -1;

/**
 * Clamp a spawn request. One worker or a negative request → not forced.
 * @param {number} requestedWorkerIndex
 * @param {number} logicWorkerCount
 * @returns {number}
 */
export function resolveForceProcessOnLogicWorker(requestedWorkerIndex, logicWorkerCount) {
  const n = logicWorkerCount | 0;
  const r = requestedWorkerIndex | 0;
  if (n <= 1 || r < 0) return FORCE_PROCESS_ON_LOGIC_WORKER_NONE;
  return r % n;
}

/**
 * Which logic worker should tick this active-list slot.
 * If this entity has a forced worker, that worker ticks it; otherwise
 * worker `activeListSlot % logicWorkerCount` ticks it.
 *
 * @param {number} activeListSlot
 * @param {number} entityIndex
 * @param {number} logicWorkerCount
 * @param {Int16Array} forceProcessOnLogicWorker
 * @returns {number}
 */
export function logicWorkerThatShouldTick(
  activeListSlot,
  entityIndex,
  logicWorkerCount,
  forceProcessOnLogicWorker,
) {
  const forced = forceProcessOnLogicWorker[entityIndex];
  if (forced >= 0) return forced;
  return activeListSlot % logicWorkerCount;
}

/**
 * Contiguous [start, end) of an active list for this worker.
 * Covers 0..count-1 exactly once across workers. W=1 is the whole list.
 * @param {number} count
 * @param {number} workerIndex
 * @param {number} workerCount
 * @returns {{ start: number, end: number }}
 */
export function logicBlockRange(count, workerIndex, workerCount) {
  const n = count | 0;
  const w = workerCount | 0;
  const i = workerIndex | 0;
  if (w <= 1 || n <= 0) return { start: 0, end: n };
  const span = (n / w) | 0;
  const rem = n - span * w;
  const start = i * span + (i < rem ? i : rem);
  const len = span + (i < rem ? 1 : 0);
  return { start, end: start + len };
}

/**
 * Frame phase for tickInterval buckets.
 * Matches the countdown: next starts at (id % interval) + 1, first frame is 1,
 * tick when the pre-decrement hits 0, then reset to interval.
 * @param {number} entityIndex
 * @param {number} interval
 * @returns {number}
 */
export function tickBucketPhase(entityIndex, interval) {
  const n = interval | 0;
  if (n <= 1) return 0;
  return ((entityIndex % n) + 1) % n;
}
