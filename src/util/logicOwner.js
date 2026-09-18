/** Pin sentinel: slot % workerCount. */
export const LOGIC_WORKER_UNPINNED = -1;

/**
 * Clamp spawn pin. One worker or negative request → unpinned.
 * @param {number} requested
 * @param {number} total
 * @returns {number}
 */
export function resolveLogicWorker(requested, total) {
  const n = total | 0;
  const r = requested | 0;
  if (n <= 1 || r < 0) return LOGIC_WORKER_UNPINNED;
  return r % n;
}

/**
 * Which logic worker ticks this active-list slot.
 * @param {number} slot
 * @param {number} entityIndex
 * @param {number} total
 * @param {Int8Array} pins
 * @returns {number}
 */
export function logicOwner(slot, entityIndex, total, pins) {
  const pin = pins[entityIndex];
  if (pin >= 0) return pin;
  return slot % total;
}
