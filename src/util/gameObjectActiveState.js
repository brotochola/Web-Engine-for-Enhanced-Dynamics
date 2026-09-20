import { binarySearchFind, binarySearchInsertPoint } from './utils.js';

export function addToActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  const insertPos = binarySearchInsertPoint(activeEntitiesData, entityIndex, count);
  if (insertPos <= count && activeEntitiesData[insertPos] === entityIndex) return;

  // Shift [insertPos..count] right by one (native memmove - these lists hold
  // thousands of entries and this runs per spawned entity)
  activeEntitiesData.copyWithin(insertPos + 1, insertPos, count + 1);

  activeEntitiesData[insertPos] = entityIndex;
  activeEntitiesData[0] = count + 1;
}

export function removeFromActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  if (count === 0) return;

  const pos = binarySearchFind(activeEntitiesData, entityIndex, count);
  if (pos === -1) return;

  // Shift [pos+1..count] left by one (native memmove)
  activeEntitiesData.copyWithin(pos, pos + 1, count + 1);
  activeEntitiesData[0] = count - 1;
}

export function batchRemoveFromActiveEntities(activeEntitiesData, indicesToRemove) {
  if (!activeEntitiesData || indicesToRemove.size === 0) return;

  const count = activeEntitiesData[0];
  if (count === 0) return;

  let writePos = 1;
  for (let readPos = 1; readPos <= count; readPos++) {
    const entityIndex = activeEntitiesData[readPos];
    if (!indicesToRemove.has(entityIndex)) {
      activeEntitiesData[writePos++] = entityIndex;
    }
  }
  activeEntitiesData[0] = writePos - 1;
}

export function getGameObjectWorkerContext() {
  if (typeof self === 'undefined') return null;
  return (
    self.logicWorker ||
    self.particleWorker ||
    self.pixiRenderer ||
    self.physicsWorker ||
    self.spatialWorker ||
    null
  );
}

export function bumpActiveQueryVersion(worker) {
  if (worker?.queryVersionData) {
    Atomics.add(worker.queryVersionData, 0, 1);
  }
}

export function removeFromTypeActiveList(typeList, entityIndex) {
  if (!typeList) return;

  const count = typeList[0];
  if (count === 0) return;

  const pos = binarySearchFind(typeList, entityIndex, count);
  if (pos === -1) return;

  // Shift [pos+1..count] left by one (native memmove)
  typeList.copyWithin(pos, pos + 1, count + 1);
  typeList[0] = count - 1;
}

export function clearTypeActiveList(typeList) {
  if (typeList) {
    typeList[0] = 0;
  }
}

export function addToTypeActiveList(typeList, entityIndex) {
  if (!typeList) return;

  const count = typeList[0];
  const insertPos = binarySearchInsertPoint(typeList, entityIndex, count);
  if (insertPos <= count && typeList[insertPos] === entityIndex) return;

  // Shift [insertPos..count] right by one (native memmove)
  typeList.copyWithin(insertPos + 1, insertPos, count + 1);

  typeList[insertPos] = entityIndex;
  typeList[0] = count + 1;
}

/**
 * Merge sorted incoming indices into a [count, idx...] list.
 * Writes `list[0]` last so concurrent readers never see a short live count.
 * `scratch` is required when the dest already has entries (no alloc here).
 * @param {Uint16Array|Int32Array} list
 * @param {ArrayLike<number>} incoming
 * @param {number} n
 * @param {Uint16Array|Int32Array} [scratch]
 */
export function mergeSortedIntoActiveList(list, incoming, n, scratch) {
  if (!list || n <= 0) return;
  const oldCount = list[0];
  if (oldCount === 0) {
    for (let i = 0; i < n; i++) list[i + 1] = incoming[i];
    list[0] = n;
    return;
  }
  if (!scratch) {
    // ponytail: tests / unexpected call; logic0 always passes init scratch
    scratch = new Uint16Array(1 + oldCount + n);
  }
  let i = 1;
  let j = 0;
  let w = 1;
  while (i <= oldCount && j < n) {
    const a = list[i];
    const b = incoming[j];
    if (a < b) {
      scratch[w++] = a;
      i++;
    } else if (b < a) {
      scratch[w++] = b;
      j++;
    } else {
      scratch[w++] = a;
      i++;
      j++;
    }
  }
  while (i <= oldCount) scratch[w++] = list[i++];
  while (j < n) scratch[w++] = incoming[j++];
  const newCount = w - 1;
  for (let k = 1; k <= newCount; k++) list[k] = scratch[k];
  list[0] = newCount;
}
