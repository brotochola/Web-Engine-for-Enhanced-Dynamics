import { binarySearchFind, binarySearchInsertPoint } from './utils.js';

export function addToActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  const insertPos = binarySearchInsertPoint(activeEntitiesData, entityIndex, count);
  if (insertPos <= count && activeEntitiesData[insertPos] === entityIndex) return;

  for (let i = count; i >= insertPos; i--) {
    activeEntitiesData[i + 1] = activeEntitiesData[i];
  }

  activeEntitiesData[insertPos] = entityIndex;
  activeEntitiesData[0] = count + 1;
}

export function removeFromActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  if (count === 0) return;

  const pos = binarySearchFind(activeEntitiesData, entityIndex, count);
  if (pos === -1) return;

  for (let i = pos; i < count; i++) {
    activeEntitiesData[i] = activeEntitiesData[i + 1];
  }
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

  for (let i = pos; i < count; i++) {
    typeList[i] = typeList[i + 1];
  }
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

  for (let i = count; i >= insertPos; i--) {
    typeList[i + 1] = typeList[i];
  }

  typeList[insertPos] = entityIndex;
  typeList[0] = count + 1;
}
