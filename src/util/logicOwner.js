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
