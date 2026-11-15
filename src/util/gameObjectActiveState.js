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

/**
 * E-344: take the indices `sorted[0..n)` (ascending, repeats allowed) out of a sorted [count, idx...] list in one
 * pass. Entries before the first removed one stay where they are; each run between two removed entries moves once
 * (native memmove), so a batch of D despawns costs one pass instead of D shifts of the list's tail. Writes list[0]
 * last, as a single removal does.
 * @param {Uint16Array|Uint32Array|Int32Array|null} list
 * @param {ArrayLike<number>} sorted
 * @param {number} n
 */
export function removeSortedFromActiveList(list, sorted, n) {
  if (!list || n <= 0) return;
  const count = list[0];
  if (count === 0) return;
  let write = -1;
  let from = 1;
  let prev = -1;
  for (let j = 0; j < n; j++) {
    const value = sorted[j];
    if (value === prev) continue;
    prev = value;
    let lo = from;
    let hi = count;
    let pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = list[mid];
      if (v === value) {
        pos = mid;
        break;
      }
      if (v < value) lo = mid + 1;
      else hi = mid - 1;
    }
    if (pos < 0) continue;
    if (write < 0) write = pos;
    else if (pos > from) {
      list.copyWithin(write, from, pos);
      write += pos - from;
    }
    from = pos + 1;
  }
  if (write < 0) return;
  if (from <= count) {
    list.copyWithin(write, from, count + 1);
    write += count + 1 - from;
  }
  list[0] = write - 1;
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
    scratch = new (list.constructor)(1 + oldCount + n);
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
